#!/usr/bin/env node

// Crow Telegram Bot
// Bridges messages between Telegram and Gas Town's gt mail system.
//
// Inbound:  Telegram message -> gt mail send mayor/ -s "..." --stdin
// Outbound: Poll crow/ inbox  -> forward new messages to Telegram
//
// Env vars:
//   TELEGRAM_BOT_TOKEN  — required, from BotFather
//   TELEGRAM_CHAT_ID    — required, the chat to bridge messages to/from
//   POLL_INTERVAL_MS    — optional, inbox poll interval (default: 15000)

const { Bot } = require("grammy");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("TELEGRAM_CHAT_ID is required");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// Track seen mail IDs to avoid re-sending
const seenMailIds = new Set();

// --- Helpers ---

async function gtMailSend(target, subject, body) {
  const proc = execFileAsync("gt", ["mail", "send", target, "-s", subject, "--stdin"], {
    timeout: 30000,
  });
  proc.child.stdin.write(body);
  proc.child.stdin.end();
  const { stdout, stderr } = await proc;
  if (stderr) console.error("gt mail send stderr:", stderr);
  return stdout.trim();
}

async function gtMailInbox() {
  const { stdout } = await execFileAsync("gt", ["mail", "inbox", "--json"], {
    timeout: 30000,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    // Fallback: parse text output if --json not supported
    return null;
  }
}

async function gtMailRead(id) {
  const { stdout } = await execFileAsync("gt", ["mail", "read", id], {
    timeout: 30000,
  });
  return stdout.trim();
}

// --- Inbound: Telegram -> gt mail ---

bot.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (chatId !== CHAT_ID) {
    console.log(`Ignoring message from unauthorized chat ${chatId}`);
    return;
  }

  const from = ctx.from?.first_name || ctx.from?.username || "unknown";
  const text = ctx.message.text;
  const subject = `Telegram from ${from}: ${text.slice(0, 60)}`;

  try {
    await gtMailSend("mayor/", subject, text);
    console.log(`Forwarded to mayor: "${subject}"`);
  } catch (err) {
    console.error("Failed to forward message to mayor:", err.message);
    await ctx.reply("Failed to deliver message to Gas Town. Error logged.");
  }
});

// --- Outbound: Poll inbox -> Telegram ---

async function pollInbox() {
  try {
    const messages = await gtMailInbox();

    if (messages === null) {
      // --json not supported, use text parsing
      await pollInboxText();
      return;
    }

    if (!Array.isArray(messages) || messages.length === 0) return;

    for (const msg of messages) {
      const id = msg.id || msg.bead_id;
      if (!id || seenMailIds.has(id)) continue;
      seenMailIds.add(id);

      if (msg.read) continue; // skip already-read messages

      const body = await gtMailRead(id);
      const sender = msg.from || msg.sender || "unknown";
      const subject = msg.subject || "(no subject)";
      const text = `*${escapeMarkdown(sender)}*: ${escapeMarkdown(subject)}\n\n${escapeMarkdown(body)}`;

      await bot.api.sendMessage(CHAT_ID, text, { parse_mode: "MarkdownV2" });
      console.log(`Sent to Telegram: [${id}] ${subject}`);
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }
}

async function pollInboxText() {
  try {
    const { stdout } = await execFileAsync("gt", ["mail", "inbox"], {
      timeout: 30000,
    });

    // Parse lines like: "  cr-abc  UNREAD  From: crow/witness  Subject: ..."
    const lines = stdout.split("\n").filter((l) => l.trim() && !l.includes("Inbox:") && !l.includes("(no messages)"));

    for (const line of lines) {
      // Extract bead ID (first word-like token with a dash)
      const idMatch = line.match(/\b([a-z]{2,}-[a-z0-9]+)\b/);
      if (!idMatch) continue;
      const id = idMatch[1];

      if (seenMailIds.has(id)) continue;
      seenMailIds.add(id);

      if (!line.includes("UNREAD") && !line.includes("unread")) continue;

      const body = await gtMailRead(id);
      const subjectMatch = line.match(/Subject:\s*(.+)/i) || line.match(/\b[A-Z][A-Z]+:?\s+(.+)/);
      const subject = subjectMatch ? subjectMatch[1].trim() : "(mail)";

      const text = `*Mail*: ${escapeMarkdown(subject)}\n\n${escapeMarkdown(body)}`;

      await bot.api.sendMessage(CHAT_ID, text, { parse_mode: "MarkdownV2" });
      console.log(`Sent to Telegram: [${id}] ${subject}`);
    }
  } catch (err) {
    console.error("Text poll error:", err.message);
  }
}

function escapeMarkdown(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// --- Lifecycle ---

async function seedSeenMails() {
  // Mark all current inbox messages as "seen" so we don't replay history on startup
  try {
    const messages = await gtMailInbox();
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const id = msg.id || msg.bead_id;
        if (id) seenMailIds.add(id);
      }
    } else {
      // Text fallback
      const { stdout } = await execFileAsync("gt", ["mail", "inbox"], { timeout: 30000 });
      const ids = stdout.match(/\b([a-z]{2,}-[a-z0-9]+)\b/g) || [];
      for (const id of ids) seenMailIds.add(id);
    }
    console.log(`Seeded ${seenMailIds.size} existing mail IDs`);
  } catch (err) {
    console.error("Seed error:", err.message);
  }
}

let pollTimer;

async function start() {
  console.log("Crow Telegram Bot starting...");
  console.log(`Chat ID: ${CHAT_ID}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);

  await seedSeenMails();

  bot.start({
    onStart: () => console.log("Bot connected to Telegram"),
  });

  pollTimer = setInterval(pollInbox, POLL_INTERVAL);
}

function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  clearInterval(pollTimer);
  bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
