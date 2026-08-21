import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const MAX_BODY_BYTES = 8192;
const MAX_CREATES_PER_SESSION = 3;

function jsonResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: {},
	};
}

function agentCreatedDir(): string {
	const home = process.env.HOME ?? homedir();
	return join(home, ".staka", "skills", "agent-created");
}

function skillPath(name: string): string {
	return join(agentCreatedDir(), name, "SKILL.md");
}

function buildFrontmatter(
	name: string,
	description: string,
	sessionId: string,
): string {
	const now = new Date().toISOString();
	return [
		"---",
		`name: ${name}`,
		`description: ${description}`,
		"metadata:",
		"  staka:",
		"    origin: agent-created",
		`    created_at: "${now}"`,
		"    use_count: 0",
		"    last_used_at: null",
		"    pinned: false",
		`    session_id: "${sessionId}"`,
		"---",
		"",
	].join("\n");
}

export interface SkillManageDeps {
	sessionId: string;
	createsThisSession: { count: number };
}

export function createSkillManageTool(deps: SkillManageDeps): AgentTool {
	return {
		name: "skill_manage",
		label: "Manage skills",
		description:
			"Create, edit, patch, or delete agent-created skills. Skills are stored in ~/.staka/skills/agent-created/. Max 3 creates per session, 8KB body limit.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("create"),
				Type.Literal("edit"),
				Type.Literal("patch"),
				Type.Literal("delete"),
			]),
			name: Type.String({ description: "Skill name (lowercase, hyphens)" }),
			description: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			patch: Type.Optional(
				Type.String({ description: "For patch: new content to append or replace" }),
			),
		}),
		execute: async (_toolCallId, params) => {
			const { action, name } = params;

			if (!NAME_RE.test(name)) {
				return jsonResult({
					error: `Invalid skill name. Must match ${NAME_RE.source}`,
				});
			}

			const dir = agentCreatedDir();
			const path = skillPath(name);

			if (action === "create") {
				if (deps.createsThisSession.count >= MAX_CREATES_PER_SESSION) {
					return jsonResult({
						error: `Max ${MAX_CREATES_PER_SESSION} skill creates per session reached`,
					});
				}
				if (!params.description || !params.body) {
					return jsonResult({
						error: "create requires description and body",
					});
				}
				if (Buffer.byteLength(params.body, "utf8") > MAX_BODY_BYTES) {
					return jsonResult({ error: `Body exceeds ${MAX_BODY_BYTES} bytes` });
				}
				if (existsSync(path)) {
					return jsonResult({ error: `Skill already exists: ${name}` });
				}
				mkdirSync(join(dir, name), { recursive: true });
				writeFileSync(path, buildFrontmatter(name, params.description, deps.sessionId) + params.body);
				deps.createsThisSession.count++;
				return jsonResult({ ok: true, path });
			}

			if (!existsSync(path)) {
				return jsonResult({ error: `Skill not found: ${name}` });
			}

			if (action === "edit") {
				if (!params.body) {
					return jsonResult({ error: "edit requires body" });
				}
				if (Buffer.byteLength(params.body, "utf8") > MAX_BODY_BYTES) {
					return jsonResult({ error: `Body exceeds ${MAX_BODY_BYTES} bytes` });
				}
				const existing = readFileSync(path, "utf8");
				const fmMatch = existing.match(/^---\n[\s\S]*?\n---/);
				const frontmatter = fmMatch ? fmMatch[0] + "\n" : "";
				writeFileSync(path, frontmatter + params.body);
				return jsonResult({ ok: true, path });
			}

			if (action === "patch") {
				if (!params.patch) {
					return jsonResult({ error: "patch requires patch content" });
				}
				const existing = readFileSync(path, "utf8");
				const updated = existing + "\n" + params.patch;
				if (Buffer.byteLength(updated, "utf8") > MAX_BODY_BYTES) {
					return jsonResult({ error: `Patched body exceeds ${MAX_BODY_BYTES} bytes` });
				}
				writeFileSync(path, updated);
				return jsonResult({ ok: true, path });
			}

			// delete
			const { rmSync } = await import("node:fs");
			rmSync(join(dir, name), { recursive: true, force: true });
			return jsonResult({ ok: true, deleted: name });
		},
	};
}
