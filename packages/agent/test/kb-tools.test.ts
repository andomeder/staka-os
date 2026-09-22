import { describe, expect, test } from "bun:test";
import { createKbTools } from "../src/tools/kb.ts";

function startFakeOrg() {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : undefined;
      calls.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/v1/kb/search") {
        return Response.json({
          results: [
            {
              id: "doc:q3-reporting-procedure",
              title: "Q3 Financial Reporting Procedure",
              snippet: "This procedure covers the preparation of the quarterly Q3 reports.",
              score: 0.87,
              doc_type: "procedure",
            },
          ],
        });
      }
      if (url.pathname === "/v1/kb/skills") {
        return Response.json({
          skills: [
            {
              id: "skill:q3-report-prep",
              name: "q3-report-prep",
              description: "Prepare the quarterly Q3 report.",
              score: 0.8,
              source: "org",
            },
          ],
        });
      }
      if (url.pathname === "/v1/kb/who-knows") {
        return Response.json({
          people: [
            {
              employee_id: "EMP-0104",
              display_name: "John Mwangi",
              evidence: ["Owns the Q3 reporting procedure."],
              score: 0.68,
            },
          ],
        });
      }
      if (url.pathname === "/v1/kb/documents/doc%3Aq3") {
        return Response.json({
          id: "doc:q3",
          title: "Q3 Procedure",
          content: "Full document text".repeat(10),
          source: "upload",
        });
      }
      if (url.pathname === "/v1/kb/search503") {
        return Response.json({ error: "kb_unavailable" }, { status: 503 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    calls,
    stop: () => server.stop(true),
  };
}

describe("KB agent tools", () => {
  const org = startFakeOrg();
  const tools = createKbTools({ orgUrl: org.url, token: "tok" });
  const byName = new Map(tools.map((t) => [t.name, t]));

  test("all four KB tools are exposed", () => {
    expect([...byName.keys()].sort()).toEqual([
      "get_document",
      "search_knowledge",
      "search_skills",
      "who_knows",
    ]);
  });

  test("search_knowledge returns ranked results with citations", async () => {
    const tool = byName.get("search_knowledge")!;
    const result = await tool.execute("call-1", { query: "Q3 reporting" });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.results[0]!.id).toBe("doc:q3-reporting-procedure");
    expect(parsed.results[0]!.score).toBeGreaterThan(0);
    expect(org.calls[0]!.path).toBe("/v1/kb/search");
    expect(org.calls[0]!.body).toEqual({ query: "Q3 reporting" });
  });

  test("search_skills returns org skills", async () => {
    const tool = byName.get("search_skills")!;
    const result = await tool.execute("call-2", { query: "quarterly report" });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.skills[0]!.name).toBe("q3-report-prep");
    expect(parsed.skills[0]!.source).toBe("org");
  });

  test("who_knows returns evidence-backed people", async () => {
    const tool = byName.get("who_knows")!;
    const result = await tool.execute("call-3", { topic: "Q3 reports" });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.people[0]!.employee_id).toBe("EMP-0104");
    expect(parsed.people[0]!.evidence.length).toBeGreaterThan(0);
  });

  test("get_document fetches full capped text", async () => {
    const tool = byName.get("get_document")!;
    const result = await tool.execute("call-4", { id: "doc:q3" });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.id).toBe("doc:q3");
    expect(parsed.content).toContain("Full document text");
  });

  test("server errors surface as typed tool failures", async () => {
    const failing = createKbTools({
      orgUrl: "http://localhost:9",
      token: "tok",
    });
    await expect(
      failing[0]!.execute("call-5", { query: "anything" }),
    ).rejects.toThrow(/kb_unavailable/);
    org.stop();
  });
});
