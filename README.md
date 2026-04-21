# Crow Telegram Bot

Two-way Telegram bridge and notification sink for Gas Town. Relays messages between Telegram chats and the Mayor agent via `gt mail`.

## Setup

```bash
git clone https://github.com/fernando15suarez/crow.git
cd crow
npm install
cp .env.example .env   # Fill in your values
```

## Environment Variables

Create a `.env` file:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Primary admin chat ID |
| `TELEGRAM_CHAT_IDS` | No | Comma-separated chat IDs to bridge (default: just CHAT_ID) |
| `TELEGRAM_ADMIN_ID` | No | Admin chat ID for privileged commands (default: CHAT_ID) |
| `POLL_INTERVAL_MS` | No | Inbox poll interval in ms (default: 30000) |
| `MAYOR_TMUX_SESSION` | No | tmux session name for the mayor's Claude Code process, used by `/sigint` (default: `mayor`). Gas Town typically names this `<town-prefix>-mayor` (e.g. `hq-mayor`). |
| `GT_ROOT` | No | Gas Town root dir (default: `$HOME/gt` if present). Unset if Gas Town isn't installed. |

## Running

### Quick start
```bash
export $(cat .env | xargs) && node bot.js
```

### As a systemd user service (recommended)
```bash
# Create service file
cat > ~/.config/systemd/user/crow.service << 'EOF'
[Unit]
Description=Crow Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/crow
EnvironmentFile=/path/to/crow/.env
ExecStart=/usr/bin/node bot.js
Restart=on-failure
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=%h

[Install]
WantedBy=default.target
EOF

# Enable and start
systemctl --user daemon-reload
systemctl --user enable crow.service
systemctl --user start crow.service
loginctl enable-linger $USER   # Survive logouts
```

### Useful systemd commands
```bash
systemctl --user status crow     # Check status
systemctl --user restart crow    # Restart
journalctl --user -u crow -f     # Tail logs
```

## Telegram Commands

| Command | Access | Description |
|---------|--------|-------------|
| `/help` | Any authorized | Show command + endpoint reference |
| `/handoff` | Admin | Soft mayor restart (nudges mayor to hand off) |
| `/kill` | Admin | Hard mayor restart (forces `gt handoff`) |
| `/sigint` | Admin | Emergency Ctrl+C to mayor process |

## HTTP API

Crow runs an HTTP server on port 3333:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check + uptime |
| `/send` | POST | Send message: `{"message": "text", "chat": "optional-chat-id"}` |
| `/handoff` | POST | Trigger mayor handoff |
| `/kill` | POST | Hard-kill mayor session |

### Example: send a message
```bash
curl -s -X POST http://localhost:3333/send \
  -H 'Content-Type: application/json' \
  -d '{"message": "Hello from the API"}'
```

## Multi-Chat & Permissions

Crow supports multiple Telegram chats with per-chat permissions via `permissions.json`:

```json
{
  "8681623486": { "admin": true, "rigs": ["*"] },
  "-5102634893": { "admin": false, "rigs": ["mealpal", "streety"] }
}
```

- **Admin chats**: Full access to all commands and rigs
- **Authorized chats**: Can send messages, routed to permitted rigs only
- Messages from unauthorized chats are ignored

## How It Works

- **Inbound**: Telegram messages are forwarded to the Mayor via `gt mail send mayor/`
- **Outbound**: Polls the crow inbox for unread messages and forwards to Telegram
- **Busy detection**: Probes mayor availability; auto-replies to Telegram if mayor is unresponsive
- **Event file**: Watches Gas Town event file for lifecycle notifications (polecat completions, etc.)

## Requirements

- Node.js 18+
- Gas Town (`gt`) installed and configured — optional. Without it, Crow runs as a plain Telegram bot (HTTP `/send` and `/sendfile` still work, but mail forwarding, mayor nudges, and lifecycle events are disabled).
- `tmux` (only needed for the `/sigint` command)

## Cloning to another PC

Each Crow instance needs its own Telegram bot (Telegram disallows a bot token running from two places). Rough order of operations:

1. **Create a bot with BotFather.** Message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`, and copy the token.
2. **Find your chat ID.** Send any message to the new bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and grab the `chat.id`. For group chats the ID is negative.
3. **Clone and install:**
   ```bash
   git clone https://github.com/fernando15suarez/crow.git
   cd crow
   npm install
   cp .env.example .env
   ```
4. **Fill in `.env`** with your token and chat ID.
5. **(Optional) Gas Town setup.** If you're using Gas Town, make sure `gt` is on `PATH`. If Gas Town lives somewhere other than `~/gt`, set `GT_ROOT=/path/to/gt` in `.env`. If you don't use Gas Town, leave `GT_ROOT` unset — Crow will start up without the mail/nudge/event features.
6. **(Optional) `permissions.json`** if you want multiple chats or rig-scoped access. If absent, Crow falls back to admin-only for `TELEGRAM_ADMIN_ID`.
7. **Run it** with `npm start`, or set up the systemd service below.
8. **Systemd service:** edit the unit in the section above so `WorkingDirectory` and `EnvironmentFile` point at the new checkout. If Gas Town runs from a non-standard path, add `Environment=GT_ROOT=/path/to/gt` to the `[Service]` block (or just put `GT_ROOT=...` in `.env`).

`GET /health` returns `gas_town.available` so you can confirm which mode Crow is running in.
