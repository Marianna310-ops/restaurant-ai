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

NATURAL LANGUAGE UNDERSTANDING — recognize ALL of these as the same intent:

HOURS intent — caller is asking if you are open or what time:
"are you open?" / "are you open today?" / "are you open right now?" / "what time do you open?" /
"what time do you close?" / "when do you close?" / "what are your hours?" / "are you guys open?" /
"is the restaurant open?" / "do you close early?" / "when can I come in?" / "are you open on weekends?"
→ ANSWER: "We're open every day from three PM to ten PM. Happy hour runs three to six!"

HAPPY HOUR intent — caller is asking about deals, specials, or happy hour:
"do you have happy hour?" / "is happy hour still going?" / "do you have any specials?" /
"what are your drink specials?" / "do you have any deals?" / "when is happy hour?" /
"is it happy hour right now?" / "do you guys do happy hour?"
→ ANSWER: "Happy hour is every day from three to six PM. Great deals on drinks and bites!"

RESERVATION intent — caller wants to book or check availability:
"can I make a reservation?" / "do you take reservations?" / "can I book a table?" /
"do you have availability?" / "are you available Saturday?" / "can we get a table?" /
"I want to come in" / "we want to eat there" / "can you fit us in?" / "do you have room for us?"
→ Ask for date and time, then send Yelp link via SMS

MENU intent — caller asks about food, dishes, or what you serve:
"what do you serve?" / "what's on the menu?" / "what kind of food is it?" /
"what do you have?" / "what's good?" / "do you have pasta?" / "do you have pizza?" /
"what are your specials?" / "what do you recommend?"
→ Mention the specialty and ask what they are in the mood for

WINE intent — caller asks about drinks or wine:
"do you have wine?" / "what wines do you have?" / "do you have a wine list?" /
"what Italian wines do you carry?" / "do you have a bar?" / "do you have local wines?"
→ Mention Italian and local Washington wines. Full bar available.

VIBE intent — caller asks about the restaurant feel or atmosphere:
"what kind of place is it?" / "what's the vibe like?" / "is it fancy?" /
"is it good for a date?" / "is it family friendly?" / "what's it like?"
→ Authentic Tuscan-inspired, spacious dining room, up to 90 guests, warm and welcoming

GROUP/EVENT intent — caller asks about large parties or events:
"can you fit a large group?" / "do you do events?" / "we have a party of..." /
"can you accommodate us?" / "do you have a private room?"
→ Dining room seats up to 90 guests, great for groups and events. Prix fixe family style available.

FULL MENU KNOWLEDGE:

APPETIZERS:
- Calamari Fritti (say: "cah-lah-MAH-ree FREE-tee")
- Steamed Mussels and Clams — Cozze e Vongole (say: "COT-zeh eh VON-go-leh")
- Bruschetta Pomodoro (say: "broo-SKET-tah po-mo-DOH-ro")
- Charcuterie Board

SPECIALTY:
- Pizza Toscana (say: "Toh-SKAH-nah") — our signature dish

PASTAS:
- Spaghetti Bolognese (say: "Bo-lo-NYAY-ze")
- Rigatoni with local Italian sausage
- Lobster Ravioli
- Linguini Frutti di Mare (say: "FROOT-tee dee MAH-reh") — fresh seafood pasta
- Risotto di Mare (say: "ree-ZOT-toh dee MAH-reh") — seafood risotto

SEAFOOD & MAINS:
- King Salmon
- Fresh seafood dishes
- Premium steaks

PRIX FIXE:
- $59 per person family style dinner — everything shareable at the table
- Great for groups and special occasions

DESSERTS:
- Homemade Tiramisu (say: "tee-rah-mee-SOO")
- Pannacotta (say: "pan-nah-COT-tah")
- Limoncello Cake (say: "lee-mon-CHEL-loh")
- House Chocolate Mousse Cake

WINES:
Italian: Chianti, Brunello di Montalcino, Barolo
Local Washington: L'Ecole Cabernet, Mark Ryan Wines, Red Mountain Cabernet
Full bar available

RESTAURANT INFO:
- Hours: Every day 3 PM to 10 PM
- Happy Hour: Every day 3 PM to 6 PM
- Capacity: Up to 90 guests
- Reservations: Yelp only — offer to text the link
- Location: Renton, Washington

PERSONA:
- Name: Sofia
- Warm, welcoming, sophisticated yet approachable
- Occasional Italian: "Buongiorno", "Prego", "Grazie", "A presto"
- Always smiling and helpful
- Pronounce Italian dishes naturally and correctly

GREETING: "Grazie for calling Marianna Ristorante in Renton! This is Sofia — how can I help you today?"
CLOSING: "We look forward to seeing you soon. A presto!"

RECOMMENDATIONS:
- For food: Pizza Toh-SKAH-nah or Rigatoni with local Italian sausage
- For seafood lovers: Linguini Frutti di Mare or King Salmon
- For groups: Prix fixe family style at $59 per person
- For dessert: Homemade Tiramisu or Limoncello Cake

Always reply ONLY with this exact JSON — no other text:
{
  "intent": "reservation|hours|menu|happy_hour|wine|vibe|group|appetizer|dessert|seafood|prix_fixe|other|transfer|send_sms",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "party_size": number or null,
  "guest_name": "string or null",
  "say": "Sofia response — max 2 short sentences, no fluff, natural and warm",
  "send_yelp_sms": true or false,
  "booking_ready": false
}

Today is ${new Date().toISOString().split("T")[0]}.
booking_ready is always false — Yelp handles all bookings.`;

// ─── In-memory sessions & audio cache ────────────────────────────────────────
const sessions   = new Map();
const audioCache = new Map();

// ─── Pre-generate common responses at startup ─────────────────────────────────
// These play instantly with zero ElevenLabs latency during calls
const PRE_CACHED = {
  greeting:   "Grazie for calling Marianna Ristorante in Renton! This is Sofia — how can I help you today?",
  thinking0:  "Mm, let me check on that for you.",
  thinking1:  "Sure, one moment.",
  thinking2:  "Of course, just a second.",
  thinking3:  "Certo, let me see.",
  thinking4:  "Absolutely, give me just a moment.",
};

// Pick a random thinking phrase each time so it never sounds repetitive
function getThinkingId() {
  const keys = ["thinking0","thinking1","thinking2","thinking3","thinking4"];
  const key  = keys[Math.floor(Math.random() * keys.length)];
  return preCache.get(key);
}
const preCache  = new Map(); // phrase → audioId
let cacheReady  = false;       // true once warmUpCache finishes

async function warmUpCache() {
  console.log("Pre-generating common audio responses...");
  for (const [key, text] of Object.entries(PRE_CACHED)) {
    const audioId = await elevenLabsSpeak(text);
    if (audioId) {
      preCache.set(key, audioId);
      console.log(`Cached: ${key}`);
    }
    // Small delay between ElevenLabs calls to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }
  cacheReady = true;
  console.log("Audio cache ready!");
}

// ─── Ask Claude ───────────────────────────────────────────────────────────────
async function askClaude(history) {
  const res = await getClaude().messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: 250,
    system:     SYSTEM_PROMPT,
    messages:   history,
  });
  const raw   = res.content[0].text.trim();
  const clean = raw.replace(/```json|```/g, "").trim();
  // Extract JSON object even if there is trailing text
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in Claude response: " + clean);
  return JSON.parse(match[0]);
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
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=4`,
      {
        text,
        model_id: "eleven_flash_v2",
        voice_settings: {
          stability:         0.5,
          similarity_boost:  0.75,
          style:             0.0,
          use_speaker_boost: false,
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
  if (!entry) {
    console.error("Audio not found in cache:", req.params.id);
    return res.status(404).send("Not found");
  }
  // Headers optimized for Twilio audio playback
  res.set({
    "Content-Type":   "audio/mpeg",
    "Content-Length": entry.buffer.length,
    "Cache-Control":  "no-cache",
    "Accept-Ranges":  "bytes",
  });
  console.log("Serving audio to Twilio:", req.params.id, entry.buffer.length, "bytes");
  res.send(entry.buffer);
});

// Restaurant ambiance — proxies royalty-free background noise
app.get("/ambiance", async (req, res) => {
  const apiKey = process.env.ELEVEN_LABS_API_KEY;
  if (!apiKey) return res.status(400).send("No API key");

  try {
    // Generate restaurant ambiance using ElevenLabs Sound Effects API
    const response = await axios.post(
      "https://api.elevenlabs.io/v1/sound-generation",
      {
        text: "Quiet upscale Italian restaurant ambiance, soft background chatter, gentle clinking glasses, warm atmosphere",
        duration_seconds: 3,
        prompt_influence: 0.3,
      },
      {
        headers: {
          "xi-api-key":   apiKey.trim(),
          "Content-Type": "application/json",
          "Accept":       "audio/mpeg",
        },
        responseType: "stream",
      }
    );
    res.set("Content-Type", "audio/mpeg");
    response.data.pipe(res);
  } catch (err) {
    console.error("Ambiance error:", err.response?.status, err.message);
    // Fallback — silence (empty response so Twilio doesn't error)
    res.status(204).send();
  }
});

// Twilio audio proxy — streams ElevenLabs directly to Twilio in real time
app.get("/stream/:voiceId", async (req, res) => {
  const text    = Buffer.from(req.query.text || "", "base64").toString("utf8");
  const voiceId = req.params.voiceId;
  const apiKey  = process.env.ELEVEN_LABS_API_KEY;

  if (!text || !apiKey) return res.status(400).send("Missing params");

  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=4`,
      {
        text,
        model_id: "eleven_flash_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: false },
      },
      {
        headers: { "xi-api-key": apiKey.trim(), "Content-Type": "application/json", "Accept": "audio/mpeg" },
        responseType: "stream",
      }
    );
    res.set("Content-Type", "audio/mpeg");
    response.data.pipe(res);
  } catch (err) {
    console.error("Stream error:", err.message);
    res.status(500).send("Stream failed");
  }
});

// ─── Build TwiML ──────────────────────────────────────────────────────────────
async function speak(text, { end = false, transfer = false } = {}) {
  const twiml   = new VoiceResponse();
  const audioId = await elevenLabsSpeak(text);
  console.log("BaseURL for audio:", `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  const baseUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;

  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey  = process.env.ELEVEN_LABS_API_KEY;
  const encoded = Buffer.from(text).toString("base64");

  const playOrSay = (target) => {
    if (voiceId && apiKey) {
      // Stream directly — no cache needed, Twilio fetches from our /stream endpoint
      const streamUrl = `${baseUrl}/stream/${voiceId}?text=${encoded}`;
      console.log("Streaming ElevenLabs audio to Twilio");
      target.play(streamUrl);
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
    speechTimeout: "3",
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
app.get("/health", (_req, res) => {
  // If cache crashed or never warmed up, restart it automatically
  if (!cacheReady) {
    console.log("Health check triggered cache warmup...");
    warmUpCache().catch(err => console.error("Cache warmup error:", err.message));
  }
  res.json({ status: "ok", cacheReady, restaurant: RESTAURANT.name });
});

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
app.post("/incoming-call", (req, res) => {
  try {
    const callSid   = req.body.CallSid;
    sessions.set(callSid, { history: [], callerPhone: req.body.From });
    const greetText = "Grazie for calling Marianna Ristorante in Renton! This is Sofia — how can I help you today?";
    const baseUrl   = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    const twiml     = new VoiceResponse();
    const g = twiml.gather({
      input: "speech", action: "/process-speech",
      speechTimeout: "3", language: "en-US", enhanced: "true"
    });

    // Use pre-cached ElevenLabs audio if ready — otherwise instant Google fallback
    const cachedGreetId = cacheReady ? preCache.get("greeting") : null;
    if (cachedGreetId) {
      g.play(`${baseUrl}/audio/${cachedGreetId}`);
    } else {
      // Google Neural voice — responds in milliseconds, no ElevenLabs needed
      g.say({ voice: "Google.en-US-Neural2-F", language: "en-US" }, greetText);
    }

    twiml.redirect("/no-input");
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Incoming call error:", err.message);
    const twiml = new VoiceResponse();
    twiml.say({ voice: "Google.en-US-Neural2-F" }, "Thank you for calling Marianna Ristorante. Please hold.");
    twiml.redirect("/no-input");
    res.type("text/xml").send(twiml.toString());
  }
});

// Process speech
app.post("/process-speech", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech  = req.body.SpeechResult;
  const session = sessions.get(callSid) || { history: [], callerPhone: req.body.From };

  session.history.push({ role: "user", content: speech });

  // Play "thinking" filler immediately while Claude + ElevenLabs process
  // Only use pre-cache if it is warmed up — otherwise skip to direct processing
  const baseUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  // Stream thinking sound + restaurant ambiance while processing
  const voiceId  = process.env.ELEVENLABS_VOICE_ID;
  const apiKey   = process.env.ELEVEN_LABS_API_KEY;
  const thoughts = [
    "Mm, let me check on that for you.",
    "Sure, one moment.",
    "Of course, just a second.",
    "Certo, let me see.",
    "Absolutely, give me just a moment.",
  ];
  const thinkText    = thoughts[Math.floor(Math.random() * thoughts.length)];
  const thinkBaseUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;

  if (voiceId && apiKey) {
    const encoded  = Buffer.from(thinkText).toString("base64");
    const twiml    = new VoiceResponse();

    // Play thinking phrase first
    twiml.play(`${thinkBaseUrl}/stream/${voiceId}?text=${encoded}`);

    // Then play restaurant ambiance while Claude + ElevenLabs process the response
    // Using a short royalty-free restaurant ambiance clip on loop
    twiml.play({ loop: 1 }, `${thinkBaseUrl}/ambiance`);

    twiml.pause({ length: 1 });
    twiml.redirect("/process-speech-async?callSid=" + callSid);
    res.type("text/xml").send(twiml.toString());
    session.pendingSpeech = speech;
    sessions.set(callSid, session);
    return;
  }

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

// Async speech processing (after thinking sound plays)
app.post("/process-speech-async", async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const session = sessions.get(callSid);
  if (!session) return res.type("text/xml").send("<Response><Hangup/></Response>");

  const speech = session.pendingSpeech || "";
  delete session.pendingSpeech;

  try {
    const ai = await askClaude(session.history);
    session.history.push({ role: "assistant", content: JSON.stringify(ai) });
    sessions.set(callSid, session);

    if (ai.send_yelp_sms && session.callerPhone) {
      try {
        await getTwilioClient().messages.create({
          body: `Hi! Book your table at Marianna Ristorante: ${RESTAURANT.yelpLink} — A presto!`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to:   session.callerPhone,
        });
      } catch (err) { console.error("SMS error:", err.message); }
    }

    if (ai.intent === "transfer") {
      return res.type("text/xml").send(await speak(ai.say, { transfer: true }));
    }
    res.type("text/xml").send(await speak(ai.say));
  } catch (err) {
    console.error("Async error:", err.message);
    res.type("text/xml").send(await speak("Mi dispiace, let me transfer you to our staff.", { transfer: true }));
  }
});

// No input fallback
app.post("/no-input", async (_req, res) => {
  const twiml    = new VoiceResponse();
  const text     = "I'm still here! Take your time — how can I help?";
  const voiceId  = process.env.ELEVENLABS_VOICE_ID;
  const apiKeySt = process.env.ELEVEN_LABS_API_KEY;
  const baseUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const g = twiml.gather({ input: "speech", action: "/process-speech", speechTimeout: "3" });
  if (audioId) {
    if (voiceId && apiKeySt) {
      const enc = Buffer.from(text).toString("base64");
      g.play(`${baseUrl}/stream/${voiceId}?text=${enc}`);
    } else {
      g.say({ voice: "Google.en-US-Neural2-F" }, text);
    }
  } else {
    g.say({ voice: "Google.en-US-Neural2-F" }, text);
  }
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

// Twilio fallback — plays if primary webhook fails
app.post("/fallback", (_req, res) => {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: "Google.en-US-Neural2-F" },
    "Grazie for calling Marianna Ristorante. We are sorry for the inconvenience, please call us back in a moment."
  );
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
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server running on port ${PORT}`);
  // Pre-generate common audio after a short delay to let server fully start
  console.log("Using direct ElevenLabs streaming — no cache warmup needed.");
});
