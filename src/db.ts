import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: number;
  chat_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
};

export type TaskItem = {
  id: number;
  chat_id: string;
  text: string;
  done: number;
  created_at: string;
};

export class BotStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS authorized_users (
        user_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_created
      ON messages(chat_id, id DESC);

      CREATE INDEX IF NOT EXISTS idx_tasks_chat_done_created
      ON tasks(chat_id, done, id DESC);
    `);
  }

  addMessage(chatId: string, role: ChatRole, content: string): void {
    this.db
      .prepare(
        "INSERT INTO messages (chat_id, role, content) VALUES (@chat_id, @role, @content)"
      )
      .run({ chat_id: chatId, role, content });
  }

  getRecentMessages(chatId: string, limit: number): ChatMessage[] {
    return this.db
      .prepare(
        `
        SELECT id, chat_id, role, content, created_at
        FROM messages
        WHERE chat_id = ?
        ORDER BY id DESC
        LIMIT ?
      `
      )
      .all(chatId, limit)
      .reverse() as ChatMessage[];
  }

  clearMessages(chatId: string): number {
    const result = this.db
      .prepare("DELETE FROM messages WHERE chat_id = ?")
      .run(chatId);
    return result.changes;
  }

  createTask(chatId: string, text: string): number {
    const result = this.db
      .prepare("INSERT INTO tasks (chat_id, text) VALUES (?, ?)")
      .run(chatId, text);
    return Number(result.lastInsertRowid);
  }

  listTasks(chatId: string, includeDone = false, limit = 20): TaskItem[] {
    if (includeDone) {
      return this.db
        .prepare(
          `
          SELECT id, chat_id, text, done, created_at
          FROM tasks
          WHERE chat_id = ?
          ORDER BY id DESC
          LIMIT ?
        `
        )
        .all(chatId, limit) as TaskItem[];
    }

    return this.db
      .prepare(
        `
        SELECT id, chat_id, text, done, created_at
        FROM tasks
        WHERE chat_id = ? AND done = 0
        ORDER BY id DESC
        LIMIT ?
      `
      )
      .all(chatId, limit) as TaskItem[];
  }

  markTaskDone(chatId: string, taskId: number): boolean {
    const result = this.db
      .prepare("UPDATE tasks SET done = 1 WHERE chat_id = ? AND id = ?")
      .run(chatId, taskId);
    return result.changes > 0;
  }

  clearTasks(chatId: string): number {
    const result = this.db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(chatId);
    return result.changes;
  }

  authorizeUser(userId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO authorized_users (user_id) VALUES (?)")
      .run(userId);
  }

  revokeAuthorizedUser(userId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM authorized_users WHERE user_id = ?")
      .run(userId);
    return result.changes > 0;
  }

  isAuthorizedUser(userId: string): boolean {
    const row = this.db
      .prepare("SELECT user_id FROM authorized_users WHERE user_id = ? LIMIT 1")
      .get(userId) as { user_id: string } | undefined;
    return Boolean(row);
  }

  close(): void {
    this.db.close();
  }
}
