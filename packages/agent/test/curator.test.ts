import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldRunCurator, runCurator } from "../src/skills/curator.ts";

let testHome: string;
const origHome = process.env.HOME;

beforeEach(() => {
	testHome = join(tmpdir(), `staka-curator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(testHome, ".staka", "skills", "agent-created"), { recursive: true });
	mkdirSync(join(testHome, ".staka", "agent"), { recursive: true });
	process.env.HOME = testHome;
});

afterEach(() => {
	process.env.HOME = origHome;
	rmSync(testHome, { recursive: true, force: true });
});

function writeAgentSkill(name: string, opts: { pinned?: boolean; lastUsed?: string | null; ageMs?: number } = {}) {
	const dir = join(testHome, ".staka", "skills", "agent-created", name);
	mkdirSync(dir, { recursive: true });
	const now = new Date();
	const created = new Date(now.getTime() - (opts.ageMs ?? 0));
	const content = [
		"---",
		`name: ${name}`,
		`description: Test skill ${name}`,
		"metadata:",
		"  staka:",
		"    origin: agent-created",
		`    created_at: "${created.toISOString()}"`,
		"    use_count: 0",
		`    last_used_at: ${opts.lastUsed === undefined ? "null" : `"${opts.lastUsed}"`}`,
		`    pinned: ${opts.pinned ?? false}`,
		'    session_id: "test"',
		"---",
		"",
		"# Test",
		"",
		"Body content.",
		"",
	].join("\n");
	writeFileSync(join(dir, "SKILL.md"), content);
}

describe("shouldRunCurator", () => {
	test("returns true when no state file exists", () => {
		expect(shouldRunCurator()).toBe(true);
	});

	test("returns false when recently run", () => {
		writeFileSync(join(testHome, ".staka", "agent", ".curator-last-run"), String(Date.now()));
		expect(shouldRunCurator()).toBe(false);
	});

	test("returns true when last run was over 7 days ago", () => {
		const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
		writeFileSync(join(testHome, ".staka", "agent", ".curator-last-run"), String(eightDaysAgo));
		expect(shouldRunCurator()).toBe(true);
	});
});

describe("runCurator", () => {
	test("archives skills unused for over 90 days", () => {
		writeAgentSkill("stale-skill", { ageMs: 100 * 24 * 60 * 60 * 1000 });

		const result = runCurator();

		expect(result.archived).toContain("stale-skill");
		expect(existsSync(join(testHome, ".staka", "skills", "agent-created", "stale-skill"))).toBe(false);
		expect(existsSync(join(testHome, ".staka", "skills", ".archive", "stale-skill"))).toBe(true);
	});

	test("does not archive recently used skills", () => {
		writeAgentSkill("fresh-skill", { lastUsed: new Date().toISOString() });

		const result = runCurator();

		expect(result.archived).not.toContain("fresh-skill");
		expect(result.skipped).toContain("fresh-skill");
		expect(existsSync(join(testHome, ".staka", "skills", "agent-created", "fresh-skill"))).toBe(true);
	});

	test("does not archive pinned skills even if stale", () => {
		writeAgentSkill("pinned-stale", { pinned: true, ageMs: 200 * 24 * 60 * 60 * 1000 });

		const result = runCurator();

		expect(result.archived).not.toContain("pinned-stale");
		expect(result.skipped).toContain("pinned-stale");
		expect(existsSync(join(testHome, ".staka", "skills", "agent-created", "pinned-stale"))).toBe(true);
	});

	test("uses last_used_at over file mtime when available", () => {
		// File is old but last_used_at is recent
		writeAgentSkill("recently-used", {
			ageMs: 200 * 24 * 60 * 60 * 1000,
			lastUsed: new Date().toISOString(),
		});

		const result = runCurator();

		expect(result.archived).not.toContain("recently-used");
		expect(result.skipped).toContain("recently-used");
	});

	test("handles empty agent-created dir", () => {
		const result = runCurator();

		expect(result.archived).toEqual([]);
		expect(result.skipped).toEqual([]);
	});

	test("updates curator state after run", () => {
		runCurator();

		const statePath = join(testHome, ".staka", "agent", ".curator-last-run");
		expect(existsSync(statePath)).toBe(true);
		const timestamp = Number.parseInt(readFileSync(statePath, "utf8").trim(), 10);
		expect(Date.now() - timestamp).toBeLessThan(5000);
	});
});
