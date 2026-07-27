import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CURATOR_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_DAYS = 90;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

function home(): string {
	return process.env.HOME ?? homedir();
}

function agentCreatedDir(): string {
	return join(home(), ".staka", "skills", "agent-created");
}

function archiveDir(): string {
	return join(home(), ".staka", "skills", ".archive");
}

function curatorStatePath(): string {
	return join(home(), ".staka", "agent", ".curator-last-run");
}

function parseFrontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	const meta: Record<string, unknown> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
	}
	return meta;
}

function getStakaMeta(content: string): { pinned?: boolean; last_used_at?: string | null; created_at?: string } {
	const lines = content.split("\n");
	let inStaka = false;
	const meta: { pinned?: boolean; last_used_at?: string | null; created_at?: string } = {};
	for (const line of lines) {
		if (line.trim() === "staka:") {
			inStaka = true;
			continue;
		}
		if (inStaka) {
			const trimmed = line.trim();
			if (trimmed.startsWith("pinned:")) {
				meta.pinned = trimmed.includes("true");
			}
			if (trimmed.startsWith("last_used_at:")) {
				const val = trimmed.split(":").slice(1).join(":").trim();
				meta.last_used_at = val === "null" ? null : val.replace(/"/g, "");
			}
			if (trimmed.startsWith("created_at:")) {
				const val = trimmed.split(":").slice(1).join(":").trim();
				meta.created_at = val.replace(/"/g, "");
			}
			if (!line.startsWith(" ") && !line.startsWith("\t") && trimmed !== "") {
				inStaka = false;
			}
		}
	}
	return meta;
}

export function shouldRunCurator(): boolean {
	const statePath = curatorStatePath();
	if (!existsSync(statePath)) return true;
	try {
		const last = Number.parseInt(readFileSync(statePath, "utf8").trim(), 10);
		return Date.now() - last > CURATOR_INTERVAL_MS;
	} catch {
		return true;
	}
}

export function runCurator(): { archived: string[]; skipped: string[] } {
	const dir = agentCreatedDir();
	const archived: string[] = [];
	const skipped: string[] = [];

	if (!existsSync(dir)) {
		markRun();
		return { archived, skipped };
	}

	const arch = archiveDir();
	mkdirSync(arch, { recursive: true });

	for (const entry of readdirSync(dir)) {
		const skillDir = join(dir, entry);
		const skillFile = join(skillDir, "SKILL.md");
		if (!existsSync(skillFile)) continue;

		const content = readFileSync(skillFile, "utf8");
		const meta = getStakaMeta(content);

		if (meta.pinned) {
			skipped.push(entry);
			continue;
		}

		const lastUsed = meta.last_used_at ? new Date(meta.last_used_at).getTime() : null;
		const created = meta.created_at ? new Date(meta.created_at).getTime() : null;
		const stat = statSync(skillFile);
		const referenceTime = lastUsed ?? created ?? stat.mtimeMs;

		if (Date.now() - referenceTime > STALE_MS) {
			renameSync(skillDir, join(arch, entry));
			archived.push(entry);
		} else {
			skipped.push(entry);
		}
	}

	markRun();
	return { archived, skipped };
}

function markRun(): void {
	const statePath = curatorStatePath();
	mkdirSync(join(home(), ".staka", "agent"), { recursive: true });
	writeFileSync(statePath, String(Date.now()));
}
