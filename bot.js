#!/usr/bin/env node

// Crow Telegram Bot
// Bridges messages between Telegram and Gas Town's gt mail system.
//
// Inbound:  Telegram message -> gt nudge mayor + gt mail (durable record)
// Outbound: HTTP API on CROW_PORT for instant delivery, mail poll as fallback
// Events:   Watches .events.jsonl for lifecycle events (done, sling, spawn)
//
// If Gas Town (`gt`) is not installed, Crow runs as a plain Telegram bot:
// the HTTP /send and /sendfile endpoints still work, but mail forwarding,
// nudges, and lifecycle event notifications are disabled.
//
// Env vars:
//   TELEGRAM_BOT_TOKEN  — required, from BotFather
//   TELEGRAM_CHAT_ID    — required, admin chat (receives all messages)
//   TELEGRAM_ADMIN_ID   — optional, admin chat ID (defaults to TELEGRAM_CHAT_ID)
//   CROW_PORT           — optional, HTTP API port (default: 3333)
//   POLL_INTERVAL_MS    — optional, inbox poll interval (default: 30000)
//   MAYOR_CHECK_INTERVAL_MS — optional, busy-mayor recheck interval (default: 15000)
//   MAYOR_TMUX_SESSION  — optional, tmux session name for /sigint (default: "mayor")
//   GT_ROOT             — optional, Gas Town root dir (default: $HOME/gt if present)
//
// Chat permissions loaded from permissions.json (same directory as bot.js).
// Format: { "<chat_id>": { "role": "admin"|"user", "rigs": ["*"] | ["mealpal"] } }
// Chats not listed are ignored (unauthorized).

const { Bot, InputFile } = require("grammy");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const execFileAsync = promisify(execFile);

// --- Gas Town availability ---
// Crow can run standalone without Gas Town — mail/nudge/event features
// just disable gracefully in that case.

function detectGtCli() {
  try {
    execFileSync("gt", ["--help"], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function detectGtRoot() {
  // 1. Explicit env var (set by `gt prime` and settable in .env)
  if (process.env.GT_ROOT) return process.env.GT_ROOT;
  // 2. Standard ~/gt location, only if it actually exists
  const defaultRoot = path.join(process.env.HOME || "/home", "gt");
  try {
    if (fs.statSync(defaultRoot).isDirectory()) return defaultRoot;
  } catch {
    // doesn't exist
  }
  return null;
}

const GT_AVAILABLE = detectGtCli();
const GT_ROOT = detectGtRoot();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_ID || CHAT_ID;
const CROW_PORT = parseInt(process.env.CROW_PORT || "3333", 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const MAYOR_TMUX_SESSION = process.env.MAYOR_TMUX_SESSION || "mayor";

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
const EVENTS_FILE = GT_ROOT ? path.join(GT_ROOT, ".events.jsonl") : null;
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
  if (!GT_AVAILABLE) {
    await ctx.reply("Gas Town (gt) is not installed on this instance — /handoff unavailable.");
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
  if (!GT_AVAILABLE) {
    await ctx.reply("Gas Town (gt) is not installed on this instance — /kill unavailable.");
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

bot.command("help", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAuthorized(chatId)) {
    console.log(`Ignoring /help from unauthorized chat ${chatId}`);
    return;
  }
  const helpText = [
    "Crow — command reference",
    "",
    "Telegram commands:",
    "  /help — show this message",
    "  /handoff — soft mayor restart (admin)",
    "  /kill — hard mayor restart (admin)",
    "  /sigint — Ctrl+C mayor's Claude process (admin)",
    "",
    "Message types:",
    "  text — forwarded to mayor as mail + nudge",
    "  voice / audio — Whisper-transcribed, then forwarded",
    "  document / photo — saved to ~/incoming, mayor notified",
    "",
    `HTTP endpoints (localhost:${CROW_PORT}, for mayor):`,
    "  POST /send      — send text to Telegram",
    "  POST /sendfile  — send file to Telegram",
    "  POST /handoff   — trigger soft mayor handoff",
    "  POST /kill      — hard mayor restart",
    "  GET  /health    — health + uptime + gt status",
  ].join("\n");
  await ctx.reply(helpText);
});

bot.command("sigint", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAdmin(chatId)) {
    if (isAuthorized(chatId)) await ctx.reply("Only admin chats can use /sigint.");
    return;
  }

  await ctx.reply("Sending SIGINT (Ctrl+C) to mayor's Claude Code process...");
  try {
    // Find the mayor's claude process via tmux session
    const { stdout: paneCmd } = await execFileAsync("tmux", [
      "list-panes", "-t", MAYOR_TMUX_SESSION, "-F", "#{pane_pid}",
    ], { timeout: 5000 });
    const panePid = paneCmd.trim().split("\n")[0];

    if (!panePid) {
      await ctx.reply(`Could not find mayor's tmux pane PID in session '${MAYOR_TMUX_SESSION}'.`);
      return;
    }

    // Find child processes of the tmux pane. pgrep exits 1 when no matches;
    // treat that as an empty list rather than an error so we still signal pane_pid.
    let childPids = [];
    try {
      const { stdout: children } = await execFileAsync("pgrep", [
        "-P", panePid,
      ], { timeout: 5000 });
      childPids = children.trim().split("\n").filter(Boolean);
    } catch (e) {
      if (e.code !== 1) throw e;
    }

    // Signal pane_pid first (interrupts claude if it's the pane's direct process),
    // then children (catches claude if it's nested under a shell, plus any hung subprocesses).
    const pidsToSignal = [panePid, ...childPids];
    for (const pid of pidsToSignal) {
      try {
        process.kill(parseInt(pid), "SIGINT");
      } catch (e) {
        // Process may have already exited
      }
    }
    await ctx.reply(`Sent SIGINT to pane PID ${panePid} + ${childPids.length} child(ren) in tmux session '${MAYOR_TMUX_SESSION}'. The mayor session should interrupt.`);
    console.log(`SIGINT sent to pane PID ${panePid} and child PIDs: [${childPids.join(", ")}] (tmux session: ${MAYOR_TMUX_SESSION})`);
  } catch (err) {
    console.error("SIGINT failed:", err.message);
    const msg = err.message || "";
    if (/can't find (window|session)/i.test(msg)) {
      await ctx.reply(`No tmux session named '${MAYOR_TMUX_SESSION}' found. Set MAYOR_TMUX_SESSION in .env to your Gas Town mayor's tmux session (e.g. 'hq-mayor').`);
    } else {
      await ctx.reply(`SIGINT failed: ${msg.slice(0, 200)}`);
    }
  }
});

// --- Mayor busy detection and auto-reply ---

async function checkMayorAvailable() {
  if (!GT_AVAILABLE) return false;
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

async function sendToAllChats(text, opts) {
  const results = [];
  for (const chatId of AUTHORIZED_CHAT_IDS) {
    try {
      await bot.api.sendMessage(chatId, text, opts);
      results.push({ chatId, ok: true });
    } catch (err) {
      console.error(`Failed to send to chat ${chatId}:`, err.message);
      results.push({ chatId, ok: false, error: err.message });
    }
  }
  return results;
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

  if (!GT_AVAILABLE) {
    await ctx.reply("Gas Town is not available on this Crow instance. Your message was received but there's no mayor to forward it to.");
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

// --- Inbound: Voice/audio messages -> transcribe -> gt mail ---

const INCOMING_DIR = path.join(process.env.HOME || "/home/nando", "incoming");

async function downloadTelegramFile(filePath, destPath) {
  const url = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
  return new Promise((resolve, reject) => {
    const tmpFile = destPath || path.join(os.tmpdir(), `crow-voice-${Date.now()}.ogg`);
    const file = fs.createWriteStream(tmpFile);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => { file.close(); resolve(tmpFile); });
    }).on("error", (err) => {
      fs.unlink(tmpFile, () => {});
      reject(err);
    });
  });
}

async function transcribeAudio(audioPath) {
  // Run whisper CLI, output as plain text to stdout
  const { stdout } = await execFileAsync("whisper", [
    audioPath,
    "--model", "small",
    "--output_format", "txt",
    "--output_dir", os.tmpdir(),
  ], { timeout: 120000 });

  // Whisper writes a .txt file next to the output dir
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const txtFile = path.join(os.tmpdir(), `${baseName}.txt`);
  try {
    const text = fs.readFileSync(txtFile, "utf8").trim();
    fs.unlink(txtFile, () => {}); // cleanup
    return text;
  } catch {
    // Fallback: parse stdout if txt file not found
    return stdout.trim();
  }
}

bot.on(["message:voice", "message:audio"], async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAuthorized(chatId)) {
    console.log(`Ignoring voice message from unauthorized chat ${chatId}`);
    return;
  }

  if (!GT_AVAILABLE) {
    await ctx.reply("Gas Town is not available on this Crow instance — voice forwarding disabled.");
    return;
  }

  const from = ctx.from?.first_name || ctx.from?.username || "unknown";
  const allowedRigs = getAllowedRigs(chatId);
  const rigScope = allowedRigs.includes("*") ? null : allowedRigs;
  const duration = ctx.message.voice?.duration || ctx.message.audio?.duration || 0;

  await ctx.reply("Transcribing voice message...");

  let audioPath;
  try {
    // Download the audio file from Telegram
    const file = await ctx.getFile();
    audioPath = await downloadTelegramFile(file.file_path);

    // Transcribe with Whisper
    const transcription = await transcribeAudio(audioPath);

    if (!transcription) {
      await ctx.reply("Could not transcribe audio — no speech detected.");
      return;
    }

    // Forward to Mayor like a regular message, with voice note indicator
    const rigTag = rigScope ? ` [rigs:${rigScope.join(",")}]` : "";
    const subject = `Telegram from ${from}${rigTag} [voice ${duration}s]: ${transcription.slice(0, 50)}`;

    let body = `[Transcribed from voice message, ${duration}s]\n\n${transcription}`;
    if (rigScope) {
      body = `[Chat ${chatId} — access: ${rigScope.join(", ")}]\n[From: ${from}]\n[Transcribed from voice message, ${duration}s]\n\n${transcription}`;
    }

    await gtMailSend("mayor/", subject, body);

    // Nudge the Mayor
    const nudgeText = rigScope
      ? `[Telegram voice from ${from} (${rigScope.join(",")} only)]: ${transcription}\n\nReply via: curl -s -X POST http://localhost:${CROW_PORT}/send -H 'Content-Type: application/json' -d '{"message":"your reply","chat":"${chatId}"}'`
      : `[Telegram voice from ${from}]: ${transcription}\n\nReply via: curl -s -X POST http://localhost:${CROW_PORT}/send -H 'Content-Type: application/json' -d '{"message":"your reply"}'`;
    try {
      await execFileAsync("gt", ["nudge", "mayor", nudgeText], { timeout: 10000 });
    } catch (nudgeErr) {
      console.error("Voice nudge failed (non-fatal):", nudgeErr.message);
      if (!mayorBusy) {
        mayorBusy = true;
        try {
          await ctx.reply("Mayor is currently working. Your voice message has been delivered — they'll see it shortly.");
        } catch (replyErr) {
          console.error("Failed to send busy auto-reply:", replyErr.message);
        }
        startMayorWatch();
      }
    }

    await ctx.reply(`Transcribed: "${transcription.slice(0, 200)}${transcription.length > 200 ? "..." : ""}"`);
    console.log(`Voice message from ${from}: transcribed ${duration}s -> "${transcription.slice(0, 60)}"`);
  } catch (err) {
    console.error("Voice transcription failed:", err.message);
    await ctx.reply(`Voice transcription failed: ${err.message.slice(0, 200)}`);
  } finally {
    // Clean up temp audio file
    if (audioPath) fs.unlink(audioPath, () => {});
  }
});

// --- Inbound: File/document/photo messages -> save to ~/incoming ---

bot.on(["message:document", "message:photo", "message:video", "message:animation", "message:video_note"], async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAuthorized(chatId)) {
    console.log(`Ignoring file from unauthorized chat ${chatId}`);
    return;
  }

  const from = ctx.from?.first_name || ctx.from?.username || "unknown";
  const allowedRigs = getAllowedRigs(chatId);
  const rigScope = allowedRigs.includes("*") ? null : allowedRigs;
  const caption = ctx.message.caption || "";

  try {
    let file, fileName;
    if (ctx.message.document) {
      file = await ctx.getFile();
      fileName = ctx.message.document.file_name || `file-${Date.now()}`;
    } else if (ctx.message.video) {
      // Native Telegram video (sent via Gallery / video picker)
      file = await ctx.api.getFile(ctx.message.video.file_id);
      const ext = (ctx.message.video.mime_type && ctx.message.video.mime_type.split("/")[1]) || "mp4";
      fileName = ctx.message.video.file_name || `video-${Date.now()}.${ext}`;
    } else if (ctx.message.animation) {
      // GIFs / silent looping clips
      file = await ctx.api.getFile(ctx.message.animation.file_id);
      const ext = (ctx.message.animation.mime_type && ctx.message.animation.mime_type.split("/")[1]) || "mp4";
      fileName = ctx.message.animation.file_name || `animation-${Date.now()}.${ext}`;
    } else if (ctx.message.video_note) {
      // Telegram round-bubble video messages
      file = await ctx.api.getFile(ctx.message.video_note.file_id);
      fileName = `video-note-${Date.now()}.mp4`;
    } else {
      // Photo — get the largest resolution
      const photos = ctx.message.photo;
      file = await ctx.api.getFile(photos[photos.length - 1].file_id);
      fileName = `photo-${Date.now()}.jpg`;
    }

    // Ensure incoming dir exists
    fs.mkdirSync(INCOMING_DIR, { recursive: true });

    // Avoid overwriting — add timestamp if file exists
    let destPath = path.join(INCOMING_DIR, fileName);
    if (fs.existsSync(destPath)) {
      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      destPath = path.join(INCOMING_DIR, `${base}-${Date.now()}${ext}`);
    }

    await downloadTelegramFile(file.file_path, destPath);

    if (GT_AVAILABLE) {
      // Mail the mayor with file path
      const rigTag = rigScope ? ` [rigs:${rigScope.join(",")}]` : "";
      const subject = `Telegram file from ${from}${rigTag}: ${fileName}`;
      let body = `File saved to: ${destPath}`;
      if (caption) body += `\nCaption: ${caption}`;
      if (rigScope) {
        body = `[Chat ${chatId} — access: ${rigScope.join(", ")}]\n[From: ${from}]\n${body}`;
      }

      await gtMailSend("mayor/", subject, body);

      // Nudge
      const nudgeText = `[Telegram file from ${from}]: ${fileName} saved to ${destPath}${caption ? ` — "${caption}"` : ""}\n\nReply via: curl -s -X POST http://localhost:${CROW_PORT}/send -H 'Content-Type: application/json' -d '{"message":"your reply","chat":"${chatId}"}'`;
      try {
        await execFileAsync("gt", ["nudge", "mayor", nudgeText], { timeout: 10000 });
      } catch (nudgeErr) {
        console.error("File nudge failed (non-fatal):", nudgeErr.message);
      }
    }

    await ctx.reply(`File saved: ${path.basename(destPath)}`);
    console.log(`File from ${from}: ${fileName} -> ${destPath}`);
  } catch (err) {
    console.error("File download failed:", err.message);
    await ctx.reply(`File download failed: ${err.message.slice(0, 200)}`);
  }
});

// --- Outbound: Poll inbox -> Telegram ---

async function pollInbox() {
  if (!GT_AVAILABLE) return;
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
  } else if (req.method === "POST" && req.url === "/sendfile") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { path: filePath, chat, caption } = JSON.parse(body);
        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "path field required" }));
          return;
        }

        if (!fs.existsSync(filePath)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `file not found: ${filePath}` }));
          return;
        }

        const targetChat = chat ? String(chat) : ADMIN_CHAT_ID;
        const ext = path.extname(filePath).toLowerCase();
        const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
        const input = new InputFile(filePath);
        const opts = caption ? { caption } : {};

        if (isImage) {
          await bot.api.sendPhoto(targetChat, input, opts);
        } else {
          await bot.api.sendDocument(targetChat, input, opts);
        }

        console.log(`HTTP /sendfile: ${filePath} -> ${targetChat} (${isImage ? "photo" : "document"})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, chat: targetChat, method: isImage ? "sendPhoto" : "sendDocument" }));
      } catch (err) {
        console.error("HTTP /sendfile error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else if (req.method === "POST" && req.url === "/handoff") {
    if (!GT_AVAILABLE) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "gt not installed — handoff unavailable" }));
      return;
    }
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
    if (!GT_AVAILABLE) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "gt not installed — kill unavailable" }));
      return;
    }
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
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      gas_town: GT_AVAILABLE ? { available: true, root: GT_ROOT } : { available: false },
    }));
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
  if (!EVENTS_FILE) {
    console.log("GT_ROOT not set — skipping lifecycle event watcher");
    return null;
  }

  let fileSize = 0;

  // Start from end of file so we don't replay history
  try {
    const stat = fs.statSync(EVENTS_FILE);
    fileSize = stat.size;
  } catch {
    console.log("Events file not found, will watch for creation");
  }

  // Watch the parent directory — fs.watch on the file itself fails if it
  // doesn't exist yet. Parent dir must exist though.
  const watchDir = path.dirname(EVENTS_FILE);
  if (!fs.existsSync(watchDir)) {
    console.log(`Events dir ${watchDir} missing — skipping event watcher`);
    return null;
  }
  const watcher = fs.watch(watchDir, (eventType, filename) => {
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
          // Skip dog/deacon events — too noisy for Telegram
          const actor = evt.actor || "";
          const target = (evt.payload && evt.payload.target) || "";
          if (actor.includes("dog") || actor.includes("deacon") || target.includes("dog") || target.includes("deacon")) continue;
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
  if (!GT_AVAILABLE) return;
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
  if (GT_AVAILABLE) {
    console.log(`Gas Town: available (root: ${GT_ROOT || "unknown"})`);
  } else {
    console.log("Gas Town: not available — running as plain Telegram bot (mail/nudge/events disabled)");
  }

  await seedSeenMails();

  bot.start({
    onStart: () => console.log("Bot connected to Telegram"),
  });

  httpServer.listen(CROW_PORT, () => {
    console.log(`HTTP API on http://localhost:${CROW_PORT}/send`);
  });

  if (GT_AVAILABLE) {
    pollTimer = setInterval(pollInbox, POLL_INTERVAL);
    // Watch lifecycle events for Telegram notifications
    watchEvents();
  }
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
