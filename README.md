# AcadAlert

A monitor bot that surfaces academic announcements buried in busy WhatsApp group chats and DMs, extracts the key event details with Gemini, and redirects them to your personal DMs on WhatsApp and Telegram.

## The problem

Lecture changes, test dates, deadlines, and venue updates get posted in dozens of class and department groups. They scroll past within minutes and are easy to miss. AcadAlert listens on your behalf and only forwards what matters.

## How it works

```
WhatsApp groups / DMs
        │  (secondary WhatsApp number joined to the groups)
        ▼
  whatsapp-web.js listener
        │
        ▼
  Keyword filter ──► (no match: ignored)
        │
        ▼
  Dedup gate (in-memory FIFO Map)
        │
        ▼
  Gemini (gemini-2.5-flash): extract event info
        │
        ├──► Telegram Bot ──► your DM
        ├──► WhatsApp ──────► your main number
        └──► alerts.ndjson (local log)
```

1. A **secondary WhatsApp number** acts as the bot account and is added to the groups you want monitored.
2. Incoming messages pass a **keyword filter** (exam, test, deadline, lecture, etc.). Non-academic chatter is dropped.
3. Matches go through a **dedup gate** so the same announcement reposted across groups alerts you once. The cache evicts oldest-first (FIFO).
4. Gemini **extracts structured event details** (what, when, where). If Gemini is unavailable, the alert degrades gracefully and still sends the raw message.
5. The alert is **delivered to your DMs** via Telegram (HTML parse mode, sanitized) and WhatsApp, and appended to `alerts.ndjson`.

## Stack

- Node.js (CommonJS)
- [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) for WhatsApp session and message events
- [`@google/genai`](https://www.npmjs.com/package/@google/genai) (Gemini) for event extraction
- Telegram Bot API for delivery
- [`qrcode-terminal`](https://www.npmjs.com/package/qrcode-terminal) for WhatsApp login
- [`dotenv`](https://www.npmjs.com/package/dotenv) for configuration

## Project structure

| File | Purpose |
|---|---|
| `index.js` | Bot entry point: listener, filtering, dedup, extraction, delivery |
| `test.js` | Test script |
| `alerts.ndjson` | Append-only log of alerts, one JSON object per line |
| `alerts.json` | Alert data snapshot |
| `package.json` | Dependencies and metadata |
| `.gitignore` | Excludes secrets and session data |

## Getting started

### Prerequisites

- Node.js 18+
- A **secondary WhatsApp number** for the bot (do not use your main number)
- A Telegram bot token from [@BotFather](https://t.me/BotFather) and your Telegram chat ID
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/)

### Install

```bash
git clone https://github.com/theRealNexa/AcadAlert.git
cd AcadAlert
npm install
```

On Termux or other constrained environments, install with `npm install --ignore-scripts`.

### Configure

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_gemini_key
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

> Variable names above are illustrative. Match them to the names read in `index.js`.

### Run

```bash
node index.js
```

On first launch a QR code prints in the terminal. Scan it from the secondary WhatsApp number (Linked Devices). The session persists for later runs. Then add that number to the groups you want monitored.

## Alert log

Every alert is appended to `alerts.ndjson`:

```json
{"timestamp":"...","group":"...","message":"...","event":{"title":"...","date":"...","venue":"..."}}
```

NDJSON keeps writes append-only and easy to stream or grep. Field names above are illustrative.

## Design decisions

- **Secondary number as bot account** isolates the bot from your main WhatsApp account.
- **Keyword gate before dedup** keeps the dedup cache small and cheap.
- **Graceful Gemini degradation** means a failed API call never drops an alert.
- **Dual delivery** (Telegram and WhatsApp) gives redundancy if one channel fails.
- **Local NDJSON logging** keeps the MVP frontend-free with no database.

## Limitations

- Requires an always-on machine and internet. Telegram delivery is passive, not offline.
- `whatsapp-web.js` is unofficial and automates WhatsApp Web, so account restrictions are possible. Use a disposable number.
- Dedup state is in memory and resets on restart.
- No frontend; alerts live in Telegram, WhatsApp, and the local log.

## Roadmap

- Always-on hosting (Oracle Cloud Free Tier ARM VPS)
- Persistent dedup store
- Configurable keyword lists and per-group rules
- Dashboard over `alerts.ndjson`

## License

ISC (per `package.json`). Add a `LICENSE` file to match.
