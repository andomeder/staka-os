import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { addEntry, removeEntry, replaceEntry, type MemoryTarget } from "../memory/personal.ts";

function jsonResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: {},
	};
}

export function createMemoryTool(): AgentTool {
	return {
		name: "memory",
		label: "Manage memory",
		description:
			"Add, replace, or remove persistent memory entries. Use target='memory' for environment facts and tool quirks, target='user' for user preferences and relationships. Memory is injected into every session.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("add"),
				Type.Literal("replace"),
				Type.Literal("remove"),
			]),
			target: Type.Union([Type.Literal("memory"), Type.Literal("user")]),
			content: Type.Optional(Type.String({ description: "For add: the entry content" })),
			old: Type.Optional(Type.String({ description: "For replace/remove: substring to match" })),
			new: Type.Optional(Type.String({ description: "For replace: new content" })),
		}),
		execute: async (_toolCallId, params) => {
			const target = params.target as MemoryTarget;

			if (params.action === "add") {
				if (!params.content) {
					return jsonResult({ error: "add requires content" });
				}
				return jsonResult(addEntry(target, params.content));
			}

			if (params.action === "replace") {
				if (!params.old || !params.new) {
					return jsonResult({ error: "replace requires old and new" });
				}
				return jsonResult(replaceEntry(target, params.old, params.new));
			}

			if (params.action === "remove") {
				if (!params.old) {
					return jsonResult({ error: "remove requires old" });
				}
				return jsonResult(removeEntry(target, params.old));
			}

			return jsonResult({ error: `Unknown action: ${params.action}` });
		},
	};
}
