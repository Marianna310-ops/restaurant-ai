require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;

// ─── Lazy init clients (prevents crash if env vars load late) ─────────────────
let _twilioClient = null;
const getTwilioClient = () => {
  if (!_twilioClient) {
    _twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _twilioClient;
};

let _claude = null;
const getClaude = () => {
  if (!_claude) {
    _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _claude;
};

// ─── Startup log ──────────────────────────────────────────────────────────────
console.log("=== ENV CHECK ===");
console.log("TWILIO_ACCOUNT_SID :", process.env.TWILIO_ACCOUNT_SID  ? "SET" : "MISSING");
console.log("TWILIO_AUTH_TOKEN  :", process.env.TWILIO_AUTH_TOKEN   ? "SET" : "MISSING");
console.log("TWILIO_PHONE_NUMBER:", process.env.TWILIO_PHONE_NUMBER ? "SET" : "MISSING");
console.log("ANTHROPIC_API_KEY  :", process.env.ANTHROPIC_API_KEY   ? "SET" : "MISSING");
console.log("PORT               :", process.env.PORT || "3000 (default)");
console.log("=================");

// ─── Restaurant config ────────────────────────────────────────────────────────
const RESTAURANT = {
  name:      process.env.RESTAURANT_NAME       || "Marianna Ristorante",
  yelpAlias: process.env.RESTAURANT_YELP_ALIAS || "marianna-ristorante-seattle",
  hours:     "Tuesday through Sunday, 5 PM to 10 PM. We are closed on Mondays.",
  phone:     process.env.STAFF_PHONE           || null,
};

// ─── Claude system prompt ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Sofia, a warm host at ${RESTAURANT.name}, an Italian restaurant.
Hours: ${RESTAURANT.hours}. Today is ${new Date().toISOString().split("T")[0]}.

Help callers make reservations or answer questions. Always reply ONLY with this JSON:
{
  "intent": "reservation|hours|menu|other|transfer",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "party_size": number or null,
  "guest_name": "string or null",
  "say": "what to say out loud — warm, short, conversational",
  "booking_ready": true or false
}
For reservations collect: date, time, party_size, guest_name. Set booking_ready true only when all 4 are known.`;

// ─── In-memory sessions ───────────────────────────────────────────────────────
const sessions = new Map();

// ─── Ask Claude ───────────────────────────────────────────────────────────────
async function askClaude(history) {
  const res = await getClaude().messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 500,
    system:     SYSTEM_PROMPT,
    messages:   history,
  });
  const clean = res.content[0].text.trim().replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Yelp: check availability ─────────────────────────────────────────────────
async function checkYelpAvailability({ date, time, party_size }) {
  try {
    const res = await axios.get(
      `https://api.yelp.com/v3/businesses/${RESTAURANT.yelpAlias}/reservations/availability`,
      { headers: { Authorization: `Bearer ${process.env.YELP_API_KEY}` },
        params: { date, time, covers: party_size } }
    );
    return { available: res.data.available === true };
  } catch {
    return { available: true }; // graceful fallback
  }
}

// ─── Yelp: create reservation ─────────────────────────────────────────────────
async function createYelpReservation({ date, time, party_size, guest_name, guest_phone }) {
  try {
    const res = await axios.post(
      `https://api.yelp.com/v3/businesses/${RESTAURANT.yelpAlias}/reservations`,
      { date, time, covers: party_size, name: guest_name, phone: guest_phone },
      { headers: { Authorization: `Bearer ${process.env.YELP_API_KEY}` } }
    );
    return { success: true, confirmation_id: res.data.confirmation_id };
  } catch {
    return { success: false };
  }
}

// ─── Send SMS confirmation ────────────────────────────────────────────────────
async function sendSMS({ to, guest_name, date, time, party_size, confirmation_id }) {
  if (!to || !process.env.TWILIO_PHONE_NUMBER) return;
  await getTwilioClient().messages.create({
    body: `Reservation confirmed at ${RESTAURANT.name}!\n${guest_name} | ${date} at ${time} | Party of ${party_size}\nConfirmation: ${confirmation_id}`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });
}

// ─── Build TwiML ──────────────────────────────────────────────────────────────
function speak(text, { end = false, transfer = false } = {}) {
  const twiml = new VoiceResponse();
  if (transfer && RESTAURANT.phone) {
    twiml.say({ voice: "Polly.Joanna-Neural" }, text);
    twiml.dial(RESTAURANT.phone);
    return twiml.toString();
  }
  if (end) {
    twiml.say({ voice: "Polly.Joanna-Neural" }, text);
    twiml.hangup();
    return twiml.toString();
  }
  const g = twiml.gather({ input: "speech", action: "/process-speech", speechTimeout: "auto", language: "en-US" });
  g.say({ voice: "Polly.Joanna-Neural" }, text);
  twiml.redirect("/no-input");
  return twiml.toString();
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Health check — Railway uses this to confirm app is running
app.get("/", (_req, res) => res.json({ status: "ok", restaurant: RESTAURANT.name }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Incoming call
app.post("/incoming-call", (req, res) => {
  const callSid = req.body.CallSid;
  sessions.set(callSid, { history: [], callerPhone: req.body.From });
  const greeting = `Buonasera! Thank you for calling ${RESTAURANT.name}. I'm Sofia, your virtual host. How can I help you today?`;
  res.type("text/xml").send(speak(greeting));
});

// Process caller speech
app.post("/process-speech", async (req, res) => {
  const callSid  = req.body.CallSid;
  const speech   = req.body.SpeechResult;
  const session  = sessions.get(callSid) || { history: [], callerPhone: req.body.From };

  session.history.push({ role: "user", content: speech });

  try {
    const ai = await askClaude(session.history);
    session.history.push({ role: "assistant", content: JSON.stringify(ai) });
    sessions.set(callSid, session);

    if (ai.intent === "transfer") {
      return res.type("text/xml").send(speak(ai.say, { transfer: true }));
    }

    if (ai.booking_ready && ai.date && ai.time && ai.party_size && ai.guest_name) {
      const { available } = await checkYelpAvailability(ai);
      if (!available) {
        session.history.push({ role: "user", content: "That time is unavailable. Apologize and ask for another time." });
        const retry = await askClaude(session.history);
        session.history.push({ role: "assistant", content: JSON.stringify(retry) });
        sessions.set(callSid, session);
        return res.type("text/xml").send(speak(retry.say));
      }

      const booking = await createYelpReservation({ ...ai, guest_phone: session.callerPhone });
      if (booking.success) {
        await sendSMS({ to: session.callerPhone, ...ai, confirmation_id: booking.confirmation_id });
        sessions.delete(callSid);
        return res.type("text/xml").send(speak(
          `${ai.say} Your confirmation number is ${booking.confirmation_id}. We sent a text to your phone. Arrivederci!`,
          { end: true }
        ));
      }
      return res.type("text/xml").send(speak("I'm sorry, I couldn't complete the booking. Let me transfer you.", { transfer: true }));
    }

    res.type("text/xml").send(speak(ai.say));

  } catch (err) {
    console.error("Error:", err.message);
    res.type("text/xml").send(speak("Mi dispiace, I'm having trouble. Let me transfer you to our staff.", { transfer: true }));
  }
});

// No input fallback
app.post("/no-input", (_req, res) => {
  const twiml = new VoiceResponse();
  const g = twiml.gather({ input: "speech", action: "/process-speech", speechTimeout: "auto" });
  g.say({ voice: "Polly.Joanna-Neural" }, "Are you still there? How can I help you?");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

// SMS handler
app.post("/incoming-sms", (_req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(`Thanks for contacting ${RESTAURANT.name}! For reservations please call us. Grazie!`);
  res.type("text/xml").send(twiml.toString());
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
