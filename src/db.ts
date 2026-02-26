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

export type ReminderItem = {
  id: number;
  chat_id: string;
  text: string;
  remind_at: string;
  sent: number;
  sent_at: string | null;
  created_at: string;
};

export type NoteItem = {
  id: number;
  chat_id: string;
  text: string;
  created_at: string;
};

export type AlertItem = {
  id: number;
  chat_id: string;
  fingerprint: string;
  alertname: string;
  instance: string;
  severity: string;
  summary: string;
  status: "firing" | "resolved";
  source: string;
  starts_at: string;
  ends_at: string;
  manual_resolved: number;
  manual_resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AlertUpsertInput = {
  chatId: string;
  fingerprint: string;
  alertname: string;
  instance: string;
  severity: string;
  summary: string;
  status: "firing" | "resolved";
  source: string;
  startsAt: string;
  endsAt: string;
};

export type AlertUpsertResult = {
  id: number;
  isNew: boolean;
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

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        text TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        alertname TEXT NOT NULL,
        instance TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('firing', 'resolved')),
        source TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        manual_resolved INTEGER NOT NULL DEFAULT 0,
        manual_resolved_by TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(chat_id, fingerprint)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_created
      ON messages(chat_id, id DESC);

      CREATE INDEX IF NOT EXISTS idx_tasks_chat_done_created
      ON tasks(chat_id, done, id DESC);

      CREATE INDEX IF NOT EXISTS idx_reminders_due
      ON reminders(sent, remind_at, id);

      CREATE INDEX IF NOT EXISTS idx_notes_chat_created
      ON notes(chat_id, id DESC);

      CREATE INDEX IF NOT EXISTS idx_alerts_chat_status_updated
      ON alerts(chat_id, status, updated_at DESC);
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

  createReminder(chatId: string, text: string, remindAtIso: string): number {
    const result = this.db
      .prepare("INSERT INTO reminders (chat_id, text, remind_at) VALUES (?, ?, ?)")
      .run(chatId, text, remindAtIso);
    return Number(result.lastInsertRowid);
  }

  listUpcomingReminders(chatId: string, limit = 20): ReminderItem[] {
    return this.db
      .prepare(
        `
        SELECT id, chat_id, text, remind_at, sent, sent_at, created_at
        FROM reminders
        WHERE chat_id = ? AND sent = 0
        ORDER BY remind_at ASC, id ASC
        LIMIT ?
      `
      )
      .all(chatId, limit) as ReminderItem[];
  }

  listDueReminders(nowIso: string, limit = 50): ReminderItem[] {
    return this.db
      .prepare(
        `
        SELECT id, chat_id, text, remind_at, sent, sent_at, created_at
        FROM reminders
        WHERE sent = 0 AND remind_at <= ?
        ORDER BY remind_at ASC, id ASC
        LIMIT ?
      `
      )
      .all(nowIso, limit) as ReminderItem[];
  }

  markReminderSent(reminderId: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE reminders SET sent = 1, sent_at = datetime('now') WHERE id = ? AND sent = 0"
      )
      .run(reminderId);
    return result.changes > 0;
  }

  cancelReminder(chatId: string, reminderId: number): boolean {
    const result = this.db
      .prepare("DELETE FROM reminders WHERE chat_id = ? AND id = ? AND sent = 0")
      .run(chatId, reminderId);
    return result.changes > 0;
  }

  createNote(chatId: string, text: string): number {
    const result = this.db
      .prepare("INSERT INTO notes (chat_id, text) VALUES (?, ?)")
      .run(chatId, text);
    return Number(result.lastInsertRowid);
  }

  listNotes(chatId: string, limit = 20): NoteItem[] {
    return this.db
      .prepare(
        `
        SELECT id, chat_id, text, created_at
        FROM notes
        WHERE chat_id = ?
        ORDER BY id DESC
        LIMIT ?
      `
      )
      .all(chatId, limit) as NoteItem[];
  }

  deleteNote(chatId: string, noteId: number): boolean {
    const result = this.db
      .prepare("DELETE FROM notes WHERE chat_id = ? AND id = ?")
      .run(chatId, noteId);
    return result.changes > 0;
  }

  upsertAlert(input: AlertUpsertInput): AlertUpsertResult {
    const existing = this.db
      .prepare(
        `
        SELECT id
        FROM alerts
        WHERE chat_id = ? AND fingerprint = ?
        LIMIT 1
      `
      )
      .get(input.chatId, input.fingerprint) as { id: number } | undefined;

    if (existing) {
      if (input.status === "resolved") {
        this.db
          .prepare(
            `
            UPDATE alerts
            SET alertname = ?,
                instance = ?,
                severity = ?,
                summary = ?,
                status = ?,
                source = ?,
                starts_at = ?,
                ends_at = ?,
                manual_resolved = 0,
                manual_resolved_by = NULL,
                resolved_at = COALESCE(resolved_at, datetime('now')),
                updated_at = datetime('now')
            WHERE id = ?
          `
          )
          .run(
            input.alertname,
            input.instance,
            input.severity,
            input.summary,
            input.status,
            input.source,
            input.startsAt,
            input.endsAt,
            existing.id
          );
      } else {
        this.db
          .prepare(
            `
            UPDATE alerts
            SET alertname = ?,
                instance = ?,
                severity = ?,
                summary = ?,
                status = ?,
                source = ?,
                starts_at = ?,
                ends_at = ?,
                manual_resolved = 0,
                manual_resolved_by = NULL,
                resolved_at = NULL,
                updated_at = datetime('now')
            WHERE id = ?
          `
          )
          .run(
            input.alertname,
            input.instance,
            input.severity,
            input.summary,
            input.status,
            input.source,
            input.startsAt,
            input.endsAt,
            existing.id
          );
      }

      return {
        id: existing.id,
        isNew: false
      };
    }

    const resolvedAt = input.status === "resolved" ? new Date().toISOString() : null;
    const result = this.db
      .prepare(
        `
        INSERT INTO alerts (
          chat_id, fingerprint, alertname, instance, severity, summary, status,
          source, starts_at, ends_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        input.chatId,
        input.fingerprint,
        input.alertname,
        input.instance,
        input.severity,
        input.summary,
        input.status,
        input.source,
        input.startsAt,
        input.endsAt,
        resolvedAt
      );

    return {
      id: Number(result.lastInsertRowid),
      isNew: true
    };
  }

  listAlerts(chatId: string, limit = 20): AlertItem[] {
    return this.db
      .prepare(
        `
        SELECT id, chat_id, fingerprint, alertname, instance, severity, summary, status,
               source, starts_at, ends_at, manual_resolved, manual_resolved_by,
               resolved_at, created_at, updated_at
        FROM alerts
        WHERE chat_id = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `
      )
      .all(chatId, limit) as AlertItem[];
  }

  listOpenAlerts(chatId: string, limit = 20): AlertItem[] {
    return this.db
      .prepare(
        `
        SELECT id, chat_id, fingerprint, alertname, instance, severity, summary, status,
               source, starts_at, ends_at, manual_resolved, manual_resolved_by,
               resolved_at, created_at, updated_at
        FROM alerts
        WHERE chat_id = ? AND status = 'firing'
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `
      )
      .all(chatId, limit) as AlertItem[];
  }

  resolveAlertManually(chatId: string, alertId: number, userId: string): boolean {
    const result = this.db
      .prepare(
        `
        UPDATE alerts
        SET status = 'resolved',
            manual_resolved = 1,
            manual_resolved_by = ?,
            resolved_at = datetime('now'),
            updated_at = datetime('now')
        WHERE chat_id = ? AND id = ? AND status = 'firing'
      `
      )
      .run(userId, chatId, alertId);
    return result.changes > 0;
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
