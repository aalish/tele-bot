# Telegram Bot Starter (Webhook + Context + Alertmanager)

This project gives you a Telegram bot with these goals covered:

1. Send personal messages (`/api/send-personal`)
2. Interactive behavior (commands + inline buttons)
3. Context memory for conversations + tasks (SQLite)
4. Webhook-triggered Telegram updates
5. Grafana Alertmanager webhook compatibility

## Stack

- Node.js + TypeScript
- `telegraf` for Telegram bot API
- `express` for webhook/API server
- `better-sqlite3` for chat/task memory
- Optional OpenAI or Google Gemini integration for richer Q&A

## Setup

1. Create a Telegram bot with BotFather and get `BOT_TOKEN`.
2. Copy env file and fill values:

```bash
cp .env.example .env
```

3. Install dependencies:

```bash
npm install
```

4. Run in dev mode:

```bash
npm run dev
```

When the app starts, it sets Telegram webhook to:

`https://<PUBLIC_BASE_URL>/webhooks/telegram/<TELEGRAM_WEBHOOK_PATH_SECRET>`

Your `PUBLIC_BASE_URL` must be HTTPS and reachable by Telegram.

## How to use

### In Telegram chat

- `/start` to initialize
- `/myid` to get `user_id` and `chat_id`
- `/login <password>` to unlock access when password mode is enabled
- `/logout` to remove saved login
- `task: buy milk` to create a task
- `/tasks` to list tasks
- `/done 3` to mark task `#3` done
- Send regular text questions; bot replies using chat memory

### Send personal message via API

```bash
curl -X POST http://localhost:3000/api/send-personal \
  -H "Content-Type: application/json" \
  -H "x-api-key: <INTERNAL_API_KEY>" \
  -d '{"chatId":"<CHAT_ID>","text":"Hello from API"}'
```

If `INTERNAL_API_KEY` is empty, the endpoint does not enforce API key checks.

### Grafana Alertmanager webhook

Configure Grafana Alertmanager contact point to send webhook to:

`https://<PUBLIC_BASE_URL>/webhooks/alertmanager`

Set bot target chat IDs via:

`ALERT_TELEGRAM_CHAT_IDS=-1001234567890,987654321`

- Use group chat IDs (usually start with `-100`) for channel/group notifications.
- Use `/myid` in private chat to get a personal chat ID.

## Notes

- Memory persists in SQLite at `DATABASE_PATH` (default `./data/bot.db`).
- Debug mode:
  - Set `DEBUG_MODE=true` to log webhook/API requests and Telegram update flow.
  - Use `GET /debug/webhook-info` to inspect Telegram webhook state (`x-api-key` required when `INTERNAL_API_KEY` is set).
- Access control:
  - `ALLOWED_TELEGRAM_USER_IDS=12345,67890` restricts usage to listed Telegram `user_id` values.
  - `BOT_PASSWORD=...` enables password login via `/login <password>`.
  - If both are set, allowlisted users are always allowed; others can still access with valid password login.
- `AI_PROVIDER` options: `auto` (default), `openai`, `gemini`, `none`.
- In `auto` mode, bot chooses OpenAI when `OPENAI_API_KEY` exists, else Gemini when `GEMINI_API_KEY` exists, else fallback mode.
- If `AI_PROVIDER=openai`, set `OPENAI_API_KEY` and optionally `OPENAI_MODEL`.
- If `AI_PROVIDER=gemini`, set `GEMINI_API_KEY` and optionally `GEMINI_MODEL`.
- If no AI provider is available, bot uses deterministic context-aware replies.
