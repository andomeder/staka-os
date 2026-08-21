import { randomUUID } from "node:crypto";
import { getDb } from "./db.ts";

export interface SessionEntry {
	id: string;
	session_id: string;
	timestamp: string;
	role: string;
	content: string;
	tags?: string[];
	tool_name?: string;
	tokens_in?: number;
	tokens_out?: number;
}

export interface SearchResult {
	id: string;
	timestamp: string;
	role: string;
	content_preview: string;
	score: number;
}

export function appendEntry(entry: Omit<SessionEntry, "id" | "timestamp">): SessionEntry {
	const db = getDb();
	const id = randomUUID();
	const timestamp = new Date().toISOString();

	db.query(
		`INSERT INTO entries (id, session_id, timestamp, role, content, tags, tool_name, tokens_in, tokens_out)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		entry.session_id,
		timestamp,
		entry.role,
		entry.content,
		entry.tags ? JSON.stringify(entry.tags) : null,
		entry.tool_name ?? null,
		entry.tokens_in ?? null,
		entry.tokens_out ?? null,
	);

	return { ...entry, id, timestamp };
}

export function searchSessions(query: string, limit = 10): SearchResult[] {
	const db = getDb();

	const rows = db
		.query(
			`SELECT e.id, e.timestamp, e.role, e.content,
			        (bm25(entries_fts) * -1) + (1.0 / (1.0 + (julianday('now') - julianday(e.timestamp)) * 10)) as score
			 FROM entries_fts f
			 JOIN entries e ON e.rowid = f.rowid
			 WHERE entries_fts MATCH ?
			 ORDER BY score DESC
			 LIMIT ?`,
		)
		.all(query, limit) as Array<{
		id: string;
		timestamp: string;
		role: string;
		content: string;
		score: number;
	}>;

	return rows.map((row) => ({
		id: row.id,
		timestamp: row.timestamp,
		role: row.role,
		content_preview: row.content.slice(0, 200),
		score: row.score,
	}));
}

export function listSessions(limit = 20): Array<{ session_id: string; last_timestamp: string; entry_count: number }> {
	const db = getDb();

	return db
		.query(
			`SELECT session_id, MAX(timestamp) as last_timestamp, COUNT(*) as entry_count
			 FROM entries
			 GROUP BY session_id
			 ORDER BY last_timestamp DESC
			 LIMIT ?`,
		)
		.all(limit) as Array<{ session_id: string; last_timestamp: string; entry_count: number }>;
}

export function getSessionEntries(sessionId: string, limit = 100): SessionEntry[] {
	const db = getDb();

	const rows = db
		.query(
			`SELECT id, session_id, timestamp, role, content, tags, tool_name, tokens_in, tokens_out
			 FROM entries
			 WHERE session_id = ?
			 ORDER BY timestamp ASC
			 LIMIT ?`,
		)
		.all(sessionId, limit) as Array<{
		id: string;
		session_id: string;
		timestamp: string;
		role: string;
		content: string;
		tags: string | null;
		tool_name: string | null;
		tokens_in: number | null;
		tokens_out: number | null;
	}>;

	return rows.map((row) => ({
		id: row.id,
		session_id: row.session_id,
		timestamp: row.timestamp,
		role: row.role,
		content: row.content,
		tags: row.tags ? JSON.parse(row.tags) : undefined,
		tool_name: row.tool_name ?? undefined,
		tokens_in: row.tokens_in ?? undefined,
		tokens_out: row.tokens_out ?? undefined,
	}));
}
