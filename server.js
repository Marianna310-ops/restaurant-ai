require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;

// ─── Lazy init so missing env vars don't crash on startup ─────────────────────
let _twilioClient = null;
const getTwilioClient = () => {
  if (!_twilioClient) {
    if (!process.env.TWILIO_ACCOUNT_SID) throw new Error("TWILIO_ACCOUNT_SID is not set in environment variables");
    if (!process.env.TWILIO_AUTH_TOKEN)  throw new Error("TWILIO_AUTH_TOKEN is not set in environment variables");
    _twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _twilioClient;
};

let _claude = null;
const getClaude = () => {
  if (!_claude) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _claude;
};

// ─── Log env var status on startup ────────────────────────────────────────────
console.log("=== ENV CHECK ===");
console.log("TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID ? "✅ SET" : "❌ MISSING");
console.log("TWILIO_AUTH_TOKEN:", process.env.TWILIO_AUTH_TOKEN ? "✅ SET" : "❌ MISSING");
console.log("TWILIO_PHONE_NUMBER:", process.env.TWILIO_PHONE_NUMBER ? "✅ SET" : "❌ MISSING");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("RESTAURANT_NAME:", process.env.RESTAURANT_NAME ? "✅ SET" : "⚠️ using default");
console.log("STAFF_PHONE:", process.env.STAFF_PHONE ? "✅ SET" : "⚠️ not set");
console.log("=================");

// ─── In-memory conversation state (keyed by Twilio CallSid) ───────────────────
const sessions = new Map();

// ─── Restaurant config ────────────────────────────────────────────────────────
const RESTAURANT = {
  name: process.env.RESTAURANT_NAME || "Marianna Ristorante",
  yelpAlias: process.env.RESTAURANT_YELP_ALIAS || "marianna-ristorante-seattle",
  hours: "Tuesday through Sunday, 5 PM to 10 PM. We are closed on Mondays.",
  phone: process.env.STAFF_PHONE || null, // forwarding number for live staff
};

// ─── Claude AI System Prompt ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a warm, friendly host named Sofia at ${RESTAURANT.name}, 
an authentic Italian restaurant. Our hours are ${RESTAURANT.hours}.

Your job is to help callers with:
- Making reservations
- Answering questions about hours, location, and the menu
- General inquiries

Always respond in JSON with this exact format:
{
  "intent": "reservation" | "availability_check" | "hours" | "menu" | "other" | "complete" | "transfer",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM (24hr) or null",
  "party_size": number or null,
  "guest_name": "string or null",
  "guest_phone": "string or null",
  "missing_fields": ["list of fields still needed for reservation"],
  "say": "what Sofia should say to the caller",
  "booking_ready": true or false
}

Rules:
- For a reservation you MUST collect: date, time, party_size, guest_name
- If any reservation field is missing, set booking_ready to false and ask for the missing ones naturally
- Keep responses warm, concise, and conversational (this will be read aloud)
- If the caller is rude or the issue is complex, set intent to "transfer"
- When a booking is confirmed say "booking_ready": true
- Dates should always be in YYYY-MM-DD format. Today is ${new Date().toISOString().split("T")[0]}
- Times should be in 24-hour HH:MM format`;

// ─── Helper: call Claude ──────────────────────────────────────────────────────
async function askClaude(conversationHistory) {
  const response = await getClaude().messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: conversationHistory,
  });

  const raw = response.content[0].text.trim();

  // Strip markdown code fences if present
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Helper: check Yelp availability ─────────────────────────────────────────
async function checkYelpAvailability({ date, time, party_size }) {
  try {
    const res = await axios.get(
      `https://api.yelp.com/v3/businesses/${RESTAURANT.yelpAlias}/reservations/availability`,
      {
        headers: { Authorization: `Bearer ${process.env.YELP_API_KEY}` },
        params: { date, time, covers: party_size },
      }
    );
    return { available: res.data.available === true, slots: res.data.slots || [] };
  } catch (err) {
    console.error("Yelp availability error:", err.response?.data || err.message);
    // Graceful fallback — assume available so call doesn't fail silently
    return { available: true, slots: [] };
  }
}

// ─── Helper: create Yelp reservation ─────────────────────────────────────────
async function createYelpReservation({ date, time, party_size, guest_name, guest_phone }) {
  try {
    const res = await axios.post(
      `https://api.yelp.com/v3/businesses/${RESTAURANT.yelpAlias}/reservations`,
      {
        date,
        time,
        covers: party_size,
        name: guest_name,
        phone: guest_phone,
      },
      { headers: { Authorization: `Bearer ${process.env.YELP_API_KEY}` } }
    );
    return { success: true, confirmation_id: res.data.confirmation_id };
  } catch (err) {
    console.error("Yelp booking error:", err.response?.data || err.message);
    return { success: false };
  }
}

// ─── Helper: send SMS confirmation ───────────────────────────────────────────
async function sendConfirmationSMS({ to, guest_name, date, time, party_size, confirmation_id }) {
  if (!to || !process.env.TWILIO_PHONE_NUMBER) return;

  const friendlyDate = new Date(`${date}T${time}`).toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  await getTwilioClient().messages.create({
    body:
      `✅ Reservation confirmed at ${RESTAURANT.name}!\n` +
      `👤 ${guest_name}\n` +
      `📅 ${friendlyDate}\n` +
      `👥 Party of ${party_size}\n` +
      `🔖 Confirmation #${confirmation_id}\n\n` +
      `Reply CANCEL to cancel. See you soon! 🍝`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });
}

// ─── Helper: build TwiML response ────────────────────────────────────────────
function buildTwiML(sayText, { gather = true, end = false, transfer = false } = {}) {
  const twiml = new VoiceResponse();

  if (transfer && RESTAURANT.phone) {
    twiml.say({ voice: "Polly.Joanna-Neural" }, sayText);
    twiml.dial(RESTAURANT.phone);
    return twiml.toString();
  }

  if (end) {
    twiml.say({ voice: "Polly.Joanna-Neural" }, sayText);
    twiml.hangup();
    return twiml.toString();
  }

  if (gather) {
    const g = twiml.gather({
      input: "speech",
      action: "/process-speech",
      speechTimeout: "auto",
      language: "en-US",
      enhanced: "true",
    });
    g.say({ voice: "Polly.Joanna-Neural" }, sayText);

    // If caller doesn't respond, prompt again
    twiml.redirect("/no-input");
  } else {
    twiml.say({ voice: "Polly.Joanna-Neural" }, sayText);
  }

  return twiml.toString();
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", restaurant: RESTAURANT.name });
});

// ─── Incoming call ────────────────────────────────────────────────────────────
app.post("/incoming-call", (req, res) => {
  const callSid = req.body.CallSid;

  // Start fresh session for this call
  sessions.set(callSid, { history: [], callerPhone: req.body.From });

  const greeting = `Buonasera! Thank you for calling ${RESTAURANT.name}. I'm Sofia, your virtual host. How can I help you today?`;

  res.type("text/xml");
  res.send(buildTwiML(greeting));
});

// ─── Process caller speech ────────────────────────────────────────────────────
app.post("/process-speech", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult;

  const session = sessions.get(callSid) || { history: [], callerPhone: req.body.From };

  // Append caller's message to history
  session.history.push({ role: "user", content: speech });

  let twimlResponse;

  try {
    const ai = await askClaude(session.history);

    // Store AI response in history
    session.history.push({ role: "assistant", content: JSON.stringify(ai) });
    sessions.set(callSid, session);

    // ── Transfer to staff ──
    if (ai.intent === "transfer") {
      twimlResponse = buildTwiML(ai.say, { transfer: true });

    // ── Ready to book ──
    } else if (ai.booking_ready && ai.date && ai.time && ai.party_size && ai.guest_name) {
      const { available } = await checkYelpAvailability(ai);

      if (!available) {
        // No availability — ask Claude to suggest alternatives
        session.history.push({
          role: "user",
          content: "The requested time is not available. Please apologize and ask for an alternative time or date.",
        });
        const retry = await askClaude(session.history);
        session.history.push({ role: "assistant", content: JSON.stringify(retry) });
        sessions.set(callSid, session);
        twimlResponse = buildTwiML(retry.say);
      } else {
        // Book it!
        const booking = await createYelpReservation({
          ...ai,
          guest_phone: session.callerPhone,
        });

        if (booking.success) {
          await sendConfirmationSMS({
            to: session.callerPhone,
            guest_name: ai.guest_name,
            date: ai.date,
            time: ai.time,
            party_size: ai.party_size,
            confirmation_id: booking.confirmation_id,
          });

          const farewell =
            `${ai.say} Your confirmation number is ${booking.confirmation_id}. ` +
            `We've also sent a text confirmation to your phone. Arrivederci!`;

          sessions.delete(callSid);
          twimlResponse = buildTwiML(farewell, { end: true });
        } else {
          twimlResponse = buildTwiML(
            "I'm sorry, I had trouble completing that booking. Let me transfer you to our staff.",
            { transfer: true }
          );
        }
      }

    // ── Continue conversation ──
    } else {
      twimlResponse = buildTwiML(ai.say);
    }

  } catch (err) {
    console.error("AI processing error:", err);
    twimlResponse = buildTwiML(
      "I'm so sorry, I'm having a little trouble right now. Let me get someone to help you.",
      { transfer: true }
    );
  }

  res.type("text/xml");
  res.send(twimlResponse);
});

// ─── No input fallback ────────────────────────────────────────────────────────
app.post("/no-input", (req, res) => {
  const twiml = new VoiceResponse();
  const g = twiml.gather({
    input: "speech",
    action: "/process-speech",
    speechTimeout: "auto",
  });
  g.say(
    { voice: "Polly.Joanna-Neural" },
    "I'm still here! Are you still there? How can I help you?"
  );
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─── SMS cancel handler ───────────────────────────────────────────────────────
app.post("/incoming-sms", async (req, res) => {
  const body = req.body.Body?.trim().toUpperCase();
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  if (body === "CANCEL") {
    twiml.message(
      `We've received your cancellation request. Please call us at ${process.env.TWILIO_PHONE_NUMBER} to confirm. We hope to see you another time!`
    );
  } else {
    twiml.message(
      `Thanks for texting ${RESTAURANT.name}! For reservations, please call us. Grazie! 🍝`
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🍝 ${RESTAURANT.name} AI Assistant running on port ${PORT}`);
});
