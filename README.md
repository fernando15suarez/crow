# Crow Telegram Bot

Bridges messages between Telegram and Gas Town's `gt mail` system.

## Setup

```bash
npm install
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Telegram chat ID to bridge |
| `POLL_INTERVAL_MS` | No | Inbox poll interval in ms (default: 15000) |

## Usage

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npm start
```

## How it works

- **Inbound**: Messages sent to the bot in the configured Telegram chat are forwarded to the Mayor via `gt mail send mayor/`
- **Outbound**: The bot polls the crow inbox for new unread messages and forwards them to the Telegram chat
- Notifications from witnesses, polecats, and other agents are delivered to Telegram as they arrive in the inbox
