import OpenAI from "openai";
import type { AppConfig } from "./config";
import type { BotStore, TaskItem } from "./db";

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
    const messages = this.store.getRecentMessages(chatId, this.config.maxContextMessages);
    const systemPrompt =
      "You are a concise Telegram task assistant. Use provided task/context memory. If unsure, say what is unknown.";
    const contextPrompt = [
      "Open tasks:",
      summarizeTasks(tasks),
      "",
      "Conversation memory:",
      messages.map((m) => `[${m.role}] ${m.content}`).join("\n") || "(none)"
    ].join("\n");

    if (this.config.aiProvider === "none") {
      return this.fallbackAnswer(userText, tasks);
    }

    try {
      if (this.config.aiProvider === "openai") {
        if (!this.client) {
          return this.fallbackAnswer(userText, tasks);
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

    return this.fallbackAnswer(userText, tasks);
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

  private fallbackAnswer(userText: string, tasks: TaskItem[]): string {
    const normalized = userText.toLowerCase();

    if (normalized.includes("task") || normalized.includes("todo")) {
      return `Open tasks:\n${summarizeTasks(tasks)}`;
    }

    if (normalized.includes("remember") || normalized.includes("context")) {
      return [
        "I keep memory for this chat in SQLite.",
        `Current open tasks:\n${summarizeTasks(tasks)}`
      ].join("\n");
    }

    if (tasks.length > 0) {
      return `I saved your message. Current open tasks:\n${summarizeTasks(tasks)}`;
    }

    return "I saved your message. Send `task: <something>` to create your first task.";
  }
}
