import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AssistantEngine } from "./assistant";
import {
  alertmanagerPayloadSchema,
  formatAlertMessage,
  normalizeAlertEvents
} from "./alertmanager";
import { createBot } from "./bot";
import { loadConfig } from "./config";
import { BotStore } from "./db";

const sendPersonalSchema = z.object({
  chatId: z.string().min(1),
  text: z.string().min(1).max(3900)
});

function makeErrorResponse(message: string, details?: unknown) {
  return { ok: false, message, details };
}

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

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new BotStore(config.databasePath);
  const assistant = new AssistantEngine({ config, store });
  const bot = createBot({ config, store, assistant });
  const app = express();
  const webhookPath = `/webhooks/telegram/${config.telegramWebhookPathSecret}`;

  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    if (!config.debugMode) {
      next();
      return;
    }
    const start = Date.now();
    const isTrackedPath =
      req.path === webhookPath ||
      req.path === "/webhooks/alertmanager" ||
      req.path === "/api/send-personal";
    if (isTrackedPath) {
      const body = req.body as Record<string, unknown> | undefined;
      logDebug(config.debugMode, "Incoming request", {
        method: req.method,
        path: req.path,
        hasBody: Boolean(body),
        bodyKeys: body && typeof body === "object" ? Object.keys(body).slice(0, 10) : []
      });
    }
    res.on("finish", () => {
      if (isTrackedPath) {
        logDebug(config.debugMode, "Request completed", {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - start
        });
      }
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/send-personal", async (req, res) => {
    if (config.internalApiKey) {
      const provided = req.headers["x-api-key"];
      if (provided !== config.internalApiKey) {
        logDebug(config.debugMode, "send-personal unauthorized");
        res.status(401).json(makeErrorResponse("Unauthorized"));
        return;
      }
    }

    const parsed = sendPersonalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(makeErrorResponse("Invalid payload", parsed.error.flatten()));
      return;
    }

    try {
      await bot.telegram.sendMessage(parsed.data.chatId, parsed.data.text);
      res.json({ ok: true });
    } catch (error) {
      console.error("send-personal failed:", error);
      res.status(500).json(makeErrorResponse("Failed to send message"));
    }
  });

  app.post("/webhooks/alertmanager", async (req, res) => {
    const parsed = alertmanagerPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(makeErrorResponse("Invalid alertmanager payload"));
      return;
    }

    if (config.alertChatIds.length === 0) {
      res.status(400).json(
        makeErrorResponse("No target chat ids configured. Set ALERT_TELEGRAM_CHAT_IDS")
      );
      return;
    }

    const events = normalizeAlertEvents(parsed.data);
    logDebug(config.debugMode, "Alertmanager payload accepted", {
      alerts: parsed.data.alerts.length,
      status: parsed.data.status
    });

    const results = await Promise.allSettled(
      config.alertChatIds.map(async (chatId) => {
        if (events.length === 0) {
          await bot.telegram.sendMessage(chatId, formatAlertMessage(parsed.data));
          return chatId;
        }

        const lines: string[] = [];
        lines.push(`Alertmanager update: ${parsed.data.status ?? "unknown"}`);

        for (const event of events) {
          const saved = store.upsertAlert({
            chatId,
            fingerprint: event.fingerprint,
            alertname: event.alertname,
            instance: event.instance,
            severity: event.severity,
            summary: event.summary,
            status: event.status,
            source: event.source,
            startsAt: event.startsAt,
            endsAt: event.endsAt
          });
          const statusLabel = event.status === "resolved" ? "RESOLVED" : "FIRING";
          lines.push(
            `- #${saved.id} [${statusLabel}] ${event.alertname} (${event.severity}) on ${event.instance}`
          );
          lines.push(`  ${event.summary}`);
        }

        lines.push("");
        lines.push("Commands: /alerts  /alertresolve <id>");
        const rendered = lines.join("\n");
        await bot.telegram.sendMessage(
          chatId,
          rendered.length > 3900 ? `${rendered.slice(0, 3900)}\n...truncated` : rendered
        );
        return chatId;
      })
    );

    const sent: string[] = [];
    const failed: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        sent.push(result.value);
      } else {
        failed.push(String(result.reason));
      }
    }

    res.json({
      ok: failed.length === 0,
      sent_count: sent.length,
      failed_count: failed.length,
      tracked_alerts: events.length
    });
  });

  // Important: do not mount at webhookPath and pass webhookPath together.
  // Telegraf validates the full path internally; double-mounting can produce 404.
  app.use(bot.webhookCallback(webhookPath));

  app.get("/debug/webhook-info", async (req, res) => {
    if (config.internalApiKey) {
      const provided = req.headers["x-api-key"];
      if (provided !== config.internalApiKey) {
        res.status(401).json(makeErrorResponse("Unauthorized"));
        return;
      }
    }
    try {
      const info = await bot.telegram.getWebhookInfo();
      res.json({ ok: true, info });
    } catch (error) {
      console.error("getWebhookInfo failed:", error);
      res.status(500).json(makeErrorResponse("Failed to fetch webhook info"));
    }
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled HTTP error:", error);
    res.status(500).json(makeErrorResponse("Internal server error"));
  });

  let reminderTickInProgress = false;
  const runReminderTick = async (): Promise<void> => {
    if (reminderTickInProgress) {
      return;
    }
    reminderTickInProgress = true;
    try {
      const due = store.listDueReminders(new Date().toISOString(), 50);
      if (due.length > 0) {
        logDebug(config.debugMode, "Processing due reminders", { count: due.length });
      }
      for (const reminder of due) {
        try {
          await bot.telegram.sendMessage(
            reminder.chat_id,
            `Reminder (#${reminder.id}): ${reminder.text}`
          );
          store.markReminderSent(reminder.id);
        } catch (error) {
          console.error(`Failed to send reminder #${reminder.id}:`, error);
        }
      }
    } finally {
      reminderTickInProgress = false;
    }
  };

  const reminderTimer = setInterval(() => {
    void runReminderTick();
  }, config.reminderCheckIntervalSeconds * 1000);

  const server = app.listen(config.port, async () => {
    const webhookUrl = `${config.publicBaseUrl}${webhookPath}`;
    try {
      logDebug(config.debugMode, "Attempting setWebhook", { webhookUrl });
      await bot.telegram.setWebhook(webhookUrl);
      await bot.telegram.setMyCommands([
        { command: "start", description: "Initialize bot" },
        { command: "myid", description: "Show user_id and chat_id" },
        { command: "login", description: "Authenticate with password" },
        { command: "logout", description: "Clear saved login" },
        { command: "tasks", description: "Show task board" },
        { command: "taskprogress", description: "Move task to in progress" },
        { command: "tasktodo", description: "Move task to todo" },
        { command: "done", description: "Mark a task done (/done <id>)" },
        { command: "taskremove", description: "Delete task by id" },
        { command: "alerts", description: "List recent alerts" },
        { command: "alertresolve", description: "Resolve alert by id" },
        { command: "remind", description: "Create reminder" },
        { command: "reminders", description: "List reminders" },
        { command: "cancelreminder", description: "Cancel reminder by id" },
        { command: "note", description: "Save quick note" },
        { command: "notes", description: "List notes" },
        { command: "delnote", description: "Delete note by id" },
        { command: "agenda", description: "Daily snapshot" },
        { command: "help", description: "Show help" }
      ]);
      console.log(`Server listening on :${config.port}`);
      console.log(`Telegram webhook set to: ${webhookUrl}`);
      if (config.debugMode) {
        const webhookInfo = await bot.telegram.getWebhookInfo();
        logDebug(config.debugMode, "Telegram webhook info", {
          url: webhookInfo.url,
          pending_update_count: webhookInfo.pending_update_count,
          last_error_date: webhookInfo.last_error_date,
          last_error_message: webhookInfo.last_error_message,
          max_connections: webhookInfo.max_connections,
          ip_address: webhookInfo.ip_address
        });
      }
      await runReminderTick();
    } catch (error) {
      console.error("Webhook setup failed:", error);
    }
  });

  const shutdown = () => {
    console.log("Shutting down...");
    clearInterval(reminderTimer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
