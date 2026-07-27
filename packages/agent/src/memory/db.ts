import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

function dbDir(): string {
	const home = process.env.HOME ?? homedir();
	return join(home, ".local", "share", "staka", "agent");
}

function dbPath(): string {
	return join(dbDir(), "sessions.db");
}

let db: Database | null = null;

export function getDb(): Database {
	if (db) return db;

	mkdirSync(dbDir(), { recursive: true });
	db = new Database(dbPath());

	db.exec(`
		CREATE TABLE IF NOT EXISTS entries (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			tags TEXT,
			tool_name TEXT,
			tokens_in INTEGER,
			tokens_out INTEGER
		);

		CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id, timestamp);

		CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
			content,
			content=entries,
			content_rowid=rowid
		);

		CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
			INSERT INTO entries_fts(rowid, content) VALUES (new.rowid, new.content);
		END;

		CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
			INSERT INTO entries_fts(entries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
		END;

		CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
			INSERT INTO entries_fts(entries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
			INSERT INTO entries_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);

	return db;
}

export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}
