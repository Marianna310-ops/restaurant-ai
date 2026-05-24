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

// ─── Claude system prompt (speech-optimized) ──────────────────────────────────
const SYSTEM_PROMPT = `You are Sofia, a warm and charming host at ${RESTAURANT.name}, an authentic Italian restaurant in Seattle.
Our hours are ${RESTAURANT.hours}. Today is ${new Date().toISOString().split("T")[0]}.

Your personality:
- Warm, genuine, and slightly Italian in flavor — use occasional words like "Perfetto!", "Benissimo!", "Certo!"
- Speak naturally like a real person on the phone — use contractions, short sentences, natural rhythm
- Never sound scripted or robotic
- If someone asks something unexpected, handle it gracefully like a real host would

Your job: help callers make reservations or answer questions.

IMPORTANT — Your "say" field will be read aloud by a voice AI, so:
- Write short, natural sentences. No bullet points or lists.
- Use commas and ellipses to create natural pauses: "Let me see... yes, we have availability!"
- Avoid special characters like *, #, /, &
- Use words instead of numbers where natural: "seven PM" not "7 PM"
- Keep each response under 3 sentences — callers don't want to listen to long speeches

Always reply ONLY with this JSON — no other text:
{
  "intent": "reservation|hours|menu|other|transfer",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "party_size": number or null,
  "guest_name": "string or null",
  "say": "what Sofia says out loud",
  "booking_ready": true or false
}

For a reservation collect all four: date, time, party_size, guest_name.
Only set booking_ready to true when you have all four.
Ask for one missing piece at a time — don't bombard the caller with multiple questions.`;

// ─── In-memory sessions ───────────────────────────────────────────────────────
const sessions = new Map();

// ─── Ask Claude ───────────────────────────────────────────────────────────────
async function askClaude(history) {
  const res = await getClaude().messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 300,
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
    return { available: true };
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

// ─── Italian phoneme dictionary — native pronunciation via IPA ───────────────
const ITALIAN_PHONEMES = [
  ["Buonasera",   "bwɔnaˈsɛra"    ],
  ["buonasera",   "bwɔnaˈsɛra"    ],
  ["Arrivederci", "arriˈvɛdertʃi" ],
  ["arrivederci", "arriˈvɛdertʃi" ],
  ["Grazie",      "ˈɡrattsje"     ],
  ["grazie",      "ˈɡrattsje"     ],
  ["Perfetto",    "perˈfetto"     ],
  ["perfetto",    "perˈfetto"     ],
  ["Benissimo",   "beˈnissimo"    ],
  ["benissimo",   "beˈnissimo"    ],
  ["Certo",       "ˈtʃɛrto"       ],
  ["certo",       "ˈtʃɛrto"       ],
  ["Prego",       "ˈprɛɡo"        ],
  ["prego",       "ˈprɛɡo"        ],
  ["Ciao",        "ˈtʃao"         ],
  ["ciao",        "ˈtʃao"         ],
  ["Allora",      "alˈlɔra"       ],
  ["allora",      "alˈlɔra"       ],
  ["Bruschetta",  "bruˈsketta"    ],
  ["bruschetta",  "bruˈsketta"    ],
  ["Gnocchi",     "ˈɲɔkki"        ],
  ["gnocchi",     "ˈɲɔkki"        ],
  ["Risotto",     "riˈzɔtto"      ],
  ["risotto",     "riˈzɔtto"      ],
  ["Tiramisu",    "tiramiˈsu"     ],
  ["tiramisu",    "tiramiˈsu"     ],
  ["Antipasto",   "antiˈpasto"    ],
  ["antipasto",   "antiˈpasto"    ],
  ["Carbonara",   "karboˈnaːra"   ],
  ["Bolognese",   "boloɲˈɲeːze"   ],
];

// ─── Convert plain text to SSML ───────────────────────────────────────────────
function toSSML(text) {
  // Escape XML special characters first
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Replace Italian words with IPA phoneme tags for native-sounding pronunciation
  for (const [word, ipa] of ITALIAN_PHONEMES) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(
      new RegExp("\\b" + escaped + "\\b", "g"),
      `<phoneme alphabet="ipa" ph="${ipa}">${word}</phoneme>`
    );
  }

  // Natural pauses at punctuation
  s = s
    .replace(/\.\.\./ g,  '<break time="450ms"/>')
    .replace(/,\s/g,      ',<break time="200ms"/> ')
    .replace(/\?\s*/g,   '?<break time="300ms"/> ')
    .replace(/!\s*/g,     '!<break time="250ms"/> ');

  return `<speak><prosody rate="93%" pitch="+1st">${s}</prosody></speak>`;
}

// ─── Build TwiML ──────────────────────────────────────────────────────────────
// Google Neural2-F: natural American accent + perfect Italian phonemes
const VOICE = "Google.en-US-Neural2-F";

function speak(text, { end = false, transfer = false } = {}) {
  const twiml = new VoiceResponse();
  const ssml  = toSSML(text);

  if (transfer && RESTAURANT.phone) {
    twiml.say({ voice: VOICE }, text); // no SSML for transfer, keep it quick
    twiml.dial(RESTAURANT.phone);
    return twiml.toString();
  }

  if (end) {
    twiml.say({ voice: VOICE, language: "en-US" }, text);
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

  // Use SSML for main conversation — sounds most natural
  g.say({ voice: VOICE, language: "en-US" }, ssml);
  twiml.redirect("/no-input");
  return twiml.toString();
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get("/",       (_req, res) => res.json({ status: "ok", restaurant: RESTAURANT.name }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Incoming call
app.post("/incoming-call", (req, res) => {
  const callSid = req.body.CallSid;
  sessions.set(callSid, { history: [], callerPhone: req.body.From });
  const greeting = `Buonasera! Thank you for calling ${RESTAURANT.name}. I'm Sofia... how can I help you this evening?`;
  res.type("text/xml").send(speak(greeting));
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
      return res.type("text/xml").send(speak(ai.say, { transfer: true }));
    }

    if (ai.booking_ready && ai.date && ai.time && ai.party_size && ai.guest_name) {
      const { available } = await checkYelpAvailability(ai);

      if (!available) {
        session.history.push({ role: "user", content: "That time is not available. Apologize warmly and ask for another time." });
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
          `${ai.say} Your confirmation number is ${booking.confirmation_id}. We've sent a text to your phone as well. We can't wait to see you — arrivederci!`,
          { end: true }
        ));
      }

      return res.type("text/xml").send(
        speak("Oh, I'm so sorry — I had a little trouble completing that booking. Let me get one of our team members to help you right away.", { transfer: true })
      );
    }

    res.type("text/xml").send(speak(ai.say));

  } catch (err) {
    console.error("Error:", err.message);
    res.type("text/xml").send(
      speak("Mi dispiace, I seem to be having a little trouble at the moment. Let me transfer you to our staff.", { transfer: true })
    );
  }
});

// No input
app.post("/no-input", (_req, res) => {
  const twiml = new VoiceResponse();
  const g = twiml.gather({ input: "speech", action: "/process-speech", speechTimeout: "auto" });
  g.say({ voice: VOICE }, "I'm still here! Take your time — how can I help?");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

// SMS
app.post("/incoming-sms", (_req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(`Grazie for reaching out to ${RESTAURANT.name}! For reservations please give us a call. See you soon!`);
  res.type("text/xml").send(twiml.toString());
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
