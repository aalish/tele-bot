import OpenAI from "openai";
import type { AppConfig } from "./config";
import type { AlertItem, BotStore, NoteItem, ReminderItem, TaskItem } from "./db";

type EngineDeps = {
  config: AppConfig;
  store: BotStore;
};

function summarizeTasks(tasks: TaskItem[]): string {
  if (tasks.length === 0) {
    return "No open tasks.";
  }

  return tasks.map((task) => `#${task.id} ${task.text}`).join("\n");
}

function summarizeReminders(reminders: ReminderItem[]): string {
  if (reminders.length === 0) {
    return "No pending reminders.";
  }

  return reminders
    .map((reminder) => `#${reminder.id} [${reminder.remind_at}] ${reminder.text}`)
    .join("\n");
}

function summarizeNotes(notes: NoteItem[]): string {
  if (notes.length === 0) {
    return "No notes.";
  }

  return notes.map((note) => `#${note.id} ${note.text}`).join("\n");
}

function summarizeOpenAlerts(alerts: AlertItem[]): string {
  if (alerts.length === 0) {
    return "No open alerts.";
  }

  return alerts
    .map((alert) => `#${alert.id} ${alert.alertname} (${alert.severity}) on ${alert.instance}`)
    .join("\n");
}

export class AssistantEngine {
  private readonly client?: OpenAI;
  private readonly config: AppConfig;
  private readonly store: BotStore;

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.store = deps.store;
    if (this.config.aiProvider === "openai" && this.config.openAiApiKey) {
      this.client = new OpenAI({ apiKey: this.config.openAiApiKey });
    }
  }

  async answer(chatId: string, userText: string): Promise<string> {
    const tasks = this.store.listTasks(chatId, false, 10);
    const reminders = this.store.listUpcomingReminders(chatId, 10);
    const notes = this.store.listNotes(chatId, 10);
    const openAlerts = this.store.listOpenAlerts(chatId, 10);
    const messages = this.store.getRecentMessages(chatId, this.config.maxContextMessages);
    const systemPrompt =
      "You are a concise Telegram task assistant. Use provided task/context memory. If unsure, say what is unknown.";
    const contextPrompt = [
      "Open tasks:",
      summarizeTasks(tasks),
      "",
      "Pending reminders:",
      summarizeReminders(reminders),
      "",
      "Recent notes:",
      summarizeNotes(notes),
      "",
      "Open alerts:",
      summarizeOpenAlerts(openAlerts),
      "",
      "Conversation memory:",
      messages.map((m) => `[${m.role}] ${m.content}`).join("\n") || "(none)"
    ].join("\n");

    if (this.config.aiProvider === "none") {
      return this.fallbackAnswer(userText, tasks, reminders, notes, openAlerts);
    }

    try {
      if (this.config.aiProvider === "openai") {
        if (!this.client) {
          return this.fallbackAnswer(userText, tasks, reminders, notes, openAlerts);
        }
        const completion = await this.client.chat.completions.create({
          model: this.config.openAiModel,
          temperature: 0.2,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "system", content: contextPrompt },
            { role: "user", content: userText }
          ]
        });

        const text = completion.choices[0]?.message?.content?.trim();
        if (text) {
          return text;
        }
      }

      if (this.config.aiProvider === "gemini") {
        const text = await this.answerWithGemini(systemPrompt, contextPrompt, userText);
        if (text) {
          return text;
        }
      }
    } catch (error) {
      console.error("AI request failed:", error);
    }

    return this.fallbackAnswer(userText, tasks, reminders, notes, openAlerts);
  }

  private async answerWithGemini(
    systemPrompt: string,
    contextPrompt: string,
    userText: string
  ): Promise<string | null> {
    if (!this.config.geminiApiKey) {
      return null;
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.config.geminiModel
    )}:generateContent?key=${encodeURIComponent(this.config.geminiApiKey)}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `${contextPrompt}\n\nUser question:\n${userText}`
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2
        }
      })
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Gemini request failed: ${response.status} ${details}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text?.trim())
        .filter(Boolean)
        .join("\n") ?? "";

    return text || null;
  }

  private fallbackAnswer(
    userText: string,
    tasks: TaskItem[],
    reminders: ReminderItem[],
    notes: NoteItem[],
    openAlerts: AlertItem[]
  ): string {
    const normalized = userText.toLowerCase();

    if (normalized.includes("task") || normalized.includes("todo")) {
      return `Open tasks:\n${summarizeTasks(tasks)}`;
    }

    if (normalized.includes("reminder") || normalized.includes("remind")) {
      return `Pending reminders:\n${summarizeReminders(reminders)}`;
    }

    if (normalized.includes("note")) {
      return `Recent notes:\n${summarizeNotes(notes)}`;
    }

    if (normalized.includes("alert")) {
      return `Open alerts:\n${summarizeOpenAlerts(openAlerts)}`;
    }

    if (normalized.includes("remember") || normalized.includes("context")) {
      return [
        "I keep memory for this chat in SQLite.",
        `Current open tasks:\n${summarizeTasks(tasks)}`,
        `Pending reminders:\n${summarizeReminders(reminders)}`,
        `Open alerts:\n${summarizeOpenAlerts(openAlerts)}`
      ].join("\n");
    }

    if (tasks.length > 0 || reminders.length > 0 || openAlerts.length > 0) {
      return [
        "I saved your message.",
        `Current open tasks:\n${summarizeTasks(tasks)}`,
        `Pending reminders:\n${summarizeReminders(reminders)}`,
        `Open alerts:\n${summarizeOpenAlerts(openAlerts)}`
      ].join("\n");
    }

    return [
      "I saved your message.",
      "Use `task: <something>` to create a task.",
      "Use `/remind ...` or say `remind me to ... in 20 minutes` for reminders."
    ].join("\n");
  }
}
