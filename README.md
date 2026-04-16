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
- Gas Town (`gt`) installed and configured (for mail, nudge, handoff commands)
- `tmux` (for /sigint command to find mayor process)
