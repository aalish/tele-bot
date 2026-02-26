import OpenAI from "openai";
import type { AppConfig } from "./config";
import type {
  AlertItem,
  BotStore,
  ChatMessage,
  NoteItem,
  ReminderItem,
  TaskItem
} from "./db";

type EngineDeps = {
  config: AppConfig;
  store: BotStore;
};

function summarizeTasks(tasks: TaskItem[]): string {
  if (tasks.length === 0) {
    return "No open tasks.";
  }

  return tasks.map((task) => `#${task.id} [${task.status}] ${task.text}`).join("\n");
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

function normalizeGeneratedTitle(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const cleaned = value
    .trim()
    .replace(/^title\s*:\s*/i, "")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return null;
  }

  return cleaned.length > 80 ? cleaned.slice(0, 80).trimEnd() : cleaned;
}

function fallbackConversationTitle(messages: ChatMessage[]): string {
  const userMessages = messages.filter((message) => message.role === "user");
  const source =
    userMessages[userMessages.length - 1]?.content ??
    messages[messages.length - 1]?.content ??
    "Conversation";

  const cleaned = source
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F]/g, "")
    .trim();

  if (!cleaned) {
    return "Conversation";
  }

  const words = cleaned.split(" ").slice(0, 8);
  const title = words.join(" ");
  return title.length > 80 ? title.slice(0, 80).trimEnd() : title;
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

  async answer(chatId: string, userText: string, conversationId?: number): Promise<string> {
    const tasks = this.store.listTasks(chatId, false, 10);
    const reminders = this.store.listUpcomingReminders(chatId, 10);
    const notes = this.store.listNotes(chatId, 10);
    const openAlerts = this.store.listOpenAlerts(chatId, 10);
    const messages = this.store.getRecentMessages(
      chatId,
      this.config.maxContextMessages,
      conversationId
    );
    const conversation =
      conversationId !== undefined
        ? this.store.getConversation(chatId, conversationId)
        : this.store.getActiveConversation(chatId);

    const systemPrompt =
      "You are a concise Telegram task assistant. Use provided task/context memory. If unsure, say what is unknown.";
    const contextPrompt = [
      "Conversation:",
      conversation
        ? `id=${conversation.id}, title=${conversation.title}, status=${conversation.status}`
        : "(unknown)",
      "",
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

  async generateConversationTitle(chatId: string, conversationId: number): Promise<string> {
    const messages = this.store.listConversationMessages(chatId, conversationId, 30);
    const fallback = fallbackConversationTitle(messages);

    if (messages.length === 0 || this.config.aiProvider === "none") {
      return fallback;
    }

    const transcript = messages
      .map((message) => `[${message.role}] ${message.content}`)
      .join("\n")
      .slice(0, 5000);

    const instruction = [
      "Generate a concise, meaningful title for this conversation.",
      "Rules:",
      "- Return only the title.",
      "- Max 8 words.",
      "- No quotes.",
      "- Use plain text."
    ].join("\n");

    try {
      if (this.config.aiProvider === "openai" && this.client) {
        const completion = await this.client.chat.completions.create({
          model: this.config.openAiModel,
          temperature: 0.1,
          max_tokens: 24,
          messages: [
            { role: "system", content: instruction },
            { role: "user", content: transcript }
          ]
        });
        const raw = completion.choices[0]?.message?.content?.trim();
        const title = normalizeGeneratedTitle(raw);
        if (title) {
          return title;
        }
      }

      if (this.config.aiProvider === "gemini") {
        const raw = await this.answerWithGemini(instruction, "", transcript);
        const title = normalizeGeneratedTitle(raw);
        if (title) {
          return title;
        }
      }
    } catch (error) {
      console.error("Conversation title generation failed:", error);
    }

    return fallback;
  }

  async suggestActionCommand(chatId: string, userText: string): Promise<string | null> {
    if (this.config.aiProvider === "none") {
      return null;
    }

    const tasks = this.store.listTasks(chatId, true, 20);
    const reminders = this.store.listUpcomingReminders(chatId, 10);
    const notes = this.store.listNotes(chatId, 10);

    const instruction = [
      "You are an intent router for a Telegram assistant.",
      "Return exactly one line.",
      "If the user request maps to an operation, output one of these patterns exactly:",
      "add task <text>",
      "start task <id>",
      "mark task <id> done",
      "mark task <id> to todo",
      "delete task <id>",
      "add reminder in <number> min <text>",
      "add reminder in <number> hour <text>",
      "add reminder at <HH:MM AM/PM> <text>",
      "note: <text>",
      "show tasks",
      "show reminders",
      "agenda",
      "If operation mapping is unclear, return NONE."
    ].join("\n");

    const context = [
      "Current tasks:",
      summarizeTasks(tasks),
      "",
      "Current reminders:",
      summarizeReminders(reminders),
      "",
      "Recent notes:",
      summarizeNotes(notes)
    ].join("\n");

    try {
      if (this.config.aiProvider === "openai" && this.client) {
        const completion = await this.client.chat.completions.create({
          model: this.config.openAiModel,
          temperature: 0,
          messages: [
            { role: "system", content: instruction },
            { role: "system", content: context },
            { role: "user", content: userText }
          ]
        });
        const output = completion.choices[0]?.message?.content?.trim();
        if (!output || /^none$/i.test(output)) {
          return null;
        }
        return output.split("\n")[0]?.trim() || null;
      }

      if (this.config.aiProvider === "gemini") {
        const output = await this.answerWithGemini(
          instruction,
          context,
          `User request: ${userText}`
        );
        if (!output || /^none$/i.test(output.trim())) {
          return null;
        }
        return output.split("\n")[0]?.trim() || null;
      }
    } catch (error) {
      console.error("AI action routing failed:", error);
    }

    return null;
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
                text: `${contextPrompt ? `${contextPrompt}\n\n` : ""}User question:\n${userText}`
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
