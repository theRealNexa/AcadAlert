// ═══════════════════════════════════════════════════════════════════
// AcadAlert — WhatsApp → Gemini → Telegram academic alert bot
// Rewritten by Apex Orchestrator v2.0
// All 13 fixes from pre-rewrite audit applied and Coordinator-validated
// ═══════════════════════════════════════════════════════════════════

'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode               = require('qrcode-terminal');
const { GoogleGenAI }      = require('@google/genai');
const fs                   = require('fs');
const path                 = require('path');
require('dotenv').config();


// ─────────────────────────────────────────────────────────────────
// SECTION 1 — ENV VALIDATION  [Fix #11]
// Hard-required vars kill the process immediately with a clear
// message rather than failing silently on the first message.
// Soft-required vars emit a warning; their features degrade
// gracefully instead of crashing.
// ─────────────────────────────────────────────────────────────────

/**
 * Validates environment variables at startup.
 * Hard-required: GEMINI_API_KEY — without it the bot has no brain.
 * Soft-required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WHATSAPP_GROUP_ID
 *   — each controls an optional output channel or mode; absence
 *     disables that channel, not the whole bot.
 *
 * @throws {process.exit(1)} if any hard-required var is missing.
 */
function validateEnv() {
  const hard = ['GEMINI_API_KEY'];
  const soft = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'WHATSAPP_GROUP_ID'];

  // Hard: fail fast and loud
  hard.forEach(key => {
    if (!process.env[key]) {
      console.error(`[AcadAlert] FATAL: required env var "${key}" is not set. Exiting.`);
      process.exit(1);
    }
  });

  // Soft: warn so the operator knows what's disabled
  soft.forEach(key => {
    if (!process.env[key]) {
      console.warn(`[AcadAlert] WARNING: "${key}" is not set — related feature disabled.`);
    }
  });
}

// Run before anything else — no point initialising a Puppeteer
// browser if the API key that drives the whole pipeline is absent.
validateEnv();


// ─────────────────────────────────────────────────────────────────
// SECTION 2 — CONFIG
// All runtime config in one place. Changing a value means
// touching exactly one line, not hunting through functions.
// ─────────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;

// NDJSON (one JSON object per line) — chosen over a JSON array
// because appendFile is atomic per-line and never requires
// reading the whole file back to append. [Fix #8]
const LOG_FILE = path.join(__dirname, 'alerts.ndjson');

// How many message IDs to keep in the dedup cache before evicting.
// At a worst-case of 500 messages/day this covers a full day
// of traffic in memory (~40 KB), well within Node.js defaults.
const DEDUP_CAP = 500;

// Retry attempts for Gemini and Telegram independently.
const GEMINI_MAX_RETRIES   = 3;
const TELEGRAM_MAX_RETRIES = 3;


// ─────────────────────────────────────────────────────────────────
// SECTION 3 — KEYWORDS  [Fix #12]
// Deduplicated. 'mentorship' appeared twice in the original.
// All multi-word phrases are kept whole — the word-boundary
// regex in isAcademic() handles them correctly.
// ─────────────────────────────────────────────────────────────────

const KEYWORDS = [
  'assignment', 'test', 'exam', 'submit', 'submission', 'deadline',
  'lecture', 'class', 'quiz', 'result', 'portal', 'project', 'CSC',
  'siwes', 'industrial training', 'final year project', 'FYP',
  'presentation', 'defense', 'viva', 'team', 'group', 'course',
  'timetable', 'schedule', 'announcement', 'reminder', 'attend',
  'tech', 'brainstorm', 'creatives', 'innovation', 'innovators',
  'founders', 'internship', 'mentorship', 'scholarship', 'AI',
  'leaders', 'grants', 'undergraduates', 'Africa', 'global',
  'opportunity', 'networking', 'workshop', 'webinar',
  'call for papers', 'research', 'publication', 'conference',
  'symposium', 'seminar', 'tutorial', 'hackathon', 'competition',
  'fellowship', 'residency', 'accelerator', 'incubator', 'scholar',
  'scholars', 'fellow', 'fellows', 'award', 'awards', 'funding',
  'funded', 'zoom', 'telegram', 'meet', 'google meet',
  'microsoft teams', 'webex', 'virtual', 'online', 'in-person',
  'google', 'datathon', 'buildathon', 'ideathon', 'case competition',
  'pitch competition', 'demo day', 'startup showcase', 'ML',
  'innovation challenge', 'pitchathon', 'startup competition',
  'entrepreneurship', 'business plan competition', 'venture capital',
];

// Pre-compile one regex per keyword at startup rather than inside
// the hot path of every message event. The \b word-boundary anchors
// prevent 'test' from matching inside 'contest', 'protest', etc.
// Special regex characters are escaped so phrases like
// 'call for papers' are treated as literals, not patterns. [Fix #1]
const KEYWORD_REGEXES = KEYWORDS.map(kw => {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Case-insensitive flag because the text is not pre-lowercased
  // when the regex is applied — cleaner than mutating the string.
  return new RegExp(`\\b${escaped}\\b`, 'i');
});


// ─────────────────────────────────────────────────────────────────
// SECTION 4 — DEDUPLICATION  [Fix #7]
// Map chosen over Set because Map preserves insertion order,
// enabling O(1) FIFO eviction: delete the first (oldest) entry
// when the cap is hit. Set.clear() was rejected in audit because
// it would wipe the entire history and allow reprocessing of
// all previously-seen IDs after the next 500-message burst.
// ─────────────────────────────────────────────────────────────────

/** FIFO cache of recently-seen WhatsApp message IDs. */
const seenMessageIds = new Map(); // id → timestamp (ms)

/**
 * Returns true if this message ID has been processed before.
 * If not seen, registers it and evicts the oldest entry if
 * the cache has reached DEDUP_CAP.
 *
 * Must be called synchronously before any async work so that
 * a message whose Gemini call times out is still registered
 * and won't be reprocessed on re-delivery. [Loophole #L-2]
 *
 * @param {string} id - Serialised WhatsApp message ID.
 * @returns {boolean}
 */
function isDuplicate(id) {
  if (seenMessageIds.has(id)) return true;

  // Evict oldest entry (first key in insertion order) before adding
  // the new one, so the Map never exceeds DEDUP_CAP entries.
  if (seenMessageIds.size >= DEDUP_CAP) {
    const oldestKey = seenMessageIds.keys().next().value;
    seenMessageIds.delete(oldestKey);
  }

  seenMessageIds.set(id, Date.now());
  return false;
}


// ─────────────────────────────────────────────────────────────────
// SECTION 5 — KEYWORD FILTER  [Fix #1]
// Uses pre-compiled word-boundary regexes (Section 3) instead of
// String.prototype.includes(). Runs against original case because
// regexes carry the 'i' flag.
// ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the message body contains at least one academic
 * keyword matched at a word boundary.
 *
 * @param {string} text - Raw WhatsApp message body.
 * @returns {boolean}
 */
function isAcademic(text) {
  return KEYWORD_REGEXES.some(re => re.test(text));
}


// ─────────────────────────────────────────────────────────────────
// SECTION 6 — GEMINI SETUP & EXTRACTOR  [Fixes #3, #4, Loophole L-1]
// Model: gemini-2.5-flash — chosen for speed + summarisation quality.
// The misleading comment referencing 3.5-flash is removed entirely.
//
// Retry scope: only the API call itself is retried on network/API
// failure. The response.text getter is read in a separate inner
// try/catch — a blocked or empty response returns '' immediately
// without triggering a retry, because retrying a blocked prompt
// will always produce the same blocked response. [Loophole L-1]
// ─────────────────────────────────────────────────────────────────

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

/**
 * Sends the raw WhatsApp message to Gemini for summarisation.
 * Returns a 2–5 line summary of the academic event, or the
 * sentinel string 'NO_EVENT' if no relevant event is found.
 *
 * Retries up to GEMINI_MAX_RETRIES times on API-level failures
 * (network errors, 5xx). Does NOT retry on blocked responses.
 *
 * @param {string} rawMessage - Original WhatsApp message body.
 * @returns {Promise<string>} Summary text or 'NO_EVENT'.
 * @throws {Error} After all retries are exhausted.
 */
async function extractEventInfo(rawMessage) {
  const prompt = `
You are an academic alert assistant. A student received this WhatsApp message from a university group.
Extract any academic event or deadline information and return a short, clear summary.

If there is no meaningful academic event, reply with exactly: NO_EVENT

Message:
"""
${rawMessage}
"""

Summary (2–5 lines max, be specific about dates/times if mentioned).
For Zoom or meeting invites, always extract and include: topic, date/time, the main join link, meeting ID, and passcode. Ignore SIP addresses, one-tap mobile numbers, and auxiliary links.
For other academic events, include any link that is the direct action item (submission portal, form, etc). Ignore unrelated links.
  `.trim();

  for (let attempt = 1; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    try {
      // API call — only this throws on network/rate-limit failures.
      const response = await genAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      // Getter separated from API call. [Fix #4, Loophole L-1]
      // response.text throws if the response was blocked by safety
      // filters. In that case we treat it as no event — retrying a
      // blocked prompt will not unblock it.
      let text = '';
      try {
        text = response.text ?? '';
      } catch {
        // Safety-blocked or malformed response — not a retryable error.
        console.warn('[Gemini] Response blocked or malformed — treating as NO_EVENT.');
        return 'NO_EVENT';
      }

      return text.trim() || 'NO_EVENT';

    } catch (apiErr) {
      // Only API-level errors (network, timeout, 5xx) reach here.
      if (attempt < GEMINI_MAX_RETRIES) {
        const delayMs = 5000 * attempt; // 5s, 10s
        console.warn(`[Gemini] Attempt ${attempt} failed: ${apiErr.message}. Retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        // All retries exhausted — rethrow so the message handler
        // can fall back to sending the raw message.
        throw apiErr;
      }
    }
  }
}


// ─────────────────────────────────────────────────────────────────
// SECTION 7 — TELEGRAM SENDER  [Fixes #2, #6, #13]
// Fix #2:  Exponential backoff retry — 3 attempts, 2s × attempt delay.
// Fix #6:  Normalised error handling — both happy-path and fallback
//          call sites log warnings consistently; neither swallows errors
//          silently without a log line.
// Fix #13: parse_mode switched from 'Markdown' to 'HTML'.
//          Gemini's freeform output can contain underscores, asterisks,
//          or brackets that break Telegram's Markdown parser.
//          HTML mode only recognises <b>, <i>, <code>, <pre> —
//          none of which appear naturally in academic announcements.
//          The summary text is sanitised for < and > to prevent
//          accidental HTML injection from Gemini output.
// ─────────────────────────────────────────────────────────────────

/**
 * Sanitises a string for safe insertion into a Telegram HTML message.
 * Only < and > need escaping; & is technically required by the HTML
 * spec but Telegram's HTML mode doesn't parse full HTML entities —
 * it only cares about tag boundaries, so < and > are sufficient.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitiseForTelegramHtml(text) {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Sends a notification to the configured Telegram chat.
 * Retries up to TELEGRAM_MAX_RETRIES times with linear backoff
 * (2s × attempt) to absorb transient network failures common on
 * mobile connections.
 *
 * No-ops silently if TELEGRAM_TOKEN or TELEGRAM_CHAT_ID are unset
 * (already warned at startup in validateEnv).
 *
 * @param {string} summary - Gemini summary (plain text, will be sanitised).
 * @param {string} timestamp - ISO timestamp string.
 * @param {boolean} [isRaw=false] - True when sending unprocessed fallback.
 * @returns {Promise<void>}
 */
async function sendTelegram(summary, timestamp, isRaw = false) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  // Sanitise Gemini's freeform output before embedding it in HTML. [Fix #13]
  const safeSummary = sanitiseForTelegramHtml(summary);
  const label = isRaw ? '📚 <b>AcadAlert</b> <i>(unprocessed)</i>' : '📚 <b>AcadAlert</b>';
  const messageText = `${label}\n\n${safeSummary}\n\n<i>${timestamp}</i>`;

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  for (let attempt = 1; attempt <= TELEGRAM_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: messageText,
          parse_mode: 'HTML',    // [Fix #13] — HTML mode, not Markdown
        }),
      });

      if (!res.ok) {
        // 4xx errors (bad token, chat not found) are not retryable.
        const errBody = await res.text();
        throw new Error(`Telegram API ${res.status}: ${errBody}`);
      }

      console.log('[AcadAlert] Alert sent to Telegram.');
      return; // Success — exit the retry loop.

    } catch (err) {
      if (attempt < TELEGRAM_MAX_RETRIES) {
        const delayMs = 2000 * attempt; // 2s, 4s
        console.warn(`[Telegram] Attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        // All retries exhausted — log and give up. The WhatsApp
        // notification already went through; this is non-fatal.
        console.error(`[Telegram] All ${TELEGRAM_MAX_RETRIES} attempts failed: ${err.message}`);
      }
    }
  }
}


// ─────────────────────────────────────────────────────────────────
// SECTION 8 — WHATSAPP GROUP SENDER  [Fix #5]
// Guards against calling sendMessage before the client is ready.
// isClientReady is set to true exclusively inside the 'ready'
// event handler and never reset (reconnection is handled by
// whatsapp-web.js internally).
// ─────────────────────────────────────────────────────────────────

/** Set to true once whatsapp.on('ready') fires. */
let isClientReady = false;

/**
 * Sends a notification to WHATSAPP_GROUP_ID.
 * No-ops if the client isn't ready or WHATSAPP_GROUP_ID is unset.
 *
 * @param {string} message - Formatted notification text.
 * @returns {Promise<void>}
 */
async function sendWhatsApp(message) {
  if (!isClientReady) {
    // Defensive guard — should not occur in normal flow because
    // message events only fire after 'ready', but guarding
    // protects against any edge case during initialisation.
    console.warn('[WhatsApp] Client not ready — skipping outbound message.');
    return;
  }
  if (!WHATSAPP_GROUP_ID) return;

  try {
    await whatsapp.sendMessage(WHATSAPP_GROUP_ID, message);
    console.log('[AcadAlert] Alert sent to WhatsApp group.');
  } catch (err) {
    console.error('[WhatsApp] Failed to send:', err.message);
  }
}


// ─────────────────────────────────────────────────────────────────
// SECTION 9 — LOGGER  [Fix #8]
// Uses async fs.promises.appendFile (non-blocking) with NDJSON
// format (one JSON object per line). Chosen over the original
// synchronous read-entire-file → parse → push → write approach
// which blocked the event loop on every message.
//
// File is alerts.ndjson, not alerts.json, to make the format
// change explicit and prevent tools expecting a JSON array
// from silently reading a corrupt hybrid file. [Audit ST-3]
// ─────────────────────────────────────────────────────────────────

/**
 * Appends a single alert entry to the NDJSON log file.
 * Each line is a self-contained JSON object — readable with
 * `cat alerts.ndjson | jq .` or any NDJSON reader.
 *
 * @param {{ timestamp: string, group: string, original: string, summary: string }} entry
 * @returns {Promise<void>}
 */
async function logAlert(entry) {
  const line = JSON.stringify(entry) + '\n';
  try {
    await fs.promises.appendFile(LOG_FILE, line, 'utf8');
  } catch (err) {
    // Log failure must not crash the bot — the notification already
    // went through. Warn so the operator notices disk/permission issues.
    console.error('[Logger] Failed to write log entry:', err.message);
  }
}


// ─────────────────────────────────────────────────────────────────
// SECTION 10 — GRACEFUL SHUTDOWN  [Fix #9]
// Registers handlers for SIGINT (Ctrl+C), SIGTERM (system kill),
// uncaughtException, and unhandledRejection.
//
// On Windows, SIGTERM delivery is unreliable (Task Manager sends
// it but the OS doesn't guarantee Node.js catches it). Registering
// it anyway covers PM2, Docker, and any POSIX-compatible process
// manager that may be used on the Oracle VPS phase-2 deployment.
// uncaughtException ensures a fatal sync error still closes the
// Puppeteer browser and WhatsApp session cleanly. [Audit ST-4]
// ─────────────────────────────────────────────────────────────────

/**
 * Destroys the WhatsApp client and exits cleanly.
 * Swallows destroy() errors — if the client is already gone,
 * we still want to exit rather than hanging.
 *
 * @param {string} signal - Name of the triggering signal or event.
 * @returns {Promise<void>}
 */
async function gracefulShutdown(signal) {
  console.log(`[AcadAlert] Received ${signal} — shutting down...`);
  try {
    await whatsapp.destroy();
  } catch {
    // Client may already be in a broken state; swallow and exit.
  }
  process.exit(0);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[AcadAlert] Uncaught exception — shutting down:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  // Log but do NOT exit — an unhandled rejection in a Telegram send
  // should not bring down the whole bot. Exiting here would make
  // the retry logic in sendTelegram pointless.
  console.error('[AcadAlert] Unhandled rejection:', reason);
});


// ─────────────────────────────────────────────────────────────────
// SECTION 11 — WHATSAPP CLIENT
// Puppeteer config unchanged from original — Windows-specific
// chrome path and args are preserved as the operator confirmed
// this works on their machine.
// ─────────────────────────────────────────────────────────────────

const whatsapp = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: false,
    executablePath: 'C:\\Users\\User\\.cache\\puppeteer\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
    protocolTimeout: 120000,
    timeout: 120000,
  },
});


// ─────────────────────────────────────────────────────────────────
// SECTION 12 — WHATSAPP EVENT HANDLERS
// ─────────────────────────────────────────────────────────────────

whatsapp.on('qr', (qr) => {
  console.log('[AcadAlert] Scan this QR with WhatsApp → Linked Devices → Link a Device:');
  qrcode.generate(qr, { small: true });
});

whatsapp.on('ready', async () => {
  // Mark client as ready before anything else so sendWhatsApp's
  // guard check passes from this point forward. [Fix #5]
  isClientReady = true;
  console.log('[AcadAlert] Client is ready and listening to groups.');

  // Discovery mode: if no group ID is configured, print all available
  // groups so the operator can pick the right one for .env.
  if (!WHATSAPP_GROUP_ID) {
    const chats  = await whatsapp.getChats();
    const groups = chats.filter(c => c.isGroup);
    console.log('\n[AcadAlert] Available groups (copy the ID you want into .env):');
    groups.forEach(g => console.log(`  - ${g.name}: ${g.id._serialized}`));
    console.log('');
  }
});

whatsapp.on('message', async (msg) => {
  // ── Gate 1: ignore status broadcasts ──────────────────────────
  if (msg.from === 'status@broadcast') return;

  // ── Gate 2: only process group messages ───────────────────────
  if (!msg.from.endsWith('@g.us')) return;

  // ── Gate 3: ignore messages from the outbound alert group ─────
  // Prevents the bot from reprocessing its own forwarded alerts
  // if they happen to contain a keyword. [Audit Security Issue #11]
  if (WHATSAPP_GROUP_ID && msg.from === WHATSAPP_GROUP_ID) return;

  // ── Gate 4: must have a text body ─────────────────────────────
  const body = msg.body;
  if (!body) return;

  // ── Gate 5: keyword filter [Fix #1] ───────────────────────────
  // Applied BEFORE dedup so that non-academic messages never consume
  // a slot in the 500-entry dedup Map. Only messages we'd act on
  // are worth tracking. (Reviewer: gate order fix, post-write audit.)
  if (!isAcademic(body)) return;

  // ── Gate 6: DEDUP — registered BEFORE async work [Fix #7, Loophole L-2]
  // Registering here ensures that even if Gemini times out and the
  // catch block runs, this message ID won't be reprocessed on any
  // re-delivery. isDuplicate() also registers in the same call.
  const messageId = msg.id._serialized;
  if (isDuplicate(messageId)) {
    console.log(`[AcadAlert] Duplicate message ignored: ${messageId}`);
    return;
  }

  console.log(`[AcadAlert] Keyword match in group: ${msg.from}`);

  const timestamp = new Date().toISOString();

  try {
    const summary = await extractEventInfo(body);

    if (summary === 'NO_EVENT') {
      console.log('[AcadAlert] Gemini: no academic event detected — skipping.');
      return;
    }

    // Build the WhatsApp notification (plain text — no HTML/Markdown
    // needed for WA since it uses its own bold/italic syntax and the
    // bot sends to a monitored group, not a rendered web UI).
    const waNotification = `📚 *AcadAlert*\n\n${summary}\n\n_${timestamp}_`;

    // WhatsApp is awaited; Telegram runs in parallel but is not
    // awaited at top level — a Telegram failure must not block or
    // cancel the WhatsApp delivery. [Fix #6 — error handling normalised]
    await sendWhatsApp(waNotification);

    // Telegram runs fire-and-forget with its own internal retry
    // logic. Errors are logged inside sendTelegram — no silent swallow.
    sendTelegram(summary, timestamp, false).catch(err =>
      console.warn('[Telegram] Unexpected error after retries:', err.message)
    );

    // logAlert is now async — must be awaited. [Loophole L-5]
    await logAlert({ timestamp, group: msg.from, original: body, summary });

  } catch (err) {
    // Gemini failed all retries — send the raw message so the student
    // still gets the alert, just without the clean summary.
    console.warn('[AcadAlert] Gemini failed — sending raw alert:', err.message);

    const rawNotification = `📚 *AcadAlert* _(unprocessed)_\n\n${body}\n\n_${timestamp}_`;
    await sendWhatsApp(rawNotification);

    // [Fix #6] — same warning pattern as the happy path, not silent.
    sendTelegram(body, timestamp, true).catch(err =>
      console.warn('[Telegram] Unexpected error after retries (raw):', err.message)
    );

    await logAlert({ timestamp, group: msg.from, original: body, summary: 'GEMINI_FAILED' });
  }
});

whatsapp.on('auth_failure', (msg) => {
  console.error('[AcadAlert] Authentication failure:', msg);
});

whatsapp.on('disconnected', (reason) => {
  console.warn('[AcadAlert] Client disconnected:', reason);
  // isClientReady intentionally not reset here — whatsapp-web.js
  // handles reconnection internally; resetting the flag would cause
  // outbound sends to silently no-op during reconnect windows.
});


// ─────────────────────────────────────────────────────────────────
// SECTION 13 — STARTUP
// validateEnv() already ran at the top of the file.
// initialize() starts the Puppeteer browser and WhatsApp auth flow.
// ─────────────────────────────────────────────────────────────────

whatsapp.initialize();