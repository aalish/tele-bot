import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AssistantEngine } from "./assistant";
import { formatAlertMessage, alertmanagerPayloadSchema } from "./alertmanager";
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

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new BotStore(config.databasePath);
  const assistant = new AssistantEngine({ config, store });
  const bot = createBot({ config, store, assistant });
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/send-personal", async (req, res) => {
    if (config.internalApiKey) {
      const provided = req.headers["x-api-key"];
      if (provided !== config.internalApiKey) {
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

    const text = formatAlertMessage(parsed.data);

    const results = await Promise.allSettled(
      config.alertChatIds.map(async (chatId) => {
        await bot.telegram.sendMessage(chatId, text);
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
      failed_count: failed.length
    });
  });

  const webhookPath = `/webhooks/telegram/${config.telegramWebhookPathSecret}`;
  app.use(webhookPath, bot.webhookCallback(webhookPath));

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled HTTP error:", error);
    res.status(500).json(makeErrorResponse("Internal server error"));
  });

  const server = app.listen(config.port, async () => {
    const webhookUrl = `${config.publicBaseUrl}${webhookPath}`;
    try {
      await bot.telegram.setWebhook(webhookUrl);
      await bot.telegram.setMyCommands([
        { command: "start", description: "Initialize bot" },
        { command: "myid", description: "Show user_id and chat_id" },
        { command: "login", description: "Authenticate with password" },
        { command: "logout", description: "Clear saved login" },
        { command: "tasks", description: "List open tasks" },
        { command: "done", description: "Mark a task done (/done <id>)" },
        { command: "help", description: "Show help" }
      ]);
      console.log(`Server listening on :${config.port}`);
      console.log(`Telegram webhook set to: ${webhookUrl}`);
    } catch (error) {
      console.error("Webhook setup failed:", error);
    }
  });

  const shutdown = () => {
    console.log("Shutting down...");
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
