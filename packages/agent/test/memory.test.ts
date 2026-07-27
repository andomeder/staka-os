import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addEntry,
	buildMemoryPromptBlock,
	getSnapshot,
	removeEntry,
	replaceEntry,
} from "../src/memory/personal.ts";

let testHome: string;
const origHome = process.env.HOME;

beforeEach(() => {
	testHome = join(tmpdir(), `staka-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(testHome, ".staka", "agent", "memories"), { recursive: true });
	process.env.HOME = testHome;
});

afterEach(() => {
	process.env.HOME = origHome;
	rmSync(testHome, { recursive: true, force: true });
});

describe("personal memory", () => {
	test("adds entries to MEMORY.md", () => {
		const result = addEntry("memory", "Org server uses Hono 4.12");

		expect(result.ok).toBe(true);

		const content = readFileSync(join(testHome, ".staka", "agent", "memories", "MEMORY.md"), "utf8");
		expect(content).toContain("Org server uses Hono 4.12");
	});

	test("adds entries to USER.md", () => {
		const result = addEntry("user", "Prefers dark mode");

		expect(result.ok).toBe(true);

		const content = readFileSync(join(testHome, ".staka", "agent", "memories", "USER.md"), "utf8");
		expect(content).toContain("Prefers dark mode");
	});

	test("rejects entries that exceed char limit", () => {
		// Fill up memory close to the limit
		for (let i = 0; i < 20; i++) {
			addEntry("memory", `Entry ${i} with some padding text to fill up space`);
		}

		const result = addEntry("memory", "x".repeat(2500));

		expect(result.ok).toBe(false);
		expect(result.error).toContain("Memory full");
	});

	test("replaces entries by substring match", () => {
		addEntry("memory", "Uses TypeScript 5.0");
		addEntry("memory", "Deploys to AWS");

		const result = replaceEntry("memory", "TypeScript 5.0", "Uses TypeScript 7.0");

		expect(result.ok).toBe(true);

		const snapshot = getSnapshot();
		expect(snapshot.memory).toContain("TypeScript 7.0");
		expect(snapshot.memory).not.toContain("TypeScript 5.0");
		expect(snapshot.memory).toContain("Deploys to AWS");
	});

	test("returns error when replace substring not found", () => {
		addEntry("memory", "Some entry");

		const result = replaceEntry("memory", "nonexistent", "new content");

		expect(result.ok).toBe(false);
		expect(result.error).toContain("No entry matching");
	});

	test("removes entries by substring match", () => {
		addEntry("memory", "Keep this");
		addEntry("memory", "Remove this");

		const result = removeEntry("memory", "Remove this");

		expect(result.ok).toBe(true);

		const snapshot = getSnapshot();
		expect(snapshot.memory).toContain("Keep this");
		expect(snapshot.memory).not.toContain("Remove this");
	});

	test("returns error when remove substring not found", () => {
		addEntry("memory", "Some entry");

		const result = removeEntry("memory", "nonexistent");

		expect(result.ok).toBe(false);
		expect(result.error).toContain("No entry matching");
	});

	test("builds memory prompt block with both sections", () => {
		addEntry("memory", "Environment fact");
		addEntry("user", "User preference");

		const block = buildMemoryPromptBlock();

		expect(block).toContain("<memory>");
		expect(block).toContain("Environment fact");
		expect(block).toContain("</memory>");
		expect(block).toContain("<user>");
		expect(block).toContain("User preference");
		expect(block).toContain("</user>");
	});

	test("builds empty prompt block when no memories", () => {
		const block = buildMemoryPromptBlock();

		expect(block).toBe("");
	});

	test("uses § delimiter between entries", () => {
		addEntry("memory", "First entry");
		addEntry("memory", "Second entry");

		const content = readFileSync(join(testHome, ".staka", "agent", "memories", "MEMORY.md"), "utf8");

		expect(content).toContain("First entry\n§\nSecond entry");
	});
});
