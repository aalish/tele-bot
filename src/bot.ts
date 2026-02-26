import { Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { AssistantEngine } from "./assistant";
import type { AppConfig } from "./config";
import type {
  AlertItem,
  BotStore,
  NoteItem,
  ReminderItem,
  TaskItem
} from "./db";

type BotDeps = {
  config: AppConfig;
  store: BotStore;
  assistant: AssistantEngine;
};

type ParsedReminder = {
  text: string;
  remindAt: Date;
};

function logDebug(enabled: boolean, message: string, details?: Record<string, unknown>) {
  if (!enabled) {
    return;
  }
  const timestamp = new Date().toISOString();
  if (details && Object.keys(details).length > 0) {
    console.log(`[debug][${timestamp}] ${message}`, details);
    return;
  }
  console.log(`[debug][${timestamp}] ${message}`);
}

function menuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Create task", "task_create"),
      Markup.button.callback("List tasks", "task_list")
    ],
    [
      Markup.button.callback("Set reminder", "reminder_create"),
      Markup.button.callback("Alerts", "alerts_show")
    ],
    [Markup.button.callback("Agenda", "agenda_show")],
    [Markup.button.callback("Clear context", "context_clear")]
  ]);
}

function renderTaskList(tasks: TaskItem[]): string {
  if (tasks.length === 0) {
    return "No open tasks.";
  }
  return tasks.map((task) => `#${task.id} ${task.text}`).join("\n");
}

function renderReminderList(reminders: ReminderItem[]): string {
  if (reminders.length === 0) {
    return "No pending reminders.";
  }
  return reminders
    .map(
      (reminder) =>
        `#${reminder.id} [${formatUtc(reminder.remind_at)}] ${reminder.text}`
    )
    .join("\n");
}

function renderNotesList(notes: NoteItem[]): string {
  if (notes.length === 0) {
    return "No notes saved.";
  }
  return notes.map((note) => `#${note.id} ${note.text}`).join("\n");
}

function renderAlertList(alerts: AlertItem[]): string {
  if (alerts.length === 0) {
    return "No alerts in history.";
  }

  return alerts
    .map((alert) => {
      const state = alert.status === "resolved" ? "RESOLVED" : "FIRING";
      const manual = alert.manual_resolved ? " manually_resolved" : "";
      return `#${alert.id} [${state}${manual}] ${alert.alertname} (${alert.severity}) on ${alert.instance}\n${alert.summary}`;
    })
    .join("\n\n");
}

function renderAgenda(store: BotStore, chatId: string): string {
  const tasks = store.listTasks(chatId, false, 5);
  const reminders = store.listUpcomingReminders(chatId, 5);
  const notes = store.listNotes(chatId, 5);
  const alerts = store.listOpenAlerts(chatId, 5);

  return [
    "Agenda snapshot",
    "",
    "Tasks:",
    tasks.length === 0 ? "(none)" : tasks.map((t) => `- #${t.id} ${t.text}`).join("\n"),
    "",
    "Upcoming reminders:",
    reminders.length === 0
      ? "(none)"
      : reminders
          .map((r) => `- #${r.id} [${formatUtc(r.remind_at)}] ${r.text}`)
          .join("\n"),
    "",
    "Open alerts:",
    alerts.length === 0
      ? "(none)"
      : alerts
          .map((a) => `- #${a.id} ${a.alertname} (${a.severity}) on ${a.instance}`)
          .join("\n"),
    "",
    "Recent notes:",
    notes.length === 0 ? "(none)" : notes.map((n) => `- #${n.id} ${n.text}`).join("\n")
  ].join("\n");
}

function formatUtc(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}

function isSkippableInput(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("task:") ||
    normalized.startsWith("note:") ||
    normalized.startsWith("done ")
  );
}

function resolveChatId(ctx: {
  chat?: { id: number | string };
  from?: { id: number | string };
}): string | null {
  const id = ctx.chat?.id ?? ctx.from?.id;
  if (id === undefined || id === null) {
    return null;
  }
  return String(id);
}

function resolveUserId(ctx: { from?: { id: number | string } }): string | null {
  const id = ctx.from?.id;
  if (id === undefined || id === null) {
    return null;
  }
  return String(id);
}

function resolveIncomingText(ctx: unknown): string | null {
  if (!ctx || typeof ctx !== "object") {
    return null;
  }
  const maybeMessage = (ctx as { message?: unknown }).message;
  if (!maybeMessage || typeof maybeMessage !== "object") {
    return null;
  }
  const maybeText = (maybeMessage as { text?: unknown }).text;
  return typeof maybeText === "string" ? maybeText : null;
}

function startsWithCommand(text: string, command: string): boolean {
  const normalized = text.trim().toLowerCase();
  const prefix = `/${command}`;
  if (!normalized.startsWith(prefix)) {
    return false;
  }
  const suffix = normalized.slice(prefix.length);
  return suffix === "" || suffix.startsWith(" ") || suffix.startsWith("@");
}

function isPublicCommand(text: string): boolean {
  return (
    startsWithCommand(text, "start") ||
    startsWithCommand(text, "help") ||
    startsWithCommand(text, "myid") ||
    startsWithCommand(text, "login")
  );
}

function hasAuthRestrictions(config: AppConfig): boolean {
  return config.allowedTelegramUserIds.size > 0 || Boolean(config.botPassword);
}

function isUserAuthorized(userId: string, config: AppConfig, store: BotStore): boolean {
  const allowlistEnabled = config.allowedTelegramUserIds.size > 0;
  const passwordEnabled = Boolean(config.botPassword);

  if (!allowlistEnabled && !passwordEnabled) {
    return true;
  }

  if (allowlistEnabled && config.allowedTelegramUserIds.has(userId)) {
    return true;
  }

  if (passwordEnabled && store.isAuthorizedUser(userId)) {
    return true;
  }

  return false;
}

function buildUnauthorizedMessage(config: AppConfig): string {
  const allowlistEnabled = config.allowedTelegramUserIds.size > 0;
  const passwordEnabled = Boolean(config.botPassword);

  if (allowlistEnabled && passwordEnabled) {
    return [
      "Access restricted.",
      "Use /login <password> or ask admin to add your user_id to allowlist.",
      "Run /myid to get your user_id."
    ].join("\n");
  }

  if (allowlistEnabled) {
    return [
      "Access restricted to allowlisted users only.",
      "Run /myid and share your user_id with admin."
    ].join("\n");
  }

  if (passwordEnabled) {
    return "Access restricted. Use /login <password>.";
  }

  return "Access restricted.";
}

function extractCommandArgs(text: string): string {
  return text.replace(/^\/[a-z_]+(?:@\w+)?\s*/i, "").trim();
}

function buildUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date | null {
  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day ||
    candidate.getUTCHours() !== hour ||
    candidate.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return candidate;
}

function durationToMs(amount: number, unitRaw: string): number | null {
  const unit = unitRaw.toLowerCase();
  if (["m", "min", "mins", "minute", "minutes"].includes(unit)) {
    return amount * 60 * 1000;
  }
  if (["h", "hr", "hour", "hours"].includes(unit)) {
    return amount * 60 * 60 * 1000;
  }
  if (["d", "day", "days"].includes(unit)) {
    return amount * 24 * 60 * 60 * 1000;
  }
  return null;
}

function parseReminderFromCommand(args: string, now: Date): ParsedReminder | null {
  const relativeMatch = args.match(
    /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\s+(.+)$/i
  );
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const text = relativeMatch[3]?.trim();
    if (!Number.isInteger(amount) || amount <= 0 || !text) {
      return null;
    }
    const ms = durationToMs(amount, relativeMatch[2]);
    if (!ms) {
      return null;
    }
    return {
      text,
      remindAt: new Date(now.getTime() + ms)
    };
  }

  const absoluteMatch = args.match(
    /^at\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/i
  );
  if (absoluteMatch) {
    const year = Number(absoluteMatch[1]);
    const month = Number(absoluteMatch[2]);
    const day = Number(absoluteMatch[3]);
    const hour = Number(absoluteMatch[4]);
    const minute = Number(absoluteMatch[5]);
    const text = absoluteMatch[6]?.trim();
    if (!text || hour > 23 || minute > 59) {
      return null;
    }
    const remindAt = buildUtcDate(year, month, day, hour, minute);
    if (!remindAt) {
      return null;
    }
    return { text, remindAt };
  }

  return null;
}

function parseNaturalReminder(text: string, now: Date): ParsedReminder | null {
  const relativePattern1 =
    /^remind me to\s+(.+?)\s+in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\.?$/i;
  const relativePattern2 =
    /^remind me in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\s+to\s+(.+?)\.?$/i;
  const absolutePattern1 =
    /^remind me to\s+(.+?)\s+(today|tomorrow)\s+at\s+(\d{1,2}):(\d{2})\.?$/i;
  const absolutePattern2 =
    /^remind me to\s+(.+?)\s+at\s+(\d{1,2}):(\d{2})\.?$/i;

  const match1 = text.match(relativePattern1);
  if (match1) {
    const reminderText = match1[1]?.trim();
    const amount = Number(match1[2]);
    if (!reminderText || !Number.isInteger(amount) || amount <= 0) {
      return null;
    }
    const ms = durationToMs(amount, match1[3]);
    if (!ms) {
      return null;
    }
    return {
      text: reminderText,
      remindAt: new Date(now.getTime() + ms)
    };
  }

  const match2 = text.match(relativePattern2);
  if (match2) {
    const amount = Number(match2[1]);
    const reminderText = match2[3]?.trim();
    if (!reminderText || !Number.isInteger(amount) || amount <= 0) {
      return null;
    }
    const ms = durationToMs(amount, match2[2]);
    if (!ms) {
      return null;
    }
    return {
      text: reminderText,
      remindAt: new Date(now.getTime() + ms)
    };
  }

  const match3 = text.match(absolutePattern1);
  if (match3) {
    const reminderText = match3[1]?.trim();
    const dayMode = match3[2]?.toLowerCase();
    const hour = Number(match3[3]);
    const minute = Number(match3[4]);
    if (!reminderText || hour > 23 || minute > 59) {
      return null;
    }
    const base = new Date(now);
    const dayOffset = dayMode === "tomorrow" ? 1 : 0;
    const target = new Date(
      Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate() + dayOffset,
        hour,
        minute,
        0,
        0
      )
    );
    return { text: reminderText, remindAt: target };
  }

  const match4 = text.match(absolutePattern2);
  if (match4) {
    const reminderText = match4[1]?.trim();
    const hour = Number(match4[2]);
    const minute = Number(match4[3]);
    if (!reminderText || hour > 23 || minute > 59) {
      return null;
    }
    const base = new Date(now);
    let target = new Date(
      Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate(),
        hour,
        minute,
        0,
        0
      )
    );
    if (target.getTime() <= now.getTime()) {
      target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
    }
    return { text: reminderText, remindAt: target };
  }

  return null;
}

function reminderUsageText(): string {
  return [
    "Reminder formats:",
    "/remind in 30m drink water",
    "/remind in 2h call mom",
    "/remind at 2026-03-01 09:00 pay rent (UTC)",
    'Natural text: "remind me to stretch in 20 minutes"'
  ].join("\n");
}

export function createBot({ config, store, assistant }: BotDeps): Telegraf {
  const bot = new Telegraf(config.botToken);

  bot.catch((error, ctx) => {
    console.error("Telegram update handling error:", error);
    logDebug(config.debugMode, "Update caused error", {
      update_id: ctx.update.update_id
    });
  });

  bot.use(async (ctx, next) => {
    if (config.debugMode) {
      const messageText = resolveIncomingText(ctx);
      const callbackData = (ctx.callbackQuery &&
      "data" in ctx.callbackQuery &&
      typeof ctx.callbackQuery.data === "string"
        ? ctx.callbackQuery.data
        : undefined) as string | undefined;
      logDebug(config.debugMode, "Incoming Telegram update", {
        update_id: ctx.update.update_id,
        type: ctx.updateType,
        user_id: resolveUserId(ctx),
        chat_id: resolveChatId(ctx),
        message_preview: messageText ? messageText.slice(0, 120) : undefined,
        callback_data: callbackData
      });
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    const userId = resolveUserId(ctx);
    if (!userId || !hasAuthRestrictions(config) || isUserAuthorized(userId, config, store)) {
      await next();
      return;
    }

    const text = resolveIncomingText(ctx);
    if (text && isPublicCommand(text)) {
      await next();
      return;
    }

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("Access denied");
      logDebug(config.debugMode, "Unauthorized callback blocked", {
        user_id: userId,
        update_id: ctx.update.update_id
      });
      return;
    }

    if (text) {
      await ctx.reply(buildUnauthorizedMessage(config));
      logDebug(config.debugMode, "Unauthorized message blocked", {
        user_id: userId,
        update_id: ctx.update.update_id
      });
    }
  });

  bot.start(async (ctx) => {
    const userId = resolveUserId(ctx);
    const chatId = resolveChatId(ctx);
    if (!chatId || !userId) {
      return;
    }
    if (!isUserAuthorized(userId, config, store)) {
      await ctx.reply(buildUnauthorizedMessage(config));
      return;
    }
    store.addMessage(chatId, "system", "User started the bot");
    await ctx.reply(
      [
        "Bot is ready.",
        "Commands:",
        "/myid - show your user_id and chat_id",
        "/login <password> - unlock bot access (when enabled)",
        "/logout - remove saved login (when enabled)",
        "/tasks - list open tasks",
        "/done <id> - mark task done",
        "/alerts - show recent alert history",
        "/alertresolve <id> - manually mark alert resolved",
        "/remind ... - create reminder",
        "/agenda - show tasks + reminders + alerts + notes",
        "/note <text> - save quick note",
        "Use `task: <text>` to create a task."
      ].join("\n"),
      menuKeyboard()
    );
  });

  bot.command("help", async (ctx) => {
    const userId = resolveUserId(ctx);
    if (userId && !isUserAuthorized(userId, config, store)) {
      await ctx.reply(buildUnauthorizedMessage(config));
      return;
    }
    await ctx.reply(
      [
        "Plain text -> assistant reply with context memory.",
        "task: <text> -> create task",
        "/tasks, /done <id> -> manage tasks",
        "/alerts, /alertresolve <id> -> alert history/manual resolve",
        "/remind ... -> set reminder",
        "/reminders, /cancelreminder <id> -> manage reminders",
        "/note <text>, /notes, /delnote <id> -> quick notes",
        "/agenda -> daily snapshot",
        "",
        reminderUsageText()
      ].join("\n"),
      menuKeyboard()
    );
  });

  bot.command("myid", async (ctx) => {
    const userId = resolveUserId(ctx) ?? "unknown";
    const chatId = resolveChatId(ctx) ?? "unknown";
    await ctx.reply(`user_id: ${userId}\nchat_id: ${chatId}`);
  });

  bot.command("login", async (ctx) => {
    const userId = resolveUserId(ctx);
    if (!userId) {
      return;
    }

    if (!config.botPassword) {
      await ctx.reply("Password authentication is disabled.");
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    const password = parts.slice(1).join(" ");
    if (!password) {
      await ctx.reply("Usage: /login <password>");
      return;
    }

    if (password !== config.botPassword) {
      await ctx.reply("Invalid password.");
      return;
    }

    store.authorizeUser(userId);
    await ctx.reply("Login successful. You can use the bot now.", menuKeyboard());
  });

  bot.command("logout", async (ctx) => {
    const userId = resolveUserId(ctx);
    if (!userId) {
      return;
    }

    if (!config.botPassword) {
      await ctx.reply("Password authentication is disabled.");
      return;
    }

    const removed = store.revokeAuthorizedUser(userId);
    await ctx.reply(removed ? "Logged out." : "You are not logged in.");
  });

  bot.command("tasks", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const tasks = store.listTasks(chatId);
    await ctx.reply(renderTaskList(tasks), menuKeyboard());
  });

  bot.command("done", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const parts = ctx.message.text.trim().split(/\s+/);
    const taskId = Number(parts[1]);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      await ctx.reply("Usage: /done <task_id>");
      return;
    }

    const ok = store.markTaskDone(chatId, taskId);
    await ctx.reply(ok ? `Task #${taskId} marked done.` : "Task id not found.");
  });

  bot.command("alerts", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const alerts = store.listAlerts(chatId, 20);
    await ctx.reply(renderAlertList(alerts), menuKeyboard());
  });

  bot.command("alertresolve", async (ctx) => {
    const chatId = resolveChatId(ctx);
    const userId = resolveUserId(ctx);
    if (!chatId || !userId) {
      return;
    }
    const parts = ctx.message.text.trim().split(/\s+/);
    const alertId = Number(parts[1]);
    if (!Number.isInteger(alertId) || alertId <= 0) {
      await ctx.reply("Usage: /alertresolve <alert_id>");
      return;
    }
    const ok = store.resolveAlertManually(chatId, alertId, userId);
    if (!ok) {
      await ctx.reply("Alert id not found or already resolved.");
      return;
    }
    await ctx.reply(
      `Alert #${alertId} marked resolved locally.\nNote: this does not close Grafana incident state by itself.`,
      menuKeyboard()
    );
  });

  bot.command("remind", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const args = extractCommandArgs(ctx.message.text);
    if (!args) {
      await ctx.reply(reminderUsageText());
      return;
    }
    const parsed = parseReminderFromCommand(args, new Date());
    if (!parsed) {
      await ctx.reply(`Could not parse reminder.\n\n${reminderUsageText()}`);
      return;
    }
    if (parsed.remindAt.getTime() <= Date.now()) {
      await ctx.reply("Reminder time must be in the future.");
      return;
    }
    const id = store.createReminder(chatId, parsed.text, parsed.remindAt.toISOString());
    store.addMessage(
      chatId,
      "system",
      `Reminder #${id} created for ${formatUtc(parsed.remindAt)}: ${parsed.text}`
    );
    await ctx.reply(
      `Reminder set: #${id}\nWhen: ${formatUtc(parsed.remindAt)}\nWhat: ${parsed.text}`,
      menuKeyboard()
    );
  });

  bot.command("reminders", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await ctx.reply(renderReminderList(store.listUpcomingReminders(chatId, 20)), menuKeyboard());
  });

  bot.command("cancelreminder", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const parts = ctx.message.text.trim().split(/\s+/);
    const reminderId = Number(parts[1]);
    if (!Number.isInteger(reminderId) || reminderId <= 0) {
      await ctx.reply("Usage: /cancelreminder <reminder_id>");
      return;
    }
    const ok = store.cancelReminder(chatId, reminderId);
    await ctx.reply(ok ? `Reminder #${reminderId} cancelled.` : "Reminder id not found.");
  });

  bot.command("note", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const text = extractCommandArgs(ctx.message.text);
    if (!text) {
      await ctx.reply("Usage: /note <text>");
      return;
    }
    const id = store.createNote(chatId, text);
    await ctx.reply(`Note saved: #${id}`, menuKeyboard());
  });

  bot.command("notes", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await ctx.reply(renderNotesList(store.listNotes(chatId, 20)), menuKeyboard());
  });

  bot.command("delnote", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const parts = ctx.message.text.trim().split(/\s+/);
    const noteId = Number(parts[1]);
    if (!Number.isInteger(noteId) || noteId <= 0) {
      await ctx.reply("Usage: /delnote <note_id>");
      return;
    }
    const ok = store.deleteNote(chatId, noteId);
    await ctx.reply(ok ? `Note #${noteId} deleted.` : "Note id not found.");
  });

  bot.command("agenda", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await ctx.reply(renderAgenda(store, chatId), menuKeyboard());
  });

  bot.hears(/^task:\s*(.+)$/i, async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const match = ctx.match as RegExpExecArray;
    const text = match[1]?.trim();
    if (!text) {
      await ctx.reply("Task text cannot be empty.");
      return;
    }

    const id = store.createTask(chatId, text);
    store.addMessage(chatId, "system", `Task #${id} created: ${text}`);
    await ctx.reply(`Task created: #${id} ${text}`, menuKeyboard());
  });

  bot.hears(/^note:\s*(.+)$/i, async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const match = ctx.match as RegExpExecArray;
    const text = match[1]?.trim();
    if (!text) {
      await ctx.reply("Note text cannot be empty.");
      return;
    }
    const id = store.createNote(chatId, text);
    await ctx.reply(`Note saved: #${id}`, menuKeyboard());
  });

  bot.action("task_create", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Send: task: <your task>");
  });

  bot.action("task_list", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await ctx.reply(renderTaskList(store.listTasks(chatId)), menuKeyboard());
  });

  bot.action("reminder_create", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(reminderUsageText());
  });

  bot.action("alerts_show", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await ctx.reply(renderAlertList(store.listAlerts(chatId, 20)), menuKeyboard());
  });

  bot.action("agenda_show", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await ctx.reply(renderAgenda(store, chatId), menuKeyboard());
  });

  bot.action("context_clear", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const deleted = store.clearMessages(chatId);
    await ctx.reply(`Context cleared (${deleted} messages).`, menuKeyboard());
  });

  bot.on(message("text"), async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const text = ctx.message.text.trim();
    if (!text || isSkippableInput(text)) {
      return;
    }

    const parsedReminder = parseNaturalReminder(text, new Date());
    if (parsedReminder) {
      if (parsedReminder.remindAt.getTime() <= Date.now()) {
        await ctx.reply("Reminder time must be in the future.");
        return;
      }
      const reminderId = store.createReminder(
        chatId,
        parsedReminder.text,
        parsedReminder.remindAt.toISOString()
      );
      store.addMessage(
        chatId,
        "system",
        `Reminder #${reminderId} created for ${formatUtc(parsedReminder.remindAt)}: ${
          parsedReminder.text
        }`
      );
      await ctx.reply(
        `Reminder set: #${reminderId}\nWhen: ${formatUtc(parsedReminder.remindAt)}\nWhat: ${
          parsedReminder.text
        }`,
        menuKeyboard()
      );
      return;
    }

    store.addMessage(chatId, "user", text);
    const answer = await assistant.answer(chatId, text);
    store.addMessage(chatId, "assistant", answer);
    await ctx.reply(answer, menuKeyboard());
    logDebug(config.debugMode, "Answered message", {
      chat_id: chatId,
      user_id: resolveUserId(ctx),
      update_id: ctx.update.update_id
    });
  });

  return bot;
}
