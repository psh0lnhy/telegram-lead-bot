#!/usr/bin/env node
/**
 * LeadCatcher — a Telegram bot that collects leads and stores them in Google Sheets.
 *
 * Zero dependencies: uses the Telegram Bot API over HTTPS and Node's built-in fetch.
 * Requires Node.js 18+.
 *
 * Flow: /start → service → name → contact → comment → confirmation → saved.
 *
 * Configuration (.env):
 *   BOT_TOKEN          — token from @BotFather (required)
 *   ADMIN_CHAT_ID      — chat id that receives a notification for every lead (optional)
 *   SHEETS_WEBHOOK_URL — Google Apps Script web app URL (optional; otherwise leads.jsonl)
 *   SHEETS_TOKEN       — shared secret checked by the Apps Script (optional)
 */

"use strict";

const fs = require("fs");
const path = require("path");

/* ------------------------------ config ------------------------------ */

// Minimal .env loader so the project stays dependency-free.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || line.trim().startsWith("#")) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

loadEnv(path.join(__dirname, ".env"));

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || "";
const SHEETS_TOKEN = process.env.SHEETS_TOKEN || "";
const LEADS_FILE = path.join(__dirname, "leads.jsonl");

if (!TOKEN) {
  console.error("BOT_TOKEN is missing. Copy .env.example to .env and paste the token from @BotFather.");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

/* --------------------------- Telegram API --------------------------- */

async function call(method, payload, attempt = 1) {
  let response;
  try {
    response = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Transient socket errors happen on long-poll connections; retry a couple of times.
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      return call(method, payload, attempt + 1);
    }
    error.cause = error.cause || {};
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`${method}: ${data.description || response.status}`);
  }
  return data.result;
}

const send = (chatId, text, extra = {}) =>
  call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });

const edit = (chatId, messageId, text, extra = {}) =>
  call("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra });

const answerCallback = (id, text) => call("answerCallbackQuery", { callback_query_id: id, text }).catch(() => {});

/* ------------------------------ content ----------------------------- */

const SERVICES = [
  { key: "website", label: "🌐 Website" },
  { key: "bot", label: "🤖 Telegram bot" },
  { key: "automation", label: "⚙️ Automation" },
  { key: "other", label: "✳️ Something else" },
];

const serviceLabel = (key) => SERVICES.find((s) => s.key === key)?.label || key;

const serviceKeyboard = {
  inline_keyboard: SERVICES.map((s) => [{ text: s.label, callback_data: `svc:${s.key}` }]),
};

const confirmKeyboard = (token) => ({
  inline_keyboard: [
    [{ text: "✅ Send request", callback_data: `lead:save:${token}` }],
    [{ text: "✏️ Start over", callback_data: "lead:restart" }],
  ],
});

const WELCOME =
  "<b>Hi!</b> I collect requests for the team — it takes about 30 seconds.\n\n" +
  "What can we help you with?";

const CANCEL_HINT = "\n\n<i>Send /cancel to start over.</i>";

/* ------------------------------ state ------------------------------- */

/** chatId → { step, data, messageId, token } */
const sessions = new Map();

const newSession = () => ({
  step: "service",
  data: { service: "", name: "", contact: "", comment: "" },
  messageId: null,
  token: Math.random().toString(36).slice(2, 8),
});

/* ------------------------------ storage ----------------------------- */

async function saveLead(lead) {
  // 1. Google Sheets via an Apps Script web app (see google-apps-script.js).
  if (SHEETS_WEBHOOK_URL) {
    const response = await fetch(SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: SHEETS_TOKEN, lead }),
    });
    if (!response.ok) throw new Error(`Sheets webhook responded ${response.status}`);
    return "sheets";
  }

  // 2. Fallback: append locally so the bot works before Sheets is connected.
  fs.appendFileSync(LEADS_FILE, JSON.stringify(lead) + "\n", "utf8");
  return "file";
}

function countLeads() {
  if (!fs.existsSync(LEADS_FILE)) return 0;
  return fs.readFileSync(LEADS_FILE, "utf8").split("\n").filter(Boolean).length;
}

/* ------------------------------ helpers ----------------------------- */

const escapeHtml = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const isPhone = (value) => /^\+?[\d\s()-]{7,20}$/.test(value);
const isUsername = (value) => /^@[a-zA-Z0-9_]{4,32}$/.test(value);

function summary(session) {
  const { service, name, contact, comment } = session.data;
  return (
    "<b>Check your request:</b>\n\n" +
    `Service: <b>${escapeHtml(serviceLabel(service))}</b>\n` +
    `Name: <b>${escapeHtml(name)}</b>\n` +
    `Contact: <b>${escapeHtml(contact)}</b>\n` +
    (comment ? `Comment: <i>${escapeHtml(comment)}</i>\n` : "") +
    `\nLead ID: <code>${session.token}</code>`
  );
}

/* ------------------------------ flow -------------------------------- */

async function askService(chatId) {
  const session = newSession();
  sessions.set(chatId, session);
  const message = await send(chatId, WELCOME, { reply_markup: serviceKeyboard });
  session.messageId = message.message_id;
}

async function startName(chatId, session, serviceKey) {
  session.data.service = serviceKey;
  session.step = "name";
  await edit(
    chatId,
    session.messageId,
    `Service: <b>${escapeHtml(serviceLabel(serviceKey))}</b>\n\nWhat's your name?` + CANCEL_HINT,
    { reply_markup: { inline_keyboard: [] } }
  );
}

async function startContact(chatId, session, name) {
  session.data.name = name;
  session.step = "contact";
  await send(chatId, "How can we reach you? Phone number or @username." + CANCEL_HINT);
}

async function startComment(chatId, session, contact) {
  session.data.contact = contact;
  session.step = "comment";
  await send(
    chatId,
    "Anything else we should know?\n<i>One or two sentences, or send /skip.</i>",
    { reply_markup: { inline_keyboard: [[{ text: "Skip", callback_data: "lead:skip" }]] } }
  );
}

async function askConfirm(chatId, session, comment) {
  session.data.comment = comment;
  session.step = "confirm";
  await send(chatId, summary(session), { reply_markup: confirmKeyboard(session.token) });
}

async function finishLead(chatId, session) {
  const lead = {
    id: session.token,
    createdAt: new Date().toISOString(),
    service: session.data.service,
    serviceLabel: serviceLabel(session.data.service),
    name: session.data.name,
    contact: session.data.contact,
    comment: session.data.comment,
    chatId: String(chatId),
    username: session.username || "",
  };

  let storage;
  try {
    storage = await saveLead(lead);
  } catch (error) {
    console.error("saveLead failed:", error.message);
    await send(chatId, "Sorry — couldn't save the request. Please try again in a minute.");
    return;
  }

  sessions.delete(chatId);
  await send(
    chatId,
    `✅ <b>Done!</b> Your request <code>${lead.id}</code> is in.\n\n` +
      "We'll get back to you within one business day."
  );

  if (ADMIN_CHAT_ID) {
    const text =
      "🔔 <b>New lead</b>\n\n" +
      `Service: <b>${escapeHtml(lead.serviceLabel)}</b>\n` +
      `Name: ${escapeHtml(lead.name)}\n` +
      `Contact: ${escapeHtml(lead.contact)}\n` +
      (lead.comment ? `Comment: ${escapeHtml(lead.comment)}\n` : "") +
      `Stored: ${storage}\n` +
      `ID: <code>${lead.id}</code>`;
    send(ADMIN_CHAT_ID, text).catch((error) => console.error("admin notify failed:", error.message));
  }

  console.log(`lead ${lead.id} saved (${storage})`);
}

/* ----------------------------- handlers ----------------------------- */

async function onMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const session = sessions.get(chatId);

  if (!text) {
    await send(chatId, "I work with text messages. Send /start to begin.");
    return;
  }

  if (text === "/start") {
    await askService(chatId);
    return;
  }

  if (text === "/cancel") {
    sessions.delete(chatId);
    await send(chatId, "Cancelled. Send /start whenever you're ready.");
    return;
  }

  if (text === "/help") {
    await send(
      chatId,
      "<b>Commands</b>\n/start — new request\n/cancel — reset\n/stats — leads collected\n/help — this message"
    );
    return;
  }

  if (text === "/stats") {
    await send(chatId, `Leads collected: <b>${countLeads()}</b>.`);
    return;
  }

  if (!session) {
    await send(chatId, "Send /start to leave a request.");
    return;
  }

  session.username = message.from?.username || "";

  switch (session.step) {
    case "name": {
      if (text.length < 2) {
        await send(chatId, "That looks too short. What's your name?");
        return;
      }
      await startContact(chatId, session, text);
      return;
    }
    case "contact": {
      if (!isPhone(text) && !isUsername(text)) {
        await send(chatId, "Please send a phone number (e.g. +48 500 123 456) or an @username.");
        return;
      }
      await startComment(chatId, session, text);
      return;
    }
    case "comment": {
      await askConfirm(chatId, session, text);
      return;
    }
    default:
      await send(chatId, "Send /start to leave a request, or /cancel to reset.");
  }
}

async function onCallback(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data || "";
  const session = sessions.get(chatId);

  await answerCallback(query.id);

  if (data === "lead:restart") {
    sessions.delete(chatId);
    await askService(chatId);
    return;
  }

  if (!session) {
    await send(chatId, "This form has expired. Send /start to begin again.");
    return;
  }

  if (data.startsWith("svc:")) {
    await startName(chatId, session, data.slice(4));
    return;
  }

  if (data === "lead:skip") {
    await askConfirm(chatId, session, "");
    return;
  }

  if (data === "lead:save") {
    // Ignore taps on an old confirmation screen.
    if (session.step !== "confirm") return;
    await finishLead(chatId, session);
    return;
  }

  if (data.startsWith("lead:save:")) {
    const token = data.split(":")[2];
    if (session.step !== "confirm" || token !== session.token) {
      await send(chatId, "This form has expired. Send /start to begin again.");
      return;
    }
    await finishLead(chatId, session);
  }
}

/* ------------------------------ polling ----------------------------- */

async function poll() {
  let offset = 0;
  let backoff = 1000;

  for (;;) {
    try {
      const updates = await call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
      backoff = 1000;

      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          if (update.message) await onMessage(update.message);
          else if (update.callback_query) await onCallback(update.callback_query);
        } catch (error) {
          console.error("update failed:", error.message, error.cause?.code || error.cause?.message || "");
        }
      }
    } catch (error) {
      console.error("polling error:", error.message);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

async function main() {
  const me = await call("getMe").catch((error) => {
    console.error("Could not reach Telegram:", error.message);
    process.exit(1);
  });

  console.log(`@${me.username} is running. Press Ctrl+C to stop.`);
  await poll();
}

main();
