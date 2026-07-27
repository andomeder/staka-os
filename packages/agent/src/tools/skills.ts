import { Type } from "typebox";
import { formatSkillInvocation, type AgentTool } from "@earendil-works/pi-agent-core";
import type { SourcedSkill } from "../skills/loader.ts";

function jsonResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: {},
	};
}

export interface SkillsToolsDeps {
	getSkills: () => SourcedSkill[];
}

export function createSkillsTools(deps: SkillsToolsDeps): AgentTool[] {
	return [
		{
			name: "skills_list",
			label: "List skills",
			description:
				"List available skills with name, description, and source. Use to browse what skills are loaded.",
			parameters: Type.Object({
				source: Type.Optional(
					Type.Union([
						Type.Literal("user"),
						Type.Literal("shared"),
						Type.Literal("all"),
					]),
				),
			}),
			execute: async (_toolCallId, params) => {
				const source = params.source ?? "all";
				const skills = deps
					.getSkills()
					.filter((s) => source === "all" || s.source === source)
					.map((s) => ({
						name: s.skill.name,
						description: s.skill.description,
						source: s.source,
						path: s.skill.filePath,
					}));
				return jsonResult(skills);
			},
		},
		{
			name: "skill_view",
			label: "View skill",
			description:
				"Load the full instructions of a skill by name. Returns the complete SKILL.md content wrapped for context injection.",
			parameters: Type.Object({
				name: Type.String({ description: "Skill name to load" }),
			}),
			execute: async (_toolCallId, params) => {
				const entry = deps.getSkills().find((s) => s.skill.name === params.name);
				if (!entry) {
					return jsonResult({ error: `Skill not found: ${params.name}` });
				}
				const content = formatSkillInvocation(entry.skill);
				return {
					content: [{ type: "text" as const, text: content }],
					details: {},
				};
			},
		},
	];
}
