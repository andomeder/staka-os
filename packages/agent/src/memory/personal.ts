import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MEMORY_MAX_CHARS = 2200;
const USER_MAX_CHARS = 1375;
const DELIMITER = "§";

function memoriesDir(): string {
	const home = process.env.HOME ?? homedir();
	return join(home, ".staka", "agent", "memories");
}

function memoryPath(): string {
	return join(memoriesDir(), "MEMORY.md");
}

function userPath(): string {
	return join(memoriesDir(), "USER.md");
}

function ensureDir(): void {
	mkdirSync(memoriesDir(), { recursive: true });
}

function readEntries(path: string): string[] {
	if (!existsSync(path)) return [];
	const content = readFileSync(path, "utf8").trim();
	if (!content) return [];
	return content.split(DELIMITER).map((e) => e.trim()).filter((e) => e.length > 0);
}

function writeEntries(path: string, entries: string[]): void {
	ensureDir();
	writeFileSync(path, entries.join(`\n${DELIMITER}\n`) + "\n");
}

function charCount(entries: string[]): number {
	return entries.join(`\n${DELIMITER}\n`).length;
}

export type MemoryTarget = "memory" | "user";

export interface MemoryAddResult {
	ok: boolean;
	entries_remaining?: number;
	error?: string;
}

export function addEntry(target: MemoryTarget, content: string): MemoryAddResult {
	const path = target === "memory" ? memoryPath() : userPath();
	const maxChars = target === "memory" ? MEMORY_MAX_CHARS : USER_MAX_CHARS;
	const entries = readEntries(path);

	const newEntries = [...entries, content.trim()];
	if (charCount(newEntries) > maxChars) {
		return {
			ok: false,
			error: `Memory full (${charCount(newEntries)}/${maxChars} chars). Consolidate entries before adding more.`,
		};
	}

	writeEntries(path, newEntries);
	return { ok: true, entries_remaining: maxChars - charCount(newEntries) };
}

export function replaceEntry(target: MemoryTarget, oldSubstring: string, newContent: string): MemoryAddResult {
	const path = target === "memory" ? memoryPath() : userPath();
	const maxChars = target === "memory" ? MEMORY_MAX_CHARS : USER_MAX_CHARS;
	const entries = readEntries(path);

	const idx = entries.findIndex((e) => e.includes(oldSubstring));
	if (idx === -1) {
		return { ok: false, error: `No entry matching "${oldSubstring}"` };
	}

	const newEntries = [...entries];
	newEntries[idx] = newContent.trim();

	if (charCount(newEntries) > maxChars) {
		return {
			ok: false,
			error: `Replacement would exceed limit (${charCount(newEntries)}/${maxChars} chars).`,
		};
	}

	writeEntries(path, newEntries);
	return { ok: true, entries_remaining: maxChars - charCount(newEntries) };
}

export function removeEntry(target: MemoryTarget, substring: string): MemoryAddResult {
	const path = target === "memory" ? memoryPath() : userPath();
	const entries = readEntries(path);

	const idx = entries.findIndex((e) => e.includes(substring));
	if (idx === -1) {
		return { ok: false, error: `No entry matching "${substring}"` };
	}

	const newEntries = entries.filter((_, i) => i !== idx);
	writeEntries(path, newEntries);

	const maxChars = target === "memory" ? MEMORY_MAX_CHARS : USER_MAX_CHARS;
	return { ok: true, entries_remaining: maxChars - charCount(newEntries) };
}

export function getSnapshot(): { memory: string; user: string } {
	return {
		memory: readEntries(memoryPath()).join(`\n${DELIMITER}\n`),
		user: readEntries(userPath()).join(`\n${DELIMITER}\n`),
	};
}

export function buildMemoryPromptBlock(): string {
	const snapshot = getSnapshot();
	const parts: string[] = [];

	if (snapshot.memory) {
		parts.push("<memory>", snapshot.memory, "</memory>");
	}
	if (snapshot.user) {
		parts.push("<user>", snapshot.user, "</user>");
	}

	return parts.join("\n");
}
