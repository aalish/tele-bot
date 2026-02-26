import { Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { AssistantEngine } from "./assistant";
import type { AppConfig } from "./config";
import type {
  AlertItem,
  BotStore,
  ConversationListItem,
  NoteItem,
  ReminderItem,
  TaskStatus,
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

type ParsedAssistantAction =
  | { type: "create_task"; text: string }
  | { type: "update_task_status"; taskId: number; status: TaskStatus }
  | { type: "delete_task"; taskId: number }
  | { type: "list_tasks" }
  | { type: "create_note"; text: string }
  | { type: "create_reminder"; reminder: ParsedReminder }
  | { type: "list_reminders" }
  | { type: "show_agenda" };

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
      Markup.button.callback("Add task", "task_create"),
      Markup.button.callback("My tasks", "task_list")
    ],
    [
      Markup.button.callback("Move task", "task_progress_prompt"),
      Markup.button.callback("Complete task", "task_done_prompt")
    ],
    [
      Markup.button.callback("Delete task", "task_delete_prompt"),
      Markup.button.callback("Set reminder", "reminder_create")
    ],
    [Markup.button.callback("Daily agenda", "agenda_show")],
    [Markup.button.callback("Alert history", "alerts_show")],
    [Markup.button.callback("Conversations", "conversations_show")],
    [Markup.button.callback("Clear context", "context_clear")]
  ]);
}

function menuMarkup(config: AppConfig) {
  return config.showMenuButtons ? menuKeyboard() : undefined;
}

function renderTaskList(tasks: TaskItem[]): string {
  if (tasks.length === 0) {
    return "No tasks found.";
  }

  const byStatus: Record<TaskStatus, TaskItem[]> = {
    todo: [],
    in_progress: [],
    done: []
  };
  for (const task of tasks) {
    byStatus[task.status].push(task);
  }

  const lines: string[] = [];
  const pushSection = (title: string, list: TaskItem[]) => {
    if (list.length === 0) {
      return;
    }
    lines.push(`${title}:`);
    for (const task of list) {
      lines.push(`- #${task.id} ${task.text}`);
    }
    lines.push("");
  };

  pushSection("To do", byStatus.todo);
  pushSection("In progress", byStatus.in_progress);
  pushSection("Done", byStatus.done);

  if (lines.length === 0) {
    return "No tasks found.";
  }

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
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

function renderConversationList(conversations: ConversationListItem[]): string {
  if (conversations.length === 0) {
    return "No saved conversations yet.";
  }

  return conversations
    .map((conversation) => {
      const status = conversation.status === "active" ? "ACTIVE" : "SAVED";
      const when = formatUtc(conversation.last_activity_at);
      return `#${conversation.id} [${status}] ${conversation.title}\nUpdated: ${when} | Messages: ${conversation.message_count}`;
    })
    .join("\n\n");
}

function conversationOpenKeyboard(conversations: ConversationListItem[]) {
  const selectable = conversations.filter((conversation) => conversation.message_count > 0);
  if (selectable.length === 0) {
    return undefined;
  }

  const rows = selectable.slice(0, 8).map((conversation) => [
    Markup.button.callback(
      `Open #${conversation.id}`,
      `conv_open_${conversation.id}`
    )
  ]);
  return Markup.inlineKeyboard(rows);
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
    startsWithCommand(text, "menu") ||
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

function nextUtcDateForClock(now: Date, hour: number, minute: number): Date {
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
  return target;
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
    /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)(?:\s+(.+))?$/i
  );
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const text = relativeMatch[3]?.trim() || "Reminder";
    if (!Number.isInteger(amount) || amount <= 0) {
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
    /^at\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?:\s+(.+))?$/i
  );
  if (absoluteMatch) {
    const year = Number(absoluteMatch[1]);
    const month = Number(absoluteMatch[2]);
    const day = Number(absoluteMatch[3]);
    const hour = Number(absoluteMatch[4]);
    const minute = Number(absoluteMatch[5]);
    const text = absoluteMatch[6]?.trim() || "Reminder";
    if (hour > 23 || minute > 59) {
      return null;
    }
    const remindAt = buildUtcDate(year, month, day, hour, minute);
    if (!remindAt) {
      return null;
    }
    return { text, remindAt };
  }

  const ampmMatch = args.match(
    /^at\s+(\d{1,2}):(\d{2})\s*(am|pm)(?:\s+(.+))?$/i
  );
  if (ampmMatch) {
    const hour12 = Number(ampmMatch[1]);
    const minute = Number(ampmMatch[2]);
    const ampm = ampmMatch[3]?.toLowerCase();
    const text = ampmMatch[4]?.trim() || "Reminder";
    if (hour12 < 1 || hour12 > 12 || minute > 59) {
      return null;
    }
    let hour = hour12 % 12;
    if (ampm === "pm") {
      hour += 12;
    }
    const remindAt = nextUtcDateForClock(now, hour, minute);
    return { text, remindAt };
  }

  const clockMatch = args.match(/^at\s+(\d{1,2}):(\d{2})(?:\s+(.+))?$/i);
  if (clockMatch) {
    const hour = Number(clockMatch[1]);
    const minute = Number(clockMatch[2]);
    const text = clockMatch[3]?.trim() || "Reminder";
    if (hour > 23 || minute > 59) {
      return null;
    }
    return {
      text,
      remindAt: nextUtcDateForClock(now, hour, minute)
    };
  }

  return null;
}

function parseNaturalReminder(text: string, now: Date): ParsedReminder | null {
  const relativePattern1 =
    /^remind me to\s+(.+?)\s+in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\.?$/i;
  const relativePattern2 =
    /^remind me in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\s+to\s+(.+?)\.?$/i;
  const relativePattern3 =
    /^remind me in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\.?$/i;
  const addReminderRelative =
    /^(?:add|set|create)\s+reminder\s+in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)(?:\s+(.+))?$/i;
  const absolutePattern1 =
    /^remind me to\s+(.+?)\s+(today|tomorrow)\s+at\s+(\d{1,2}):(\d{2})\.?$/i;
  const absolutePattern2 =
    /^remind me to\s+(.+?)\s+at\s+(\d{1,2}):(\d{2})\.?$/i;
  const addReminderAbsolute =
    /^(?:add|set|create)\s+reminder\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?(?:\s+(.+))?$/i;

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

  const match3 = text.match(relativePattern3);
  if (match3) {
    const amount = Number(match3[1]);
    if (!Number.isInteger(amount) || amount <= 0) {
      return null;
    }
    const ms = durationToMs(amount, match3[2]);
    if (!ms) {
      return null;
    }
    return {
      text: "Reminder",
      remindAt: new Date(now.getTime() + ms)
    };
  }

  const match4 = text.match(addReminderRelative);
  if (match4) {
    const amount = Number(match4[1]);
    const reminderText = match4[3]?.trim() || "Reminder";
    if (!Number.isInteger(amount) || amount <= 0) {
      return null;
    }
    const ms = durationToMs(amount, match4[2]);
    if (!ms) {
      return null;
    }
    return {
      text: reminderText,
      remindAt: new Date(now.getTime() + ms)
    };
  }

  const match5 = text.match(absolutePattern1);
  if (match5) {
    const reminderText = match5[1]?.trim();
    const dayMode = match5[2]?.toLowerCase();
    const hour = Number(match5[3]);
    const minute = Number(match5[4]);
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

  const match6 = text.match(absolutePattern2);
  if (match6) {
    const reminderText = match6[1]?.trim();
    const hour = Number(match6[2]);
    const minute = Number(match6[3]);
    if (!reminderText || hour > 23 || minute > 59) {
      return null;
    }
    const target = nextUtcDateForClock(now, hour, minute);
    return { text: reminderText, remindAt: target };
  }

  const match7 = text.match(addReminderAbsolute);
  if (match7) {
    const hourRaw = Number(match7[1]);
    const minute = Number(match7[2]);
    const ampm = match7[3]?.toLowerCase();
    const reminderText = match7[4]?.trim() || "Reminder";
    if (minute > 59) {
      return null;
    }

    let hour = hourRaw;
    if (ampm) {
      if (hourRaw < 1 || hourRaw > 12) {
        return null;
      }
      hour = hourRaw % 12;
      if (ampm === "pm") {
        hour += 12;
      }
    } else if (hourRaw > 23) {
      return null;
    }

    return {
      text: reminderText,
      remindAt: nextUtcDateForClock(now, hour, minute)
    };
  }

  return null;
}

function reminderUsageText(): string {
  return [
    "Reminder formats:",
    "/remind in 30m drink water",
    "/remind in 1m",
    "/remind in 2h call mom",
    "/remind at 2026-03-01 09:00 pay rent (UTC)",
    "/remind at 11:29 PM take medicine",
    'Natural text: "remind me to stretch in 20 minutes"',
    'Natural text: "add reminder in 1 min 11:29 PM"'
  ].join("\n");
}

function taskUsageText(): string {
  return [
    "Task commands:",
    "/tasks",
    "/taskprogress <task_id>",
    "/tasktodo <task_id>",
    "/done <task_id>",
    "/taskremove <task_id>",
    "",
    "Natural examples:",
    "add task call bank",
    "start task 3",
    "mark task 3 done",
    "delete task 3"
  ].join("\n");
}

function parseAssistantAction(text: string, now: Date): ParsedAssistantAction | null {
  const value = text.trim();
  const normalized = value.toLowerCase();

  const createTaskMatch = value.match(
    /^(?:add|create|new)\s+(?:a\s+)?task\s*:?\s+(.+)$/i
  );
  if (createTaskMatch?.[1]) {
    return { type: "create_task", text: createTaskMatch[1].trim() };
  }

  const todoPrefixMatch = value.match(/^todo:\s*(.+)$/i);
  if (todoPrefixMatch?.[1]) {
    return { type: "create_task", text: todoPrefixMatch[1].trim() };
  }

  const statusSpecs: Array<{ regex: RegExp; status: TaskStatus }> = [
    {
      regex:
        /^(?:start|begin|move|mark|set|update)\s+task\s+#?(\d+)\s+(?:to\s+)?(?:in[\s_-]*progress|doing)$/i,
      status: "in_progress"
    },
    {
      regex:
        /^(?:mark|set|update)\s+task\s+#?(\d+)\s+(?:to\s+)?(?:to[\s_-]*do|todo|pending)$/i,
      status: "todo"
    },
    {
      regex:
        /^(?:mark|set|complete|finish|done)\s+task\s+#?(\d+)\s*(?:as\s+done)?$/i,
      status: "done"
    }
  ];

  for (const spec of statusSpecs) {
    const match = value.match(spec.regex);
    const taskId = Number(match?.[1]);
    if (match && Number.isInteger(taskId) && taskId > 0) {
      return { type: "update_task_status", taskId, status: spec.status };
    }
  }

  const deleteMatch = value.match(
    /^(?:remove|delete)\s+task\s+#?(\d+)(?:\s+please)?$/i
  );
  const deleteId = Number(deleteMatch?.[1]);
  if (deleteMatch && Number.isInteger(deleteId) && deleteId > 0) {
    return { type: "delete_task", taskId: deleteId };
  }

  if (normalized === "show tasks" || normalized === "list tasks" || normalized === "my tasks") {
    return { type: "list_tasks" };
  }

  const noteMatch = value.match(/^(?:save\s+)?note:\s*(.+)$/i);
  if (noteMatch?.[1]) {
    return { type: "create_note", text: noteMatch[1].trim() };
  }

  if (normalized === "show reminders" || normalized === "list reminders") {
    return { type: "list_reminders" };
  }

  if (
    normalized === "agenda" ||
    normalized === "show agenda" ||
    normalized === "plan my day"
  ) {
    return { type: "show_agenda" };
  }

  const reminder = parseNaturalReminder(value, now);
  if (reminder) {
    return { type: "create_reminder", reminder };
  }

  return null;
}

function cleanAiActionCandidate(value: string): string {
  return value
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/^action:\s*/i, "");
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

  const getActiveConversationId = (chatId: string): number =>
    store.getOrCreateActiveConversation(chatId).id;

  const saveConversationWithGeneratedTitle = async (
    chatId: string,
    conversationId: number,
    reason: string,
    requestedTitle?: string
  ): Promise<{ id: number; title: string } | null> => {
    const conversation = store.getConversation(chatId, conversationId);
    if (!conversation) {
      return null;
    }

    const messageCount = store.countConversationMessages(conversationId);
    if (messageCount <= 0) {
      return null;
    }

    const provided = requestedTitle?.trim();
    const title =
      provided && provided.length > 0
        ? provided
        : await assistant.generateConversationTitle(chatId, conversationId);
    const saved = store.saveConversation(chatId, conversationId, title, reason);
    if (!saved) {
      return null;
    }

    return { id: conversationId, title };
  };

  const listConversationHistory = async (
    ctx: any,
    chatId: string
  ): Promise<void> => {
    const conversations = store.listConversations(chatId, 20, true);
    const keyboard = conversationOpenKeyboard(
      conversations.filter((conversation) => conversation.status === "saved")
    );
    await ctx.reply(
      [
        "Conversation history:",
        renderConversationList(conversations),
        "",
        "Use /openchat <id> or tap a button to continue."
      ].join("\n"),
      keyboard
    );
  };

  const openConversation = async (
    chatId: string,
    conversationId: number
  ): Promise<{ ok: boolean; message: string }> => {
    const target = store.getConversation(chatId, conversationId);
    if (!target) {
      return { ok: false, message: "Conversation id not found." };
    }

    const active = store.getActiveConversation(chatId);
    if (active && active.id !== conversationId) {
      await saveConversationWithGeneratedTitle(chatId, active.id, "manual_switch");
    }

    const ok = store.activateConversation(chatId, conversationId);
    if (!ok) {
      return { ok: false, message: "Could not activate that conversation." };
    }

    const activated = store.getActiveConversation(chatId);
    if (!activated) {
      return { ok: false, message: "Conversation activation failed." };
    }

    const count = store.countConversationMessages(activated.id);
    return {
      ok: true,
      message: [
        `Active conversation: #${activated.id}`,
        `Title: ${activated.title}`,
        `Updated: ${formatUtc(activated.last_activity_at)}`,
        `Messages: ${count}`
      ].join("\n")
    };
  };

  const saveCurrentConversation = async (
    chatId: string,
    reason: string,
    requestedTitle?: string
  ): Promise<{ savedId: number; title: string } | null> => {
    const active = store.getActiveConversation(chatId);
    if (!active) {
      return null;
    }

    const saved = await saveConversationWithGeneratedTitle(
      chatId,
      active.id,
      reason,
      requestedTitle
    );
    return saved ? { savedId: saved.id, title: saved.title } : null;
  };

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
    const activeConversationId = getActiveConversationId(chatId);
    store.addMessage(chatId, "system", "User started the bot", activeConversationId);
    await ctx.reply(
      [
        "Bot is ready.",
        "Commands:",
        "/myid - show your user_id and chat_id",
        "/menu - show quick action buttons",
        "/login <password> - unlock bot access (when enabled)",
        "/logout - remove saved login (when enabled)",
        "/tasks - show task board",
        "/taskprogress <id> - move task to in progress",
        "/tasktodo <id> - move task back to todo",
        "/done <id> - mark task done",
        "/taskremove <id> - delete task",
        "/alerts - show recent alert history",
        "/alertresolve <id> - manually mark alert resolved",
        "/remind ... - create reminder",
        "/agenda - show tasks + reminders + alerts + notes",
        "/note <text> - save quick note",
        "/newchat - start fresh conversation",
        "/savechat [title] or /endchat - end and save current conversation",
        "/chats - list previous conversations",
        "/openchat <id> - continue a saved conversation",
        "/activechat - show active conversation details",
        "Use `task: <text>` to create a task."
      ].join("\n"),
      menuMarkup(config)
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
        "/tasks, /taskprogress <id>, /tasktodo <id>, /done <id>, /taskremove <id> -> manage tasks",
        "/alerts, /alertresolve <id> -> alert history/manual resolve",
        "/remind ... -> set reminder",
        "/reminders, /cancelreminder <id> -> manage reminders",
        "/note <text>, /notes, /delnote <id> -> quick notes",
        "/newchat, /savechat [title], /endchat -> conversation lifecycle",
        "/chats, /openchat <id>, /activechat -> browse and restore conversations",
        "/agenda -> daily snapshot",
        "/menu -> show action buttons when needed",
        "",
        reminderUsageText(),
        "",
        taskUsageText()
      ].join("\n"),
      menuMarkup(config)
    );
  });

  bot.command("menu", async (ctx) => {
    await ctx.reply("Quick actions", menuKeyboard());
  });

  bot.command("newchat", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }

    const saved = await saveCurrentConversation(chatId, "manual_new");
    const created = store.createConversation(chatId, "New conversation", "active");
    store.addMessage(
      chatId,
      "system",
      `Started conversation #${created.id}`,
      created.id
    );

    const lines = [
      `Started new conversation: #${created.id}`,
      `Started at: ${formatUtc(created.started_at)}`
    ];
    if (saved) {
      lines.unshift(`Saved #${saved.savedId}: ${saved.title}`);
    }
    await ctx.reply(lines.join("\n"), menuMarkup(config));
  });

  const handleSaveConversationCommand = async (ctx: any): Promise<void> => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }

    const active = store.getActiveConversation(chatId);
    if (!active) {
      await ctx.reply("No active conversation found. Send a message to start one.");
      return;
    }

    const messageCount = store.countConversationMessages(active.id);
    if (messageCount <= 0) {
      await ctx.reply("Active conversation is empty, nothing to save.");
      return;
    }

    const requestedTitle = extractCommandArgs(ctx.message.text) || undefined;
    const saved = await saveCurrentConversation(chatId, "manual_save", requestedTitle);
    if (!saved) {
      await ctx.reply("Could not save the active conversation.");
      return;
    }

    const fresh = store.createConversation(chatId, "New conversation", "active");
    store.addMessage(
      chatId,
      "system",
      `Started conversation #${fresh.id}`,
      fresh.id
    );
    await ctx.reply(
      [
        `Conversation saved: #${saved.savedId}`,
        `Title: ${saved.title}`,
        `New active conversation: #${fresh.id}`
      ].join("\n"),
      menuMarkup(config)
    );
  };

  bot.command("savechat", handleSaveConversationCommand);
  bot.command("endchat", handleSaveConversationCommand);

  bot.command("activechat", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const active = store.getActiveConversation(chatId);
    if (!active) {
      await ctx.reply("No active conversation found. Send a message to start one.");
      return;
    }
    const messageCount = store.countConversationMessages(active.id);
    await ctx.reply(
      [
        `Active conversation: #${active.id}`,
        `Title: ${active.title}`,
        `Started: ${formatUtc(active.started_at)}`,
        `Last activity: ${formatUtc(active.last_activity_at)}`,
        `Messages: ${messageCount}`
      ].join("\n"),
      menuMarkup(config)
    );
  });

  bot.command("chats", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await listConversationHistory(ctx, chatId);
  });

  bot.command("openchat", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const args = extractCommandArgs(ctx.message.text);
    const conversationId = Number(args);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      await ctx.reply("Usage: /openchat <conversation_id>");
      return;
    }

    const opened = await openConversation(chatId, conversationId);
    await ctx.reply(opened.message, menuMarkup(config));
  });

  bot.on(message("photo"), async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }

    const caption = ctx.message.caption?.trim();
    const activeConversationId = getActiveConversationId(chatId);
    store.addMessage(
      chatId,
      "user",
      caption ? `[photo] ${caption}` : "[photo]",
      activeConversationId
    );

    if (caption) {
      const localAction = parseAssistantAction(caption, new Date());
      if (localAction) {
        await ctx.reply(
          "Photo received. I detected an action in caption. Please resend as plain text for execution.",
          menuMarkup(config)
        );
        return;
      }
    }

    await ctx.reply(
      "Photo received. You can add caption like `note: ...` or send plain text command after photo.",
      menuMarkup(config)
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
    await ctx.reply("Login successful. You can use the bot now.", menuMarkup(config));
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
    const tasks = store.listTasks(chatId, true, 50);
    await ctx.reply(renderTaskList(tasks), menuMarkup(config));
  });

  bot.command("taskprogress", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const parts = ctx.message.text.trim().split(/\s+/);
    const taskId = Number(parts[1]);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      await ctx.reply("Usage: /taskprogress <task_id>");
      return;
    }
    const ok = store.setTaskStatus(chatId, taskId, "in_progress");
    await ctx.reply(ok ? `Task #${taskId} moved to in progress.` : "Task id not found.");
  });

  bot.command("tasktodo", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const parts = ctx.message.text.trim().split(/\s+/);
    const taskId = Number(parts[1]);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      await ctx.reply("Usage: /tasktodo <task_id>");
      return;
    }
    const ok = store.setTaskStatus(chatId, taskId, "todo");
    await ctx.reply(ok ? `Task #${taskId} moved to todo.` : "Task id not found.");
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

  bot.command("taskremove", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const parts = ctx.message.text.trim().split(/\s+/);
    const taskId = Number(parts[1]);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      await ctx.reply("Usage: /taskremove <task_id>");
      return;
    }
    const ok = store.deleteTask(chatId, taskId);
    await ctx.reply(ok ? `Task #${taskId} removed.` : "Task id not found.");
  });

  bot.command("alerts", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const alerts = store.listAlerts(chatId, 20);
    await ctx.reply(renderAlertList(alerts), menuMarkup(config));
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
      menuMarkup(config)
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
    const activeConversationId = getActiveConversationId(chatId);
    store.addMessage(
      chatId,
      "system",
      `Reminder #${id} created for ${formatUtc(parsed.remindAt)}: ${parsed.text}`,
      activeConversationId
    );
    await ctx.reply(
      `Reminder set: #${id}\nWhen: ${formatUtc(parsed.remindAt)}\nWhat: ${parsed.text}`,
      menuMarkup(config)
    );
  });

  bot.command("reminders", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await ctx.reply(renderReminderList(store.listUpcomingReminders(chatId, 20)), menuMarkup(config));
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
    await ctx.reply(`Note saved: #${id}`, menuMarkup(config));
  });

  bot.command("notes", async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await ctx.reply(renderNotesList(store.listNotes(chatId, 20)), menuMarkup(config));
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
    await ctx.reply(renderAgenda(store, chatId), menuMarkup(config));
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
    const activeConversationId = getActiveConversationId(chatId);
    store.addMessage(chatId, "system", `Task #${id} created: ${text}`, activeConversationId);
    await ctx.reply(`Task created: #${id} ${text}`, menuMarkup(config));
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
    await ctx.reply(`Note saved: #${id}`, menuMarkup(config));
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
    await ctx.reply(renderTaskList(store.listTasks(chatId, true, 50)), menuMarkup(config));
  });

  bot.action("task_progress_prompt", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "Send `/taskprogress <task_id>` or just say `start task <task_id>`.",
      menuMarkup(config)
    );
  });

  bot.action("task_done_prompt", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "Send `/done <task_id>` or say `mark task <task_id> done`.",
      menuMarkup(config)
    );
  });

  bot.action("task_delete_prompt", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "Send `/taskremove <task_id>` or say `delete task <task_id>`.",
      menuMarkup(config)
    );
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
    await ctx.reply(renderAlertList(store.listAlerts(chatId, 20)), menuMarkup(config));
  });

  bot.action("conversations_show", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await listConversationHistory(ctx, chatId);
  });

  bot.action(/^conv_open_(\d+)$/, async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      await ctx.answerCbQuery("Chat not found");
      return;
    }

    const data = ctx.match;
    const idText = Array.isArray(data) ? data[1] : undefined;
    const conversationId = Number(idText);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      await ctx.answerCbQuery("Invalid conversation id");
      return;
    }

    const opened = await openConversation(chatId, conversationId);
    await ctx.answerCbQuery(opened.ok ? "Conversation restored" : "Open failed");
    await ctx.reply(opened.message, menuMarkup(config));
  });

  bot.action("agenda_show", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    await ctx.reply(renderAgenda(store, chatId), menuMarkup(config));
  });

  bot.action("context_clear", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const activeConversation = store.getActiveConversation(chatId);
    if (!activeConversation) {
      await ctx.reply("No active conversation to clear.", menuMarkup(config));
      return;
    }
    const deleted = store.clearMessages(chatId, activeConversation.id);
    await ctx.reply(
      `Context cleared for conversation #${activeConversation.id} (${deleted} messages).`,
      menuMarkup(config)
    );
  });

  const executeParsedAction = async (
    action: ParsedAssistantAction,
    ctx: any,
    chatId: string,
    conversationId: number
  ): Promise<void> => {
    if (action.type === "create_task") {
      const id = store.createTask(chatId, action.text);
      store.addMessage(
        chatId,
        "system",
        `Task #${id} created: ${action.text}`,
        conversationId
      );
      await ctx.reply(`Task created: #${id} ${action.text}`, menuMarkup(config));
      return;
    }

    if (action.type === "update_task_status") {
      const ok = store.setTaskStatus(chatId, action.taskId, action.status);
      if (!ok) {
        await ctx.reply("Task id not found.");
        return;
      }
      const label =
        action.status === "in_progress"
          ? "in progress"
          : action.status === "done"
          ? "done"
          : "todo";
      await ctx.reply(`Task #${action.taskId} moved to ${label}.`, menuMarkup(config));
      return;
    }

    if (action.type === "delete_task") {
      const ok = store.deleteTask(chatId, action.taskId);
      await ctx.reply(ok ? `Task #${action.taskId} removed.` : "Task id not found.");
      return;
    }

    if (action.type === "list_tasks") {
      await ctx.reply(renderTaskList(store.listTasks(chatId, true, 50)), menuMarkup(config));
      return;
    }

    if (action.type === "create_note") {
      const id = store.createNote(chatId, action.text);
      await ctx.reply(`Note saved: #${id}`, menuMarkup(config));
      return;
    }

    if (action.type === "create_reminder") {
      if (action.reminder.remindAt.getTime() <= Date.now()) {
        await ctx.reply("Reminder time must be in the future.");
        return;
      }
      const reminderId = store.createReminder(
        chatId,
        action.reminder.text,
        action.reminder.remindAt.toISOString()
      );
      store.addMessage(
        chatId,
        "system",
        `Reminder #${reminderId} created for ${formatUtc(action.reminder.remindAt)}: ${
          action.reminder.text
        }`,
        conversationId
      );
      await ctx.reply(
        `Reminder set: #${reminderId}\nWhen: ${formatUtc(action.reminder.remindAt)}\nWhat: ${
          action.reminder.text
        }`,
        menuMarkup(config)
      );
      return;
    }

    if (action.type === "list_reminders") {
      await ctx.reply(
        renderReminderList(store.listUpcomingReminders(chatId, 20)),
        menuMarkup(config)
      );
      return;
    }

    if (action.type === "show_agenda") {
      await ctx.reply(renderAgenda(store, chatId), menuMarkup(config));
    }
  };

  bot.on(message("text"), async (ctx) => {
    const chatId = resolveChatId(ctx);
    if (!chatId) {
      return;
    }
    const text = ctx.message.text.trim();
    if (!text || isSkippableInput(text)) {
      return;
    }
    const activeConversationId = getActiveConversationId(chatId);

    const action = parseAssistantAction(text, new Date());
    if (action) {
      store.addMessage(chatId, "user", text, activeConversationId);
      await executeParsedAction(action, ctx, chatId, activeConversationId);
      return;
    }

    const aiActionText = await assistant.suggestActionCommand(chatId, text);
    if (aiActionText) {
      const cleaned = cleanAiActionCandidate(aiActionText);
      const aiParsed = parseAssistantAction(cleaned, new Date());
      if (aiParsed) {
        logDebug(config.debugMode, "AI mapped request to action", {
          chat_id: chatId,
          input: text,
          ai_action: cleaned
        });
        store.addMessage(chatId, "user", text, activeConversationId);
        await executeParsedAction(aiParsed, ctx, chatId, activeConversationId);
        return;
      }
    }

    store.addMessage(chatId, "user", text, activeConversationId);
    const answer = await assistant.answer(chatId, text, activeConversationId);
    store.addMessage(chatId, "assistant", answer, activeConversationId);
    await ctx.reply(answer, menuMarkup(config));
    logDebug(config.debugMode, "Answered message", {
      chat_id: chatId,
      user_id: resolveUserId(ctx),
      update_id: ctx.update.update_id
    });
  });

  return bot;
}
