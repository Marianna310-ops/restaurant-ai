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
console.log("ELEVENLABS_KEY      :", process.env.ELEVENLABS_KEY           ? "SET" : "MISSING");
console.log("ELEVENLABS_VOICE    :", process.env.ELEVENLABS_VOICE         ? "SET" : "MISSING");
console.log("RAILWAY_DOMAIN      :", process.env.RAILWAY_DOMAIN           ? "SET" : "MISSING");
console.log("PORT                :", process.env.PORT || "8080 (default)");
console.log("=================");

// ─── Restaurant config ────────────────────────────────────────────────────────
const RESTAURANT = {
  name:      process.env.RESTAURANT_NAME       || "Marianna Ristorante",
  yelpAlias: process.env.RESTAURANT_YELP_ALIAS || "marianna-ristorante-seattle",
  hours:     "Tuesday through Sunday, 5 PM to 10 PM. We are closed on Mondays.",
  phone:     process.env.STAFF_PHONE           || null,
};

// ─── Claude system prompt ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Sofia, a warm and charming host at ${RESTAURANT.name}, an authentic Italian restaurant.
Our hours are ${RESTAURANT.hours}. Today is ${new Date().toISOString().split("T")[0]}.

Your personality:
- Warm, genuine, slightly Italian in flavor — use words like "Perfetto!", "Benissimo!", "Certo!" naturally
- Speak like a real person on the phone — contractions, short sentences, natural rhythm
- Never sound scripted or robotic
- Handle unexpected questions gracefully like a real host would

Your job: help callers make reservations or answer questions about the restaurant.

Your "say" field will be read aloud so:
- Write short natural sentences — no bullet points or lists
- Use commas and ellipses for natural pauses: "Let me see... yes, we have availability!"
- No special characters like *, #, /, &
- Use words for numbers: "seven PM" not "7 PM"
- Max 2-3 sentences per response — keep it conversational

Always reply ONLY with this exact JSON — no other text:
{
  "intent": "reservation|hours|menu|other|transfer",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "party_size": number or null,
  "guest_name": "string or null",
  "say": "what Sofia says out loud",
  "booking_ready": true or false
}

Rules:
- For a reservation collect: date, time, party_size, guest_name
- Set booking_ready true only when all four are collected
- Ask for ONE missing field at a time — never ask multiple questions at once
- If caller is confused or upset, set intent to "transfer"`;

// ─── In-memory sessions ───────────────────────────────────────────────────────
const sessions  = new Map();
const audioCache = new Map();

// ─── Ask Claude ───────────────────────────────────────────────────────────────
async function askClaude(history) {
  const res = await getClaude().messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: 300,
    system:     SYSTEM_PROMPT,
    messages:   history,
  });
  const clean = res.content[0].text.trim().replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── ElevenLabs TTS ───────────────────────────────────────────────────────────
async function elevenLabsSpeak(text) {
  const apiKey  = process.env.ELEVENLABS_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE;

  if (!apiKey || !voiceId) {
    console.warn("ElevenLabs — KEY:", apiKey ? "SET" : "MISSING", "| VOICE:", voiceId ? "SET" : "MISSING");
    return null;
  }

  try {
    console.log("Calling ElevenLabs with voice:", voiceId);
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        text,
        model_id: "eleven_turbo_v2",
        voice_settings: {
          stability:         0.45,
          similarity_boost:  0.80,
          style:             0.35,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          "xi-api-key":   apiKey,
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
    console.error("ElevenLabs error:", err.response?.status, JSON.stringify(err.response?.data) || err.message);
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
  const domain  = process.env.RAILWAY_DOMAIN || `localhost:${process.env.PORT || 8080}`;
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
    speechTimeout: "auto",
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
    ELEVENLABS_KEY:      process.env.ELEVENLABS_KEY       ? "SET" : "MISSING",
    ELEVENLABS_VOICE:    process.env.ELEVENLABS_VOICE     ? "SET" : "MISSING",
    RAILWAY_DOMAIN:      process.env.RAILWAY_DOMAIN       ? "SET" : "MISSING",
    ALL_ENV_KEYS:        Object.keys(process.env).filter(k => !k.includes("npm")).sort(),
  });
});

// Incoming call
app.post("/incoming-call", async (req, res) => {
  const callSid = req.body.CallSid;
  sessions.set(callSid, { history: [], callerPhone: req.body.From });
  const greeting = `Buonasera! Thank you for calling ${RESTAURANT.name}. I'm Sofia... how can I help you this evening?`;
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

    if (ai.booking_ready && ai.date && ai.time && ai.party_size && ai.guest_name) {
      const { available } = await checkYelpAvailability(ai);

      if (!available) {
        session.history.push({ role: "user", content: "That time is unavailable. Apologize warmly and ask for another time." });
        const retry = await askClaude(session.history);
        session.history.push({ role: "assistant", content: JSON.stringify(retry) });
        sessions.set(callSid, session);
        return res.type("text/xml").send(await speak(retry.say));
      }

      const booking = await createYelpReservation({ ...ai, guest_phone: session.callerPhone });

      if (booking.success) {
        await sendSMS({ to: session.callerPhone, ...ai, confirmation_id: booking.confirmation_id });
        sessions.delete(callSid);
        return res.type("text/xml").send(await speak(
          `${ai.say} Your confirmation number is ${booking.confirmation_id}. We've also sent a text to your phone. We can't wait to see you — arrivederci!`,
          { end: true }
        ));
      }

      return res.type("text/xml").send(
        await speak("Oh, I'm so sorry — I had a little trouble with that booking. Let me get one of our team to help you right away.", { transfer: true })
      );
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
  const domain  = process.env.RAILWAY_DOMAIN || `localhost:${process.env.PORT || 8080}`;
  const baseUrl = domain.startsWith("http") ? domain : `https://${domain}`;
  const g = twiml.gather({ input: "speech", action: "/process-speech", speechTimeout: "auto" });
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
