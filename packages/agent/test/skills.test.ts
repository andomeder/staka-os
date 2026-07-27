import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, buildSkillsIndex, type SourcedSkill } from "../src/skills/loader.ts";

let testHome: string;
const origHome = process.env.HOME;

beforeEach(() => {
	testHome = join(tmpdir(), `staka-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(testHome, ".staka", "skills"), { recursive: true });
	mkdirSync(join(testHome, ".agents", "skills"), { recursive: true });
	process.env.HOME = testHome;
});

afterEach(() => {
	process.env.HOME = origHome;
	rmSync(testHome, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string, description: string, body: string) {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
	);
}

describe("loadSkills", () => {
	test("loads skills from user and shared dirs", async () => {
		writeSkill(join(testHome, ".staka", "skills"), "my-skill", "A user skill", "Do user things");
		writeSkill(join(testHome, ".agents", "skills"), "shared-skill", "A shared skill", "Do shared things");

		const result = await loadSkills();

		expect(result.skills.length).toBe(2);
		const names = result.skills.map((s) => s.skill.name).sort();
		expect(names).toEqual(["my-skill", "shared-skill"]);

		const userSkill = result.skills.find((s) => s.skill.name === "my-skill");
		expect(userSkill?.source).toBe("user");

		const sharedSkill = result.skills.find((s) => s.skill.name === "shared-skill");
		expect(sharedSkill?.source).toBe("shared");
	});

	test("deduplicates skills by realpath", async () => {
		writeSkill(join(testHome, ".staka", "skills"), "dup-skill", "First copy", "Body A");
		// Create a symlink from shared to user skill
		const { symlinkSync } = await import("node:fs");
		symlinkSync(
			join(testHome, ".staka", "skills", "dup-skill"),
			join(testHome, ".agents", "skills", "dup-skill"),
			"dir",
		);

		const result = await loadSkills();

		expect(result.skills.length).toBe(1);
		expect(result.skills[0].skill.name).toBe("dup-skill");
	});

	test("returns diagnostics for invalid skills", async () => {
		// Write a skill with missing description
		const skillDir = join(testHome, ".staka", "skills", "bad-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: bad-skill\n---\n\nNo description\n");

		const result = await loadSkills();

		expect(result.diagnostics.length).toBeGreaterThan(0);
	});

	test("returns empty when no skill dirs exist", async () => {
		rmSync(join(testHome, ".staka", "skills"), { recursive: true, force: true });
		rmSync(join(testHome, ".agents", "skills"), { recursive: true, force: true });

		const result = await loadSkills();

		expect(result.skills).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});
});

describe("buildSkillsIndex", () => {
	test("builds index with source tags", () => {
		const skills: SourcedSkill[] = [
			{
				skill: { name: "user-skill", description: "A user skill", content: "", filePath: "/a" },
				source: "user",
			},
			{
				skill: { name: "shared-skill", description: "A shared skill", content: "", filePath: "/b" },
				source: "shared",
			},
		];

		const index = buildSkillsIndex(skills);

		expect(index).toContain("- user-skill: A user skill [self]");
		expect(index).toContain("- shared-skill: A shared skill");
		expect(index).toContain("<available_skills>");
		expect(index).toContain("skill_view(name)");
	});

	test("excludes disableModelInvocation skills", () => {
		const skills: SourcedSkill[] = [
			{
				skill: { name: "hidden", description: "Hidden", content: "", filePath: "/a", disableModelInvocation: true },
				source: "shared",
			},
			{
				skill: { name: "visible", description: "Visible", content: "", filePath: "/b" },
				source: "shared",
			},
		];

		const index = buildSkillsIndex(skills);

		expect(index).not.toContain("hidden");
		expect(index).toContain("visible");
	});

	test("returns empty string for no skills", () => {
		expect(buildSkillsIndex([])).toBe("");
	});
});
