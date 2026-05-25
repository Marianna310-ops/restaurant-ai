require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;

// ─── Lazy init clients ────────────────────────────────────────────────────────
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
console.log("TWILIO_ACCOUNT_SID  :", process.env.TWILIO_ACCOUNT_SID       ? "SET" : "MISSING");
console.log("TWILIO_AUTH_TOKEN   :", process.env.TWILIO_AUTH_TOKEN        ? "SET" : "MISSING");
console.log("TWILIO_PHONE_NUMBER :", process.env.TWILIO_PHONE_NUMBER      ? "SET" : "MISSING");
console.log("ANTHROPIC_API_KEY   :", process.env.ANTHROPIC_API_KEY        ? "SET" : "MISSING");
console.log("ELEVEN_LABS_API_KEY :", process.env.ELEVEN_LABS_API_KEY           ? "SET" : "MISSING");
console.log("ELEVENLABS_VOICE_ID :", process.env.ELEVENLABS_VOICE_ID         ? "SET" : "MISSING");
console.log("RAILWAY_PUBLIC_DOMAIN:", process.env.RAILWAY_PUBLIC_DOMAIN           ? "SET" : "MISSING");
console.log("PORT                :", process.env.PORT || "8080 (default)");
console.log("=================");

// ─── Restaurant config ────────────────────────────────────────────────────────
const RESTAURANT = {
  name:      process.env.RESTAURANT_NAME       || "Marianna Ristorante",
  yelpAlias: process.env.RESTAURANT_YELP_ALIAS || "marianna-ristorante-seattle",
  hours:     "Every day from 3 PM to 10 PM.",
  phone:     process.env.STAFF_PHONE           || null,
  yelpLink:  process.env.YELP_LINK             || "https://www.yelp.com/reservations/marianna-ristorante-renton",
};

// ─── Claude system prompt ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Sofia, the virtual concierge for Marianna Ristorante, an authentic Tuscan-inspired Italian restaurant in Renton, Washington.

STRICT BREVITY RULES:
- ONE BREATH RULE: Never more than 2 short sentences per response. Hard limit.
- NO FLUFF: Never say "I would be happy to help" or "great question" or any filler phrase
- DIRECT ANSWERS: Asked for hours? Give the hours. Asked for a table? Ask for the date. Nothing more.
- WAIT FOR INPUT: Say one thing, then stop. Let the caller respond.
- TURN-TAKING: End with a short question to keep the conversation moving

RESTAURANT KNOWLEDGE:
- Specialty: Pizza Toscana (pronounce: "Toh-skah-nah")
- Pastas: Spaghetti Bolognese (pronounce: "Bo-lo-nyay-ze"), Rigatoni with local Italian sausage, Lobster Ravioli, Risotto
- Also: Fresh seafood, premium steaks, full bar
- Happy Hour: Every day 3 PM to 6 PM (first 3 hours of service)
- Dining room seats up to 90 guests — great for groups and events
- Wines: Chianti, Brunello di Montalcino, Barolo
- Reservations: Exclusively through Yelp — offer to text the Yelp link

PERSONA:
- Name: Sofia
- Warm, welcoming, sophisticated yet approachable
- Like a knowledgeable Italian host who treats every caller like a regular
- Occasional Italian words: "Buongiorno", "Prego", "Grazie", "A presto"
- Always smiling and helpful tone
- Pronounce Italian dishes naturally and correctly

GREETING: "Grazie for calling Marianna Ristorante in Renton! This is Sofia — how can I help you today?"
CLOSING: "We look forward to seeing you soon. A presto!"

RESERVATIONS:
- Use Yelp exclusively for bookings
- Ask for the date and time they are considering
- Offer to send the Yelp reservation link via SMS

RECOMMENDATIONS:
- Pizza Toh-skah-nah or Rigatoni with local Italian sausage

Always reply ONLY with this exact JSON — no other text:
{
  "intent": "reservation|hours|menu|happy_hour|wine|vibe|other|transfer|send_sms",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "party_size": number or null,
  "guest_name": "string or null",
  "say": "Sofia response — max 2 short sentences, no fluff",
  "send_yelp_sms": true or false,
  "booking_ready": false
}

Today is ${new Date().toISOString().split("T")[0]}.
booking_ready is always false — Yelp handles all bookings.`;

// ─── In-memory sessions ───────────────────────────────────────────────────────
const sessions  = new Map();
const audioCache = new Map();

// ─── Ask Claude ───────────────────────────────────────────────────────────────
async function askClaude(history) {
  const res = await getClaude().messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: 150,
    system:     SYSTEM_PROMPT,
    messages:   history,
  });
  const clean = res.content[0].text.trim().replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── ElevenLabs TTS ───────────────────────────────────────────────────────────
async function elevenLabsSpeak(text) {
  const apiKey  = process.env.ELEVEN_LABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    console.warn("ElevenLabs — KEY:", apiKey ? "SET" : "MISSING", "| VOICE:", voiceId ? "SET" : "MISSING");
    return null;
  }

  try {
    console.log("Calling ElevenLabs with voice:", voiceId);
    // Log first 10 chars of key to verify it loaded correctly (safe to log partial)
    console.log("Using API key starting with:", apiKey.substring(0, 10) + "...");

    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: "eleven_flash_v2_5",
        voice_settings: {
          stability:         0.45,
          similarity_boost:  0.80,
          style:             0.35,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          "xi-api-key":   apiKey.trim(),
          "Content-Type": "application/json",
          "Accept":       "audio/mpeg",
        },
        responseType: "arraybuffer",
      }
    );

    const audioBuffer = Buffer.from(response.data);
    const audioId     = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    audioCache.set(audioId, { buffer: audioBuffer, created: Date.now() });

    // Clean up audio older than 5 minutes
    for (const [id, entry] of audioCache.entries()) {
      if (Date.now() - entry.created > 300000) audioCache.delete(id);
    }

    console.log("ElevenLabs audio generated:", audioId);
    return audioId;

  } catch (err) {
    const errData = err.response?.data;
    const errText = errData instanceof Buffer || errData?.type === "Buffer"
      ? Buffer.from(errData.data || errData).toString("utf8")
      : JSON.stringify(errData);
    console.error("ElevenLabs error:", err.response?.status, errText);
    return null;
  }
}

// ─── Serve cached audio ───────────────────────────────────────────────────────
app.get("/audio/:id", (req, res) => {
  const entry = audioCache.get(req.params.id);
  if (!entry) return res.status(404).send("Not found");
  res.set("Content-Type", "audio/mpeg");
  res.send(entry.buffer);
});

// ─── Build TwiML ──────────────────────────────────────────────────────────────
async function speak(text, { end = false, transfer = false } = {}) {
  const twiml   = new VoiceResponse();
  const audioId = await elevenLabsSpeak(text);
  const domain  = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${process.env.PORT || 8080}`;
  const baseUrl = domain.startsWith("http") ? domain : `https://${domain}`;

  const playOrSay = (target) => {
    if (audioId) {
      console.log("Playing ElevenLabs audio:", `${baseUrl}/audio/${audioId}`);
      target.play(`${baseUrl}/audio/${audioId}`);
    } else {
      target.say({ voice: "Google.en-US-Neural2-F", language: "en-US" }, text);
    }
  };

  if (transfer && RESTAURANT.phone) {
    playOrSay(twiml);
    twiml.dial(RESTAURANT.phone);
    return twiml.toString();
  }

  if (end) {
    playOrSay(twiml);
    twiml.hangup();
    return twiml.toString();
  }

  const g = twiml.gather({
    input:         "speech",
    action:        "/process-speech",
    speechTimeout: "1",
    language:      "en-US",
    enhanced:      "true",
  });

  playOrSay(g);
  twiml.redirect("/no-input");
  return twiml.toString();
}

// ─── Yelp: check availability ─────────────────────────────────────────────────
async function checkYelpAvailability({ date, time, party_size }) {
  try {
    const res = await axios.get(
      `https://api.yelp.com/v3/businesses/${RESTAURANT.yelpAlias}/reservations/availability`,
      { headers: { Authorization: `Bearer ${process.env.YELP_API_KEY}` },
        params:  { date, time, covers: party_size } }
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

// ─── Send SMS ─────────────────────────────────────────────────────────────────
async function sendSMS({ to, guest_name, date, time, party_size, confirmation_id }) {
  if (!to || !process.env.TWILIO_PHONE_NUMBER) return;
  await getTwilioClient().messages.create({
    body: `Reservation confirmed at ${RESTAURANT.name}!\n${guest_name} | ${date} at ${time} | Party of ${party_size}\nConfirmation #${confirmation_id}`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get("/",       (_req, res) => res.json({ status: "ok", restaurant: RESTAURANT.name }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Diagnostic route — visit this in browser to see all env vars ─────────────
app.get("/env-check", (_req, res) => {
  res.json({
    TWILIO_ACCOUNT_SID:  process.env.TWILIO_ACCOUNT_SID  ? "SET" : "MISSING",
    TWILIO_AUTH_TOKEN:   process.env.TWILIO_AUTH_TOKEN   ? "SET" : "MISSING",
    TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER ? "SET" : "MISSING",
    ANTHROPIC_API_KEY:   process.env.ANTHROPIC_API_KEY   ? "SET" : "MISSING",
    ELEVENLABS_KEY:      process.env.ELEVEN_LABS_API_KEY       ? "SET" : "MISSING",
    ELEVENLABS_VOICE:    process.env.ELEVENLABS_VOICE_ID     ? "SET" : "MISSING",
    RAILWAY_DOMAIN:      process.env.RAILWAY_PUBLIC_DOMAIN       ? "SET" : "MISSING",
    ALL_ENV_KEYS:        Object.keys(process.env).filter(k => !k.includes("npm")).sort(),
  });
});

// Incoming call
app.post("/incoming-call", async (req, res) => {
  const callSid = req.body.CallSid;
  sessions.set(callSid, { history: [], callerPhone: req.body.From });
  const greeting = `Grazie for calling Marianna Ristorante in Renton! This is Sofia — how can I help you today?`;
  res.type("text/xml").send(await speak(greeting));
});

// Process speech
app.post("/process-speech", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech  = req.body.SpeechResult;
  const session = sessions.get(callSid) || { history: [], callerPhone: req.body.From };

  session.history.push({ role: "user", content: speech });

  try {
    const ai = await askClaude(session.history);
    session.history.push({ role: "assistant", content: JSON.stringify(ai) });
    sessions.set(callSid, session);

    if (ai.intent === "transfer") {
      return res.type("text/xml").send(await speak(ai.say, { transfer: true }));
    }

    // Send Tock reservation link via SMS if requested
    if (ai.send_yelp_sms && session.callerPhone) {
      try {
        await getTwilioClient().messages.create({
          body: `Hi! Here is the link to book your table at Marianna Ristorante: ${RESTAURANT.yelpLink} — A presto!`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to:   session.callerPhone,
        });
        console.log("Yelp SMS sent to:", session.callerPhone);
      } catch (err) {
        console.error("Yelp SMS error:", err.message);
      }
    }

    // Tock handles all bookings — just send the link
    if (ai.intent === "reservation" && ai.date) {
      try {
        await getTwilioClient().messages.create({
          body: `Book your table at Marianna Ristorante here: ${RESTAURANT.yelpLink} — A presto!`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to:   session.callerPhone,
        });
      } catch (err) {
        console.error("Yelp SMS error:", err.message);
      }
    }

    res.type("text/xml").send(await speak(ai.say));

  } catch (err) {
    console.error("Processing error:", err.message);
    res.type("text/xml").send(
      await speak("Mi dispiace, I'm having a little trouble right now. Let me transfer you to our staff.", { transfer: true })
    );
  }
});

// No input fallback
app.post("/no-input", async (_req, res) => {
  const twiml   = new VoiceResponse();
  const text    = "I'm still here! Take your time — how can I help?";
  const audioId = await elevenLabsSpeak(text);
  const domain  = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${process.env.PORT || 8080}`;
  const baseUrl = domain.startsWith("http") ? domain : `https://${domain}`;
  const g = twiml.gather({ input: "speech", action: "/process-speech", speechTimeout: "1" });
  if (audioId) {
    g.play(`${baseUrl}/audio/${audioId}`);
  } else {
    g.say({ voice: "Google.en-US-Neural2-F" }, text);
  }
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

// SMS
app.post("/incoming-sms", (_req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(`Grazie for reaching out to ${RESTAURANT.name}! For reservations please give us a call. See you soon! 🍝`);
  res.type("text/xml").send(twiml.toString());
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
