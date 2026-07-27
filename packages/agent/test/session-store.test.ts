import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../src/memory/db.ts";
import { appendEntry, getSessionEntries, listSessions, searchSessions } from "../src/memory/store.ts";

let testHome: string;
const origHome = process.env.HOME;

beforeEach(() => {
	testHome = join(tmpdir(), `staka-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(testHome, ".local", "share", "staka", "agent"), { recursive: true });
	process.env.HOME = testHome;
});

afterEach(() => {
	closeDb();
	process.env.HOME = origHome;
	rmSync(testHome, { recursive: true, force: true });
});

describe("session store", () => {
	test("appends and retrieves entries", () => {
		const entry = appendEntry({
			session_id: "sess-1",
			role: "user",
			content: "Hello, world!",
		});

		expect(entry.id).toBeDefined();
		expect(entry.timestamp).toBeDefined();

		const entries = getSessionEntries("sess-1");
		expect(entries).toHaveLength(1);
		expect(entries[0].content).toBe("Hello, world!");
		expect(entries[0].role).toBe("user");
	});

	test("appends multiple entries to same session", () => {
		appendEntry({ session_id: "sess-1", role: "user", content: "First message" });
		appendEntry({ session_id: "sess-1", role: "assistant", content: "Response" });
		appendEntry({ session_id: "sess-1", role: "user", content: "Follow-up" });

		const entries = getSessionEntries("sess-1");
		expect(entries).toHaveLength(3);
		expect(entries.map((e) => e.role)).toEqual(["user", "assistant", "user"]);
	});

	test("isolates entries by session", () => {
		appendEntry({ session_id: "sess-1", role: "user", content: "Session 1 message" });
		appendEntry({ session_id: "sess-2", role: "user", content: "Session 2 message" });

		expect(getSessionEntries("sess-1")).toHaveLength(1);
		expect(getSessionEntries("sess-2")).toHaveLength(1);
		expect(getSessionEntries("sess-3")).toHaveLength(0);
	});

	test("stores tags as JSON", () => {
		appendEntry({
			session_id: "sess-1",
			role: "tool",
			content: "Tool result",
			tags: ["org", "search"],
			tool_name: "org_users_search",
		});

		const entries = getSessionEntries("sess-1");
		expect(entries[0].tags).toEqual(["org", "search"]);
		expect(entries[0].tool_name).toBe("org_users_search");
	});

	test("searches entries with FTS5", () => {
		appendEntry({ session_id: "sess-1", role: "user", content: "How do I configure docker networking?" });
		appendEntry({ session_id: "sess-1", role: "assistant", content: "You can use bridge networks." });
		appendEntry({ session_id: "sess-2", role: "user", content: "What is the weather today?" });

		const results = searchSessions("docker networking");

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].content_preview).toContain("docker");
	});

	test("search returns empty for no matches", () => {
		appendEntry({ session_id: "sess-1", role: "user", content: "Hello world" });

		const results = searchSessions("nonexistent query xyz");

		expect(results).toHaveLength(0);
	});

	test("lists sessions with metadata", () => {
		appendEntry({ session_id: "sess-1", role: "user", content: "Message 1" });
		appendEntry({ session_id: "sess-1", role: "assistant", content: "Response 1" });
		appendEntry({ session_id: "sess-2", role: "user", content: "Message 2" });

		const sessions = listSessions();

		expect(sessions).toHaveLength(2);
		const sess1 = sessions.find((s) => s.session_id === "sess-1");
		expect(sess1?.entry_count).toBe(2);
	});

	test("respects limit in search", () => {
		for (let i = 0; i < 20; i++) {
			appendEntry({ session_id: "sess-1", role: "user", content: `Docker tip number ${i}` });
		}

		const results = searchSessions("docker", 5);

		expect(results.length).toBeLessThanOrEqual(5);
	});
});
