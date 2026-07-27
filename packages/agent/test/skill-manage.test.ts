import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillManageTool } from "../src/tools/skill-manage.ts";

let testHome: string;
const origHome = process.env.HOME;

beforeEach(() => {
	testHome = join(tmpdir(), `staka-skill-manage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(testHome, ".staka", "skills", "agent-created"), { recursive: true });
	process.env.HOME = testHome;
});

afterEach(() => {
	process.env.HOME = origHome;
	rmSync(testHome, { recursive: true, force: true });
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
	return JSON.parse(result.content[0].text ?? "null");
}

describe("skill_manage", () => {
	test("creates a skill with frontmatter", async () => {
		const tool = createSkillManageTool({ sessionId: "sess-1", createsThisSession: { count: 0 } });

		const result = await tool.execute("c1", {
			action: "create",
			name: "test-skill",
			description: "A test skill",
			body: "# Test\n\nDo things.",
		});

		const parsed = textOf(result) as { ok: boolean; path: string };
		expect(parsed.ok).toBe(true);

		const content = readFileSync(parsed.path, "utf8");
		expect(content).toContain("name: test-skill");
		expect(content).toContain("description: A test skill");
		expect(content).toContain("origin: agent-created");
		expect(content).toContain('session_id: "sess-1"');
		expect(content).toContain("# Test");
	});

	test("rejects invalid skill names", async () => {
		const tool = createSkillManageTool({ sessionId: "sess-1", createsThisSession: { count: 0 } });

		const result = await tool.execute("c2", {
			action: "create",
			name: "Invalid_Name",
			description: "Bad",
			body: "Body",
		});

		const parsed = textOf(result) as { error: string };
		expect(parsed.error).toContain("Invalid skill name");
	});

	test("enforces max creates per session", async () => {
		const counter = { count: 3 };
		const tool = createSkillManageTool({ sessionId: "sess-1", createsThisSession: counter });

		const result = await tool.execute("c3", {
			action: "create",
			name: "too-many",
			description: "Should fail",
			body: "Body",
		});

		const parsed = textOf(result) as { error: string };
		expect(parsed.error).toContain("Max 3 skill creates");
	});

	test("rejects body over 8KB", async () => {
		const tool = createSkillManageTool({ sessionId: "sess-1", createsThisSession: { count: 0 } });

		const result = await tool.execute("c4", {
			action: "create",
			name: "big-skill",
			description: "Too big",
			body: "x".repeat(9000),
		});

		const parsed = textOf(result) as { error: string };
		expect(parsed.error).toContain("exceeds 8192 bytes");
	});

	test("rejects duplicate skill names", async () => {
		const tool = createSkillManageTool({ sessionId: "sess-1", createsThisSession: { count: 0 } });

		await tool.execute("c5", {
			action: "create",
			name: "dup-skill",
			description: "First",
			body: "Body",
		});

		const result = await tool.execute("c6", {
			action: "create",
			name: "dup-skill",
			description: "Second",
			body: "Body",
		});

		const parsed = textOf(result) as { error: string };
		expect(parsed.error).toContain("already exists");
	});

	test("edits an existing skill preserving frontmatter", async () => {
		const tool = createSkillManageTool({ sessionId: "sess-1", createsThisSession: { count: 0 } });

		await tool.execute("c7", {
			action: "create",
			name: "edit-me",
			description: "Original",
			body: "# Original\n\nOld content.",
		});

		const result = await tool.execute("c8", {
			action: "edit",
			name: "edit-me",
			body: "# Updated\n\nNew content.",
		});

		const parsed = textOf(result) as { ok: boolean; path: string };
		expect(parsed.ok).toBe(true);

		const content = readFileSync(parsed.path, "utf8");
		expect(content).toContain("name: edit-me");
		expect(content).toContain("# Updated");
		expect(content).not.toContain("Old content");
	});

	test("patches an existing skill by appending", async () => {
		const tool = createSkillManageTool({ sessionId: "sess-1", createsThisSession: { count: 0 } });

		await tool.execute("c9", {
			action: "create",
			name: "patch-me",
			description: "Patchable",
			body: "# Base\n\nBase content.",
		});

		const result = await tool.execute("c10", {
			action: "patch",
			name: "patch-me",
			patch: "## Added\n\nAppended content.",
		});

		const parsed = textOf(result) as { ok: boolean; path: string };
		expect(parsed.ok).toBe(true);

		const content = readFileSync(parsed.path, "utf8");
		expect(content).toContain("Base content.");
		expect(content).toContain("Appended content.");
	});

	test("deletes a skill", async () => {
		const tool = createSkillManageTool({ sessionId: "sess-1", createsThisSession: { count: 0 } });

		const createResult = await tool.execute("c11", {
			action: "create",
			name: "delete-me",
			description: "Deletable",
			body: "Body",
		});

		const path = (textOf(createResult) as { path: string }).path;
		expect(existsSync(path)).toBe(true);

		const result = await tool.execute("c12", {
			action: "delete",
			name: "delete-me",
		});

		const parsed = textOf(result) as { ok: boolean; deleted: string };
		expect(parsed.ok).toBe(true);
		expect(existsSync(path)).toBe(false);
	});

	test("returns error for non-existent skill on edit", async () => {
		const tool = createSkillManageTool({ sessionId: "sess-1", createsThisSession: { count: 0 } });

		const result = await tool.execute("c13", {
			action: "edit",
			name: "ghost-skill",
			body: "Body",
		});

		const parsed = textOf(result) as { error: string };
		expect(parsed.error).toContain("not found");
	});
});
