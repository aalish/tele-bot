import { Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { AssistantEngine } from "./assistant";
import type { AppConfig } from "./config";
import type { BotStore, TaskItem } from "./db";

type BotDeps = {
  config: AppConfig;
  store: BotStore;
  assistant: AssistantEngine;
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
    [Markup.button.callback("Create task", "task_create")],
    [Markup.button.callback("List tasks", "task_list")],
    [Markup.button.callback("Clear context", "context_clear")]
  ]);
}

function renderTaskList(tasks: TaskItem[]): string {
  if (tasks.length === 0) {
    return "No open tasks.";
  }

  return tasks.map((task) => `#${task.id} ${task.text}`).join("\n");
}

function isSkippableInput(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("task:") ||
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
        "Send plain text to ask questions.",
        "Use `task: <text>` to save tasks.",
        "Use `/login <password>` if bot access is password protected.",
        "Use `/done <id>` when finished."
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
