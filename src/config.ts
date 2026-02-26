import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

dotenvConfig();

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  PUBLIC_BASE_URL: z.string().url("PUBLIC_BASE_URL must be a valid URL"),
  TELEGRAM_WEBHOOK_PATH_SECRET: z
    .string()
    .min(8, "TELEGRAM_WEBHOOK_PATH_SECRET should be at least 8 chars"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default("./data/bot.db"),
  ALERT_TELEGRAM_CHAT_IDS: z.string().default(""),
  INTERNAL_API_KEY: z.string().optional(),
  ALLOWED_TELEGRAM_USER_IDS: z.string().default(""),
  BOT_PASSWORD: z.string().optional(),
  DEBUG_MODE: z.string().optional(),
  REMINDER_CHECK_INTERVAL_SECONDS: z.coerce.number().int().positive().max(3600).default(30),
  AI_PROVIDER: z.enum(["auto", "openai", "gemini", "none"]).default("auto"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-1.5-flash"),
  MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().max(100).default(20)
});

export type AiProvider = "openai" | "gemini" | "none";

export type AppConfig = {
  botToken: string;
  publicBaseUrl: string;
  telegramWebhookPathSecret: string;
  port: number;
  databasePath: string;
  alertChatIds: string[];
  internalApiKey?: string;
  allowedTelegramUserIds: ReadonlySet<string>;
  botPassword?: string;
  debugMode: boolean;
  reminderCheckIntervalSeconds: number;
  aiProvider: AiProvider;
  openAiApiKey?: string;
  openAiModel: string;
  geminiApiKey?: string;
  geminiModel: string;
  maxContextMessages: number;
};

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseChatIds(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseIdSet(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

function parseBoolean(value?: string): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function resolveAiProvider(
  provider: "auto" | "openai" | "gemini" | "none",
  openAiApiKey?: string,
  geminiApiKey?: string
): AiProvider {
  if (provider === "auto") {
    if (openAiApiKey) {
      return "openai";
    }
    if (geminiApiKey) {
      return "gemini";
    }
    return "none";
  }

  if (provider === "openai") {
    if (!openAiApiKey) {
      throw new Error("AI_PROVIDER=openai requires OPENAI_API_KEY");
    }
    return "openai";
  }

  if (provider === "gemini") {
    if (!geminiApiKey) {
      throw new Error("AI_PROVIDER=gemini requires GEMINI_API_KEY");
    }
    return "gemini";
  }

  return "none";
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  const env = parsed.data;

  return {
    botToken: env.BOT_TOKEN,
    publicBaseUrl: normalizeBaseUrl(env.PUBLIC_BASE_URL),
    telegramWebhookPathSecret: env.TELEGRAM_WEBHOOK_PATH_SECRET,
    port: env.PORT,
    databasePath: env.DATABASE_PATH,
    alertChatIds: parseChatIds(env.ALERT_TELEGRAM_CHAT_IDS),
    internalApiKey: env.INTERNAL_API_KEY,
    allowedTelegramUserIds: parseIdSet(env.ALLOWED_TELEGRAM_USER_IDS),
    botPassword: env.BOT_PASSWORD,
    debugMode: parseBoolean(env.DEBUG_MODE),
    reminderCheckIntervalSeconds: env.REMINDER_CHECK_INTERVAL_SECONDS,
    aiProvider: resolveAiProvider(env.AI_PROVIDER, env.OPENAI_API_KEY, env.GEMINI_API_KEY),
    openAiApiKey: env.OPENAI_API_KEY,
    openAiModel: env.OPENAI_MODEL,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    maxContextMessages: env.MAX_CONTEXT_MESSAGES
  };
}
