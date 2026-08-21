import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	loadSourcedSkills,
	type ExecutionEnv,
	type FileError,
	type FileInfo,
	type Result,
	type Skill,
} from "@earendil-works/pi-agent-core";

export type SkillSource = "user" | "shared";

export interface SourcedSkill {
	skill: Skill;
	source: SkillSource;
}

export interface SkillsLoadResult {
	skills: SourcedSkill[];
	diagnostics: Array<{ message: string; path?: string; source: SkillSource }>;
}

function ok<T>(value: T): Result<T, FileError> {
	return { ok: true, value };
}

function fileErr(code: FileError["code"], message: string, path?: string): Result<never, FileError> {
	const err = new Error(message) as FileError;
	err.code = code;
	err.path = path;
	return { ok: false, error: err };
}

const bunEnv: ExecutionEnv = {
	cwd: process.cwd(),

	async absolutePath(path: string) {
		return ok(resolve(path));
	},

	async joinPath(parts: string[]) {
		return ok(join(...parts));
	},

	async readTextFile(path: string) {
		try {
			return ok(await Bun.file(path).text());
		} catch (e) {
			return fileErr("not_found", String(e), path);
		}
	},

	async readTextLines(path: string, options?: { maxLines?: number }) {
		try {
			const text = await Bun.file(path).text();
			const lines = text.split("\n");
			return ok(options?.maxLines ? lines.slice(0, options.maxLines) : lines);
		} catch (e) {
			return fileErr("not_found", String(e), path);
		}
	},

	async readBinaryFile(path: string) {
		try {
			return ok(new Uint8Array(await Bun.file(path).arrayBuffer()));
		} catch (e) {
			return fileErr("not_found", String(e), path);
		}
	},

	async writeFile(path: string, content: string | Uint8Array) {
		try {
			await Bun.write(path, content);
			return ok(undefined);
		} catch (e) {
			return fileErr("unknown", String(e), path);
		}
	},

	async appendFile(path: string, content: string | Uint8Array) {
		try {
			const existing = await Bun.file(path).text().catch(() => "");
			await Bun.write(path, existing + (typeof content === "string" ? content : new TextDecoder().decode(content)));
			return ok(undefined);
		} catch (e) {
			return fileErr("unknown", String(e), path);
		}
	},

	async fileInfo(path: string) {
		try {
			const { lstatSync } = await import("node:fs");
			const stat = lstatSync(path);
			const info: FileInfo = {
				path,
				kind: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
				size: stat.size,
				mtimeMs: stat.mtimeMs,
			};
			return ok(info);
		} catch (e) {
			return fileErr("not_found", String(e), path);
		}
	},

	async listDir(path: string) {
		try {
			const { readdirSync, statSync } = await import("node:fs");
			const entries = readdirSync(path);
			const infos: FileInfo[] = entries.map((name) => {
				const fullPath = join(path, name);
				const stat = statSync(fullPath);
				return {
					name,
					path: fullPath,
					kind: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
					size: stat.size,
					mtimeMs: stat.mtimeMs,
				};
			});
			return ok(infos);
		} catch (e) {
			return fileErr("not_found", String(e), path);
		}
	},

	async canonicalPath(path: string) {
		try {
			return ok(realpathSync(path));
		} catch (e) {
			return fileErr("not_found", String(e), path);
		}
	},

	async exists(path: string) {
		const { existsSync } = await import("node:fs");
		return ok(existsSync(path));
	},

	async createDir(path: string) {
		try {
			const { mkdirSync } = await import("node:fs");
			mkdirSync(path, { recursive: true });
			return ok(undefined);
		} catch (e) {
			return fileErr("unknown", String(e), path);
		}
	},

	async remove(path: string, options?: { recursive?: boolean; force?: boolean }) {
		try {
			const { rmSync } = await import("node:fs");
			rmSync(path, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (e) {
			return fileErr("unknown", String(e), path);
		}
	},

	async createTempDir(prefix?: string) {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		return ok(mkdtempSync(join(tmpdir(), prefix ?? "tmp-")));
	},

	async createTempFile(options?: { prefix?: string; suffix?: string }) {
		const { writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const path = join(tmpdir(), `${options?.prefix ?? ""}${Date.now()}${options?.suffix ?? ""}`);
		writeFileSync(path, "");
		return ok(path);
	},

	async cleanup() {},

	async exec() {
		return ok({ stdout: "", stderr: "", exitCode: 0 });
	},
};

function skillDirs(): Array<{ path: string; source: SkillSource }> {
	const home = process.env.HOME ?? homedir();
	return [
		{ path: join(home, ".staka", "skills"), source: "user" },
		{ path: join(home, ".agents", "skills"), source: "shared" },
	];
}

export async function loadSkills(): Promise<SkillsLoadResult> {
	const dirs = skillDirs();
	const seen = new Set<string>();
	const skills: SourcedSkill[] = [];
	const diagnostics: SkillsLoadResult["diagnostics"] = [];

	for (const dir of dirs) {
		const result = await loadSourcedSkills(bunEnv, [
			{ path: dir.path, source: dir.source },
		]);

		for (const entry of result.skills) {
			let real: string;
			try {
				real = realpathSync(entry.skill.filePath);
			} catch {
				real = entry.skill.filePath;
			}
			if (seen.has(real)) continue;
			seen.add(real);
			skills.push({ skill: entry.skill, source: dir.source });
		}

		for (const diag of result.diagnostics) {
			diagnostics.push({
				message: diag.message,
				path: diag.path,
				source: dir.source,
			});
		}
	}

	return { skills, diagnostics };
}

export function buildSkillsIndex(skills: SourcedSkill[]): string {
	const lines = skills
		.filter((s) => !s.skill.disableModelInvocation)
		.map((s) => {
			const tag = s.source === "user" ? " [self]" : "";
			return `- ${s.skill.name}: ${s.skill.description}${tag}`;
		});

	if (lines.length === 0) return "";

	return [
		"<available_skills>",
		...lines,
		"",
		"To use a skill, call skill_view(name) to load its full instructions.",
		"</available_skills>",
	].join("\n");
}
