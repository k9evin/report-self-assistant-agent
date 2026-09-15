import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type EnvironmentUser = "dev" | "prod";
export interface StoredRun {
  run_id: string;
  environment: EnvironmentUser;
  started_at?: string;
  tag?: string | null;
  pinned?: boolean;
  request?: string;
}

export class HistoryStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, environment TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), tag TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_turns (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), payload TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const now = new Date().toISOString();
    for (const environment of ["dev", "prod"]) this.db.prepare("INSERT OR IGNORE INTO users(environment, created_at) VALUES (?, ?)").run(environment, now);
  }

  createRun(run: StoredRun): void {
    const now = String(run.started_at ?? new Date().toISOString());
    const conversationId = run.run_id;
    const tag = typeof run.tag === "string" ? run.tag : null;
    this.db.prepare("INSERT INTO conversations(id, user_id, tag, pinned, created_at, updated_at) VALUES (?, (SELECT id FROM users WHERE environment = ?), ?, ?, ?, ?)")
      .run(conversationId, run.environment, tag, run.pinned ? 1 : 0, now, now);
    this.db.prepare("INSERT INTO runs(run_id, conversation_id, payload, started_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(run.run_id, conversationId, JSON.stringify(run), now, now);
    this.appendTurn(conversationId, "user", String(run.request ?? ""), now);
  }

  appendTurn(conversationId: string, role: "user" | "assistant", content: string, at = new Date().toISOString()): void {
    if (!content) return;
    this.db.prepare("INSERT INTO conversation_turns(conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(conversationId, role, content, at);
  }

  saveRun(run: StoredRun): void {
    const now = new Date().toISOString();
    const tag = typeof run.tag === "string" ? run.tag : null;
    this.db.prepare("UPDATE conversations SET tag = ?, pinned = ?, updated_at = ? WHERE id = ?")
      .run(tag, run.pinned ? 1 : 0, now, run.run_id);
    this.db.prepare("UPDATE runs SET payload = ?, updated_at = ? WHERE run_id = ?").run(JSON.stringify(run), now, run.run_id);
  }

  listRuns(environment: EnvironmentUser): StoredRun[] {
    return this.db.prepare("SELECT r.payload FROM runs r JOIN conversations c ON c.id = r.conversation_id JOIN users u ON u.id = c.user_id WHERE u.environment = ? ORDER BY r.started_at DESC").all(environment)
      .map((row) => JSON.parse(String((row as { payload: string }).payload)) as StoredRun);
  }

  getRun(runId: string, environment: EnvironmentUser): StoredRun | null {
    const row = this.db.prepare("SELECT r.payload FROM runs r JOIN conversations c ON c.id = r.conversation_id JOIN users u ON u.id = c.user_id WHERE r.run_id = ? AND u.environment = ?").get(runId, environment) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as StoredRun : null;
  }
}
