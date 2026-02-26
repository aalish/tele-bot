# Telegram Bot Starter (Webhook + Context + Alertmanager)

This project gives you a Telegram bot with these goals covered:

1. Send personal messages (`/api/send-personal`)
2. Interactive behavior (commands + inline buttons)
3. Context memory for conversations + tasks/reminders/notes/alerts (SQLite)
4. Webhook-triggered Telegram updates
5. Grafana Alertmanager webhook compatibility
6. Day-to-day assistant features (reminders, notes, agenda, alert history)

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
- `/menu` to show quick action buttons on demand
- `/login <password>` to unlock access when password mode is enabled
- `/logout` to remove saved login
- `task: buy milk` to create a task
- `/tasks` to show task board (`todo` / `in_progress` / `done`)
- `/taskprogress 3` to move task `#3` to in progress
- `/tasktodo 3` to move task `#3` back to todo
- `/done 3` to mark task `#3` done
- `/taskremove 3` to delete task `#3` (it will not show again)
- `/alerts` to list recent alert history
- `/alertresolve 12` to manually mark local alert `#12` resolved
- `/remind in 30m drink water` to set reminder
- `/remind at 2026-03-01 09:00 pay rent` to set UTC reminder
- `/reminders` to list pending reminders
- `/cancelreminder 2` to cancel reminder `#2`
- `/note call electrician` to save quick note
- `/notes` to list notes
- `/delnote 4` to delete note `#4`
- `/agenda` to view tasks + reminders + open alerts + notes snapshot
- Natural reminder text also works:
  - `remind me to stretch in 20 minutes`
  - `add reminder in 1 min 11:29 PM`
- Natural command-style chat also works:
  - `add task submit report`
  - `start task 3`
  - `mark task 3 done`
  - `delete task 3`
  - `show tasks`
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
- Incoming firing/resolved alerts are persisted in SQLite with stable IDs.
- Resolved alerts from Grafana/Alertmanager automatically update stored alert state.
- `/alertresolve <id>` is a local manual resolution marker and does not close Grafana incident state by itself.

## Notes

- Memory persists in SQLite at `DATABASE_PATH` (default `./data/bot.db`).
- Debug mode:
  - Set `DEBUG_MODE=true` to log webhook/API requests and Telegram update flow.
  - Use `GET /debug/webhook-info` to inspect Telegram webhook state (`x-api-key` required when `INTERNAL_API_KEY` is set).
- Cleaner chat mode:
  - Set `SHOW_MENU_BUTTONS=false` (default) to hide action buttons in every reply.
  - Use `/menu` whenever you want the buttons temporarily.
- Reminder scheduler:
  - Set `REMINDER_CHECK_INTERVAL_SECONDS` (default `30`) for reminder delivery frequency.
  - Reminders are delivered by a background loop even when no new chat message arrives.
- Access control:
  - `ALLOWED_TELEGRAM_USER_IDS=12345,67890` restricts usage to listed Telegram `user_id` values.
  - `BOT_PASSWORD=...` enables password login via `/login <password>`.
  - If both are set, allowlisted users are always allowed; others can still access with valid password login.
- `AI_PROVIDER` options: `auto` (default), `openai`, `gemini`, `none`.
- In `auto` mode, bot chooses OpenAI when `OPENAI_API_KEY` exists, else Gemini when `GEMINI_API_KEY` exists, else fallback mode.
- If `AI_PROVIDER=openai`, set `OPENAI_API_KEY` and optionally `OPENAI_MODEL`.
- If `AI_PROVIDER=gemini`, set `GEMINI_API_KEY` and optionally `GEMINI_MODEL`.
- If no AI provider is available, bot uses deterministic context-aware replies.
