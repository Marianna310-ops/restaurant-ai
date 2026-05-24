# 🍝 Restaurant AI Phone Assistant

AI-powered phone assistant for Italian restaurants using **Twilio + Claude + Yelp**.

Answers calls, holds natural conversations, and books reservations automatically.

---

## How It Works

```
Caller → Twilio Phone Number
              ↓ (webhook)
         This Server (Railway)
              ↓              ↓
         Claude AI       Yelp Guest Manager
        (understands     (books the table)
         the caller)
              ↓
         Twilio SMS → Confirmation text to caller
```

---

## Deploy in 5 Steps

### Step 1 — Push to GitHub

1. Create a free account at [github.com](https://github.com)
2. Create a new repository called `restaurant-ai`
3. Upload all these files to it (drag & drop in the GitHub UI works fine)

### Step 2 — Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign up with your GitHub account
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `restaurant-ai` repository
4. Railway will auto-detect Node.js and start deploying ✅

### Step 3 — Add Environment Variables on Railway

In your Railway project → **Variables** tab, add each of these:

| Variable | Where to find it |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Console → Account Info |
| `TWILIO_AUTH_TOKEN` | Twilio Console → Account Info |
| `TWILIO_PHONE_NUMBER` | Twilio Console → Phone Numbers |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `YELP_API_KEY` | Yelp Fusion API dashboard |
| `RESTAURANT_YELP_ALIAS` | Your Yelp URL slug (e.g. `marianna-ristorante-seattle`) |
| `RESTAURANT_NAME` | Your restaurant name |
| `STAFF_PHONE` | A real phone number to forward tricky calls |

After adding all variables, Railway will auto-redeploy.

### Step 4 — Get Your Railway URL

In Railway → your project → **Settings** → **Domains** → click **"Generate Domain"**

You'll get a URL like: `https://restaurant-ai-production.up.railway.app`

### Step 5 — Connect Twilio

1. Go to [Twilio Console](https://console.twilio.com) → Phone Numbers → Manage → your number
2. Under **Voice Configuration**:
   - **"A call comes in"** → Webhook → `https://YOUR-RAILWAY-URL/incoming-call`
   - Method: **HTTP POST**
3. Under **Messaging** (for SMS cancellations):
   - **"A message comes in"** → Webhook → `https://YOUR-RAILWAY-URL/incoming-sms`
   - Method: **HTTP POST**
4. Click **Save**

**Call your Twilio number — your AI host Sofia is live! 🎉**

---

## Testing

Call your Twilio number and try:
- *"I'd like to make a reservation for Saturday at 7pm for 4 people"*
- *"What are your hours?"*
- *"Do you have availability this Friday for 2?"*

---

## Customizing Sofia

Edit the `SYSTEM_PROMPT` in `server.js` to:
- Change restaurant hours
- Add menu items Sofia can describe
- Adjust her personality/name
- Add special instructions (e.g. "we don't take reservations for parties under 2")

---

## File Structure

```
restaurant-ai/
├── server.js          # Main app — all routes and logic
├── package.json       # Dependencies
├── .env.example       # Environment variable template
├── .gitignore         # Keeps secrets out of GitHub
└── README.md          # This file
```

---

## Cost Estimate (Monthly)

| Service | Cost |
|---|---|
| Railway | Free ($5 credit/mo included) |
| Twilio phone number | ~$1.15/mo |
| Twilio per-call | ~$0.014/min |
| Claude API (claude-sonnet) | ~$0.003 per reservation call |
| Yelp Guest Manager | Contact Yelp for pricing |
| **Total for ~100 calls/mo** | **~$5–10/mo** |
