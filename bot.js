#!/usr/bin/env node

// Crow Telegram Bot
// Bridges messages between Telegram and Gas Town's gt mail system.
//
// Inbound:  Telegram message -> gt nudge mayor + gt mail (durable record)
// Outbound: HTTP API on CROW_PORT for instant delivery, mail poll as fallback
// Events:   Watches .events.jsonl for lifecycle events (done, sling, spawn)
//
// Env vars:
//   TELEGRAM_BOT_TOKEN  — required, from BotFather
//   TELEGRAM_CHAT_ID    — required, admin chat (receives all messages)
//   TELEGRAM_ADMIN_ID   — optional, admin chat ID (defaults to TELEGRAM_CHAT_ID)
//   CROW_PORT           — optional, HTTP API port (default: 3333)
//   POLL_INTERVAL_MS    — optional, inbox poll interval (default: 30000)
//   MAYOR_CHECK_INTERVAL_MS — optional, busy-mayor recheck interval (default: 15000)
//
// Chat permissions loaded from permissions.json (same directory as bot.js).
// Format: { "<chat_id>": { "role": "admin"|"user", "rigs": ["*"] | ["mealpal"] } }
// Chats not listed are ignored (unauthorized).

const { Bot } = require("grammy");
const { execFile } = require("child_process");
const { promisify } = require("util");
const http = require("http");
const fs = require("fs");
const path = require("path");

const execFileAsync = promisify(execFile);

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_ID || CHAT_ID;
const CROW_PORT = parseInt(process.env.CROW_PORT || "3333", 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);

// --- Chat permissions ---
const PERMISSIONS_FILE = path.join(__dirname, "permissions.json");

function loadPermissions() {
  try {
    return JSON.parse(fs.readFileSync(PERMISSIONS_FILE, "utf8"));
  } catch (err) {
    console.warn("Could not load permissions.json, falling back to admin-only:", err.message);
    // Fallback: only admin chat, full access
    return { [ADMIN_CHAT_ID]: { role: "admin", rigs: ["*"] } };
  }
}

let chatPermissions = loadPermissions();

function isAuthorized(chatId) {
  return chatId in chatPermissions;
}

function isAdmin(chatId) {
  const perm = chatPermissions[chatId];
  return perm && perm.role === "admin";
}

function getAllowedRigs(chatId) {
  const perm = chatPermissions[chatId];
  if (!perm) return [];
  return perm.rigs || [];
}

function hasRigAccess(chatId, rig) {
  const rigs = getAllowedRigs(chatId);
  return rigs.includes("*") || rigs.includes(rig);
}

// Get all chat IDs that have access to a given rig
function chatsForRig(rig) {
  return Object.entries(chatPermissions)
    .filter(([, perm]) => perm.rigs.includes("*") || perm.rigs.includes(rig))
    .map(([id]) => id);
}

// Reload permissions on SIGHUP for live updates
process.on("SIGHUP", () => {
  chatPermissions = loadPermissions();
  console.log("Reloaded permissions.json");
});

// --- Lifecycle event notifications ---
const EVENTS_FILE = path.join(process.env.HOME || "/home/nando", "gt", ".events.jsonl");
const NOTIFY_EVENT_TYPES = new Set(["done", "sling", "spawn"]);

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("TELEGRAM_CHAT_ID is required (used as default admin chat)");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// Track seen mail IDs to avoid re-sending
const seenMailIds = new Set();

// Subject prefix used for Telegram-originated messages
const TELEGRAM_SUBJECT_PREFIX = "Telegram from ";

// --- Mayor busy-status tracking ---
const MAYOR_CHECK_INTERVAL = parseInt(process.env.MAYOR_CHECK_INTERVAL_MS || "15000", 10);
let mayorBusy = false;
let mayorCheckTimer = null;

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
  const { stdout } = await execFileAsync("gt", ["mail", "inbox", "crow", "--json"], {
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
  // Strip mail headers — body starts after the first blank line
  const parts = stdout.split(/\n\n/);
  const body = parts.length > 1 ? parts.slice(1).join("\n\n").trim() : stdout.trim();
  return body;
}

// --- Telegram commands: /handoff and /kill ---

bot.command("handoff", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAdmin(chatId)) {
    if (isAuthorized(chatId)) await ctx.reply("Only admin chats can use /handoff.");
    return;
  }

  await ctx.reply("Requesting mayor handoff (soft)...");
  try {
    // Nudge the mayor to run the handoff skill
    await execFileAsync("gt", [
      "nudge", "mayor",
      "[CROW COMMAND] Fernando requested /handoff via Telegram. Please run /handoff now to hand off to a fresh session.",
      "--mode", "immediate",
    ], { timeout: 15000 });
    await ctx.reply("Nudged the mayor to handoff. They should wrap up and restart shortly.");
  } catch (err) {
    console.error("Handoff nudge failed:", err.message);
    await ctx.reply("Nudge failed — mayor may be unresponsive. Use /kill for a hard restart.");
  }
});

bot.command("kill", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAdmin(chatId)) {
    if (isAuthorized(chatId)) await ctx.reply("Only admin chats can use /kill.");
    return;
  }

  await ctx.reply("Hard-killing mayor and spawning a fresh session...");
  try {
    const { stdout, stderr } = await execFileAsync("gt", [
      "handoff", "mayor",
    ], { timeout: 60000 });
    const output = (stdout + "\n" + stderr).trim();
    await ctx.reply(`Mayor restarted.\n${output.slice(0, 200)}`);
    console.log("Hard handoff complete:", output);
  } catch (err) {
    console.error("Hard kill failed:", err.message);
    await ctx.reply(`Hard kill failed: ${err.message.slice(0, 200)}`);
  }
});

// --- Mayor busy detection and auto-reply ---

async function checkMayorAvailable() {
  try {
    // Use wait-idle nudge with a short timeout to probe availability
    // A silent probe — the mayor sees nothing if idle
    await execFileAsync("gt", [
      "nudge", "mayor", "--mode", "wait-idle",
      "ping",
    ], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function startMayorWatch() {
  if (mayorCheckTimer) return; // already watching
  mayorCheckTimer = setInterval(async () => {
    const available = await checkMayorAvailable();
    if (available && mayorBusy) {
      mayorBusy = false;
      clearInterval(mayorCheckTimer);
      mayorCheckTimer = null;
      try {
        await bot.api.sendMessage(ADMIN_CHAT_ID, "Mayor is back and available.");
        console.log("Mayor available again — notified Telegram");
      } catch (err) {
        console.error("Failed to send mayor-available notice:", err.message);
      }
    }
  }, MAYOR_CHECK_INTERVAL);
}

// --- Inbound: Telegram -> gt mail ---

bot.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAuthorized(chatId)) {
    console.log(`Ignoring message from unauthorized chat ${chatId}`);
    return;
  }

  const from = ctx.from?.first_name || ctx.from?.username || "unknown";
  const text = ctx.message.text;
  const allowedRigs = getAllowedRigs(chatId);
  const rigScope = allowedRigs.includes("*") ? null : allowedRigs;

  // Tag subject with rig scope for non-admin chats
  const rigTag = rigScope ? ` [rigs:${rigScope.join(",")}]` : "";
  const subject = `Telegram from ${from}${rigTag}: ${text.slice(0, 60)}`;

  // Build body with rig context for the mayor
  let body = text;
  if (rigScope) {
    body = `[Chat ${chatId} — access: ${rigScope.join(", ")}]\n[From: ${from}]\n\n${text}`;
  }

  try {
    await gtMailSend("mayor/", subject, body);
    // Nudge the Mayor so they see it immediately (no polling delay)
    let nudgeOk = false;
    const nudgeText = rigScope
      ? `[Telegram from ${from} (${rigScope.join(",")} only)]: ${text}\n\nReply via: curl -s -X POST http://localhost:${CROW_PORT}/send -H 'Content-Type: application/json' -d '{"message":"your reply","chat":"${chatId}"}'`
      : `[Telegram from ${from}]: ${text}\n\nReply via: curl -s -X POST http://localhost:${CROW_PORT}/send -H 'Content-Type: application/json' -d '{"message":"your reply"}'`;
    try {
      await execFileAsync("gt", [
        "nudge", "mayor", nudgeText,
      ], { timeout: 10000 });
      nudgeOk = true;
    } catch (nudgeErr) {
      console.error("Nudge failed (non-fatal):", nudgeErr.message);
    }

    // If nudge failed, mayor is likely busy — auto-reply and start watching
    if (!nudgeOk && !mayorBusy) {
      mayorBusy = true;
      try {
        await ctx.reply("Mayor is currently working and can't respond right now. Your message has been delivered — they'll see it shortly.");
      } catch (replyErr) {
        console.error("Failed to send busy auto-reply:", replyErr.message);
      }
      startMayorWatch();
    } else if (!nudgeOk && mayorBusy) {
      try {
        await ctx.reply("Message delivered. Mayor is still busy — will notify you when they're available.");
      } catch (replyErr) {
        console.error("Failed to send busy follow-up:", replyErr.message);
      }
    }

    console.log(`Forwarded to mayor: "${subject}" (nudge: ${nudgeOk ? "ok" : "failed/busy"})`);
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

      const subject = msg.subject || "(no subject)";

      // Skip messages that originated from Telegram (prevents echo loop)
      if (subject.startsWith(TELEGRAM_SUBJECT_PREFIX)) continue;

      const rawBody = await gtMailRead(id);
      const body = stripMailHeaders(rawBody);
      const sender = formatSender(msg.from || msg.sender || "unknown");
      const text = `${escapeMarkdown(sender)}: ${escapeMarkdown(subject)}\n\n${escapeMarkdown(body)}`;

      await bot.api.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: "MarkdownV2" });
      console.log(`Sent to Telegram: [${id}] ${subject}`);
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }
}

async function pollInboxText() {
  try {
    const { stdout } = await execFileAsync("gt", ["mail", "inbox", "crow"], {
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

      const subjectMatch = line.match(/Subject:\s*(.+)/i) || line.match(/\b[A-Z][A-Z]+:?\s+(.+)/);
      const subject = subjectMatch ? subjectMatch[1].trim() : "(mail)";

      // Skip messages that originated from Telegram (prevents echo loop)
      if (subject.startsWith(TELEGRAM_SUBJECT_PREFIX)) continue;

      const rawBody = await gtMailRead(id);
      const body = stripMailHeaders(rawBody);

      const fromMatch = line.match(/From:\s*(\S+)/i);
      const sender = formatSender(fromMatch ? fromMatch[1] : "unknown");

      const text = `${escapeMarkdown(sender)}: ${escapeMarkdown(subject)}\n\n${escapeMarkdown(body)}`;

      await bot.api.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: "MarkdownV2" });
      console.log(`Sent to Telegram: [${id}] ${subject}`);
    }
  } catch (err) {
    console.error("Text poll error:", err.message);
  }
}

function escapeMarkdown(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function stripMailHeaders(text) {
  // gt mail read output often includes headers like From:, To:, Date:, ID:, Thread:, Subject:
  // Strip those and return just the body
  const lines = text.split("\n");
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^(From|To|Date|ID|Thread|Subject|Bead|Status|Read):\s/i.test(lines[i])) {
      bodyStart = i + 1;
    } else if (lines[i].trim() === "" && bodyStart > 0) {
      // Skip blank line after headers
      bodyStart = i + 1;
      break;
    } else {
      break;
    }
  }
  return lines.slice(bodyStart).join("\n").trim();
}

function formatSender(sender) {
  // Convert "mayor/" -> "Mayor", "crow/witness" -> "[crow/witness]",
  // "mealpal/witness" -> "[mealpal/witness]"
  if (!sender || sender === "unknown") return "Unknown";
  // Strip trailing slash
  const clean = sender.replace(/\/$/, "");
  // Top-level roles get capitalized name
  if (!clean.includes("/")) {
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  // Sub-roles get bracketed
  return `[${clean}]`;
}

// --- HTTP API for instant outbound messages ---

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/send") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { message, chat, rig } = JSON.parse(body);
        if (!message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "message field required" }));
          return;
        }

        // Determine target chat(s):
        // - chat: send to specific chat ID
        // - rig: send to all chats with access to that rig
        // - neither: send to admin chat (default)
        let targetChats;
        if (chat) {
          targetChats = [String(chat)];
        } else if (rig) {
          targetChats = chatsForRig(rig);
          if (targetChats.length === 0) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `no chats have access to rig: ${rig}` }));
            return;
          }
        } else {
          targetChats = [ADMIN_CHAT_ID];
        }

        const results = [];
        for (const targetId of targetChats) {
          try {
            await bot.api.sendMessage(targetId, message);
            results.push({ chat: targetId, ok: true });
          } catch (sendErr) {
            results.push({ chat: targetId, ok: false, error: sendErr.message });
          }
        }

        console.log(`HTTP /send: "${message.slice(0, 60)}..." -> ${targetChats.join(",")}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, delivered: results }));
      } catch (err) {
        console.error("HTTP /send error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else if (req.method === "POST" && req.url === "/handoff") {
    // Soft handoff: nudge the mayor to run /handoff
    try {
      await execFileAsync("gt", [
        "nudge", "mayor",
        "[CROW COMMAND] Handoff requested via HTTP API. Please run /handoff now.",
        "--mode", "immediate",
      ], { timeout: 15000 });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, action: "handoff-nudge-sent" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (req.method === "POST" && req.url === "/kill") {
    // Hard kill: gt handoff mayor (kills and respawns)
    try {
      const { stdout, stderr } = await execFileAsync("gt", [
        "handoff", "mayor",
      ], { timeout: 60000 });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, output: (stdout + stderr).trim().slice(0, 500) }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// --- Lifecycle event watcher (.events.jsonl) ---

function formatEventMessage(evt) {
  const actor = evt.actor || "unknown";
  const payload = evt.payload || {};

  switch (evt.type) {
    case "done": {
      const bead = payload.bead || "?";
      // Extract rig/project from actor like "mealpal/polecats/obsidian" -> "[mealpal]"
      const rig = actor.split("/")[0];
      return `[${rig}] Completed: ${bead} (${actor})`;
    }
    case "sling": {
      const bead = payload.bead || "?";
      const target = payload.target || "?";
      return `Assigned ${bead} → ${target}`;
    }
    case "spawn": {
      const target = payload.target || actor;
      return `Spawned polecat: ${target}`;
    }
    default:
      return null;
  }
}

function watchEvents() {
  let fileSize = 0;

  // Start from end of file so we don't replay history
  try {
    const stat = fs.statSync(EVENTS_FILE);
    fileSize = stat.size;
  } catch {
    console.log("Events file not found, will watch for creation");
  }

  const watcher = fs.watch(path.dirname(EVENTS_FILE), (eventType, filename) => {
    if (filename !== path.basename(EVENTS_FILE)) return;
    processNewEvents();
  });

  function processNewEvents() {
    let stat;
    try {
      stat = fs.statSync(EVENTS_FILE);
    } catch {
      return;
    }

    if (stat.size <= fileSize) return;

    const stream = fs.createReadStream(EVENTS_FILE, {
      start: fileSize,
      encoding: "utf8",
    });

    let buffer = "";
    stream.on("data", (chunk) => { buffer += chunk; });
    stream.on("end", () => {
      fileSize = stat.size;
      const lines = buffer.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          if (!NOTIFY_EVENT_TYPES.has(evt.type)) continue;
          const msg = formatEventMessage(evt);
          if (msg) {
            bot.api.sendMessage(ADMIN_CHAT_ID, msg).then(
              () => console.log(`Event notify: ${msg}`),
              (err) => console.error("Event notify error:", err.message)
            );
          }
        } catch {
          // skip malformed lines
        }
      }
    });
  }

  console.log("Watching events file for lifecycle notifications");
  return watcher;
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
      const { stdout } = await execFileAsync("gt", ["mail", "inbox", "crow"], { timeout: 30000 });
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
  console.log(`Admin chat: ${ADMIN_CHAT_ID}`);
  console.log(`Authorized chats: ${Object.keys(chatPermissions).join(", ")}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);

  await seedSeenMails();

  bot.start({
    onStart: () => console.log("Bot connected to Telegram"),
  });

  httpServer.listen(CROW_PORT, () => {
    console.log(`HTTP API on http://localhost:${CROW_PORT}/send`);
  });

  pollTimer = setInterval(pollInbox, POLL_INTERVAL);

  // Watch lifecycle events for Telegram notifications
  watchEvents();
}

function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  clearInterval(pollTimer);
  if (mayorCheckTimer) clearInterval(mayorCheckTimer);
  bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
