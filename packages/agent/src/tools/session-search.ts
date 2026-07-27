import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { searchSessions } from "../memory/store.ts";

function jsonResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: {},
	};
}

export function createSessionSearchTool(): AgentTool {
	return {
		name: "session_search",
		label: "Search sessions",
		description:
			"Search past conversation transcripts using full-text search. Returns matching entries with timestamps, roles, and content previews. Use to recall previous discussions.",
		parameters: Type.Object({
			query: Type.String({ description: "Full-text search query" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
		}),
		execute: async (_toolCallId, params) => {
			const results = searchSessions(params.query, params.limit ?? 10);
			return jsonResult(results);
		},
	};
}
