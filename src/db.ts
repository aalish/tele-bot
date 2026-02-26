import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type ChatRole = "user" | "assistant" | "system";
export type TaskStatus = "todo" | "in_progress" | "done";
export type ConversationStatus = "active" | "saved";

export type ChatMessage = {
  id: number;
  chat_id: string;
  conversation_id: number | null;
  role: ChatRole;
  content: string;
  created_at: string;
};

export type ConversationItem = {
  id: number;
  chat_id: string;
  title: string;
  status: ConversationStatus;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
  saved_reason: string | null;
};

export type ConversationListItem = ConversationItem & {
  message_count: number;
};

export type TaskItem = {
  id: number;
  chat_id: string;
  text: string;
  status: TaskStatus;
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
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'saved')),
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        last_activity_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ended_at TEXT,
        saved_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        conversation_id INTEGER,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'done')),
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

      CREATE INDEX IF NOT EXISTS idx_conversations_chat_status_activity
      ON conversations(chat_id, status, last_activity_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_chat_created
      ON messages(chat_id, id DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
      ON messages(conversation_id, id DESC);

      CREATE INDEX IF NOT EXISTS idx_tasks_chat_done_created
      ON tasks(chat_id, done, id DESC);

      CREATE INDEX IF NOT EXISTS idx_tasks_chat_status_created
      ON tasks(chat_id, status, id DESC);

      CREATE INDEX IF NOT EXISTS idx_reminders_due
      ON reminders(sent, remind_at, id);

      CREATE INDEX IF NOT EXISTS idx_notes_chat_created
      ON notes(chat_id, id DESC);

      CREATE INDEX IF NOT EXISTS idx_alerts_chat_status_updated
      ON alerts(chat_id, status, updated_at DESC);
    `);

    this.migrateTasksTable();
    this.migrateMessagesTable();
    this.migrateConversationBackfill();
  }

  private migrateTasksTable(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    if (!names.has("status")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'"
      );
    }

    if (!names.has("done")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0");
    }

    this.db.exec(`
      UPDATE tasks
      SET status = CASE
        WHEN done = 1 THEN 'done'
        WHEN status NOT IN ('todo', 'in_progress', 'done') THEN 'todo'
        ELSE status
      END;

      UPDATE tasks
      SET done = CASE WHEN status = 'done' THEN 1 ELSE 0 END;
    `);
  }

  private migrateMessagesTable(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(messages)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    if (!names.has("conversation_id")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN conversation_id INTEGER");
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
      ON messages(conversation_id, id DESC);
    `);
  }

  private migrateConversationBackfill(): void {
    const rows = this.db
      .prepare(
        `
          SELECT chat_id,
                 MIN(created_at) AS started_at,
                 MAX(created_at) AS last_activity_at,
                 COUNT(*) AS message_count
          FROM messages
          WHERE conversation_id IS NULL
          GROUP BY chat_id
        `
      )
      .all() as Array<{
      chat_id: string;
      started_at: string | null;
      last_activity_at: string | null;
      message_count: number;
    }>;

    if (rows.length === 0) {
      return;
    }

    const nowIso = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        if (!row.chat_id || row.message_count <= 0) {
          continue;
        }

        const active = this.db
          .prepare(
            `
              SELECT id
              FROM conversations
              WHERE chat_id = ? AND status = 'active'
              ORDER BY id DESC
              LIMIT 1
            `
          )
          .get(row.chat_id) as { id: number } | undefined;

        let conversationId: number;
        if (active) {
          conversationId = active.id;
        } else {
          const insert = this.db
            .prepare(
              `
                INSERT INTO conversations (
                  chat_id, title, status, started_at, last_activity_at
                ) VALUES (?, ?, 'active', ?, ?)
              `
            )
            .run(
              row.chat_id,
              "Recovered conversation",
              row.started_at ?? nowIso,
              row.last_activity_at ?? nowIso
            );
          conversationId = Number(insert.lastInsertRowid);
        }

        this.db
          .prepare(
            "UPDATE messages SET conversation_id = ? WHERE chat_id = ? AND conversation_id IS NULL"
          )
          .run(conversationId, row.chat_id);
      }
    });

    transaction();
  }

  private deactivateActiveConversations(chatId: string, reason: string): void {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `
          UPDATE conversations
          SET status = 'saved',
              ended_at = COALESCE(ended_at, ?),
              saved_reason = COALESCE(saved_reason, ?)
          WHERE chat_id = ? AND status = 'active'
        `
      )
      .run(nowIso, reason, chatId);
  }

  getConversation(chatId: string, conversationId: number): ConversationItem | null {
    const row = this.db
      .prepare(
        `
          SELECT id, chat_id, title, status, started_at, last_activity_at, ended_at, saved_reason
          FROM conversations
          WHERE chat_id = ? AND id = ?
          LIMIT 1
        `
      )
      .get(chatId, conversationId) as ConversationItem | undefined;
    return row ?? null;
  }

  getActiveConversation(chatId: string): ConversationItem | null {
    const row = this.db
      .prepare(
        `
          SELECT id, chat_id, title, status, started_at, last_activity_at, ended_at, saved_reason
          FROM conversations
          WHERE chat_id = ? AND status = 'active'
          ORDER BY id DESC
          LIMIT 1
        `
      )
      .get(chatId) as ConversationItem | undefined;
    return row ?? null;
  }

  getOrCreateActiveConversation(chatId: string): ConversationItem {
    const existing = this.getActiveConversation(chatId);
    if (existing) {
      return existing;
    }
    return this.createConversation(chatId, "New conversation", "active");
  }

  createConversation(
    chatId: string,
    title = "New conversation",
    status: ConversationStatus = "active"
  ): ConversationItem {
    const cleanTitle = title.trim() || "New conversation";
    const nowIso = new Date().toISOString();

    const transaction = this.db.transaction(() => {
      if (status === "active") {
        this.deactivateActiveConversations(chatId, "switched");
      }

      const insert = this.db
        .prepare(
          `
            INSERT INTO conversations (
              chat_id, title, status, started_at, last_activity_at, ended_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `
        )
        .run(chatId, cleanTitle, status, nowIso, nowIso, status === "saved" ? nowIso : null);

      const createdId = Number(insert.lastInsertRowid);
      const created = this.getConversation(chatId, createdId);
      if (!created) {
        throw new Error("Failed to create conversation");
      }
      return created;
    });

    return transaction();
  }

  activateConversation(chatId: string, conversationId: number): boolean {
    const transaction = this.db.transaction(() => {
      const target = this.getConversation(chatId, conversationId);
      if (!target) {
        return false;
      }

      const nowIso = new Date().toISOString();
      this.db
        .prepare(
          `
            UPDATE conversations
            SET status = 'saved',
                ended_at = COALESCE(ended_at, ?),
                saved_reason = COALESCE(saved_reason, 'switched')
            WHERE chat_id = ? AND status = 'active' AND id != ?
          `
        )
        .run(nowIso, chatId, conversationId);

      this.db
        .prepare(
          `
            UPDATE conversations
            SET status = 'active',
                ended_at = NULL,
                saved_reason = NULL,
                last_activity_at = ?
            WHERE chat_id = ? AND id = ?
          `
        )
        .run(nowIso, chatId, conversationId);

      return true;
    });

    return transaction();
  }

  saveConversation(
    chatId: string,
    conversationId: number,
    title: string,
    reason = "manual"
  ): boolean {
    const current = this.getConversation(chatId, conversationId);
    if (!current) {
      return false;
    }

    const cleanTitle = title.trim() || current.title;
    const nowIso = new Date().toISOString();
    const result = this.db
      .prepare(
        `
          UPDATE conversations
          SET title = ?,
              status = 'saved',
              ended_at = COALESCE(ended_at, ?),
              saved_reason = ?
          WHERE chat_id = ? AND id = ?
        `
      )
      .run(cleanTitle, nowIso, reason, chatId, conversationId);

    return result.changes > 0;
  }

  touchConversation(conversationId: number): boolean {
    const result = this.db
      .prepare("UPDATE conversations SET last_activity_at = ? WHERE id = ?")
      .run(new Date().toISOString(), conversationId);
    return result.changes > 0;
  }

  listConversations(chatId: string, limit = 20, includeActive = true): ConversationListItem[] {
    if (includeActive) {
      return this.db
        .prepare(
          `
            SELECT c.id, c.chat_id, c.title, c.status, c.started_at, c.last_activity_at,
                   c.ended_at, c.saved_reason, COUNT(m.id) AS message_count
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            WHERE c.chat_id = ?
            GROUP BY c.id
            ORDER BY CASE WHEN c.status = 'active' THEN 0 ELSE 1 END,
                     datetime(c.last_activity_at) DESC,
                     c.id DESC
            LIMIT ?
          `
        )
        .all(chatId, limit) as ConversationListItem[];
    }

    return this.db
      .prepare(
        `
          SELECT c.id, c.chat_id, c.title, c.status, c.started_at, c.last_activity_at,
                 c.ended_at, c.saved_reason, COUNT(m.id) AS message_count
          FROM conversations c
          LEFT JOIN messages m ON m.conversation_id = c.id
          WHERE c.chat_id = ? AND c.status = 'saved'
          GROUP BY c.id
          ORDER BY datetime(c.last_activity_at) DESC, c.id DESC
          LIMIT ?
        `
      )
      .all(chatId, limit) as ConversationListItem[];
  }

  listSavedConversations(chatId: string, limit = 20): ConversationListItem[] {
    return this.listConversations(chatId, limit, false);
  }

  listConversationMessages(
    chatId: string,
    conversationId: number,
    limit = 200
  ): ChatMessage[] {
    return this.db
      .prepare(
        `
          SELECT id, chat_id, conversation_id, role, content, created_at
          FROM messages
          WHERE chat_id = ? AND conversation_id = ?
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(chatId, conversationId, limit)
      .reverse() as ChatMessage[];
  }

  countConversationMessages(conversationId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { count: number };
    return Number(row.count);
  }

  listStaleActiveConversations(cutoffIso: string, limit = 20): ConversationListItem[] {
    return this.db
      .prepare(
        `
          SELECT c.id, c.chat_id, c.title, c.status, c.started_at, c.last_activity_at,
                 c.ended_at, c.saved_reason, COUNT(m.id) AS message_count
          FROM conversations c
          LEFT JOIN messages m ON m.conversation_id = c.id
          WHERE c.status = 'active'
            AND datetime(c.last_activity_at) <= datetime(?)
          GROUP BY c.id
          HAVING COUNT(m.id) > 0
          ORDER BY datetime(c.last_activity_at) ASC, c.id ASC
          LIMIT ?
        `
      )
      .all(cutoffIso, limit) as ConversationListItem[];
  }

  addMessage(
    chatId: string,
    role: ChatRole,
    content: string,
    conversationId?: number
  ): void {
    const scopedConversationId =
      conversationId ?? this.getOrCreateActiveConversation(chatId).id;

    this.db
      .prepare(
        "INSERT INTO messages (chat_id, conversation_id, role, content) VALUES (@chat_id, @conversation_id, @role, @content)"
      )
      .run({
        chat_id: chatId,
        conversation_id: scopedConversationId,
        role,
        content
      });

    this.touchConversation(scopedConversationId);
  }

  getRecentMessages(chatId: string, limit: number, conversationId?: number): ChatMessage[] {
    if (conversationId) {
      return this.db
        .prepare(
          `
            SELECT id, chat_id, conversation_id, role, content, created_at
            FROM messages
            WHERE chat_id = ? AND conversation_id = ?
            ORDER BY id DESC
            LIMIT ?
          `
        )
        .all(chatId, conversationId, limit)
        .reverse() as ChatMessage[];
    }

    return this.db
      .prepare(
        `
          SELECT id, chat_id, conversation_id, role, content, created_at
          FROM messages
          WHERE chat_id = ?
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(chatId, limit)
      .reverse() as ChatMessage[];
  }

  clearMessages(chatId: string, conversationId?: number): number {
    if (conversationId) {
      const result = this.db
        .prepare("DELETE FROM messages WHERE chat_id = ? AND conversation_id = ?")
        .run(chatId, conversationId);
      return result.changes;
    }

    const result = this.db
      .prepare("DELETE FROM messages WHERE chat_id = ?")
      .run(chatId);
    return result.changes;
  }

  createTask(chatId: string, text: string): number {
    const result = this.db
      .prepare("INSERT INTO tasks (chat_id, text, status, done) VALUES (?, ?, 'todo', 0)")
      .run(chatId, text);
    return Number(result.lastInsertRowid);
  }

  listTasks(chatId: string, includeDone = false, limit = 20): TaskItem[] {
    if (includeDone) {
      return this.db
        .prepare(
          `
          SELECT id, chat_id, text, status, done, created_at
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
        SELECT id, chat_id, text, status, done, created_at
        FROM tasks
        WHERE chat_id = ? AND status IN ('todo', 'in_progress')
        ORDER BY id DESC
        LIMIT ?
      `
      )
      .all(chatId, limit) as TaskItem[];
  }

  markTaskDone(chatId: string, taskId: number): boolean {
    return this.setTaskStatus(chatId, taskId, "done");
  }

  setTaskStatus(chatId: string, taskId: number, status: TaskStatus): boolean {
    const done = status === "done" ? 1 : 0;
    const result = this.db
      .prepare(
        "UPDATE tasks SET status = ?, done = ? WHERE chat_id = ? AND id = ?"
      )
      .run(status, done, chatId, taskId);
    return result.changes > 0;
  }

  deleteTask(chatId: string, taskId: number): boolean {
    const result = this.db
      .prepare("DELETE FROM tasks WHERE chat_id = ? AND id = ?")
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
