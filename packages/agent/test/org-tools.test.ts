import { describe, expect, test } from "bun:test";
import { createOrgTools } from "../src/tools/org.ts";

type Call = { url: string; init?: RequestInit };

function mockFetch(body: unknown) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fn, calls };
}

function toolByName(tools: ReturnType<typeof createOrgTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content[0].text ?? "null");
}

describe("createOrgTools", () => {
  const orgUrl = "https://org.example";
  const token = "test-token";

  test("org_whoami GETs /v1/machines/me with bearer token", async () => {
    const me = { machine: { id: "m-1", hostname: "host-1" }, user: { employee_id: "EMP-1" } };
    const { fn, calls } = mockFetch(me);
    const tools = createOrgTools({ orgUrl, token, fetch: fn });

    const result = await toolByName(tools, "org_whoami").execute("c1", {});

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://org.example/v1/machines/me");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    expect(textOf(result)).toEqual(me);
  });

  test("org_users_search builds q and limit query params", async () => {
    const rows = [{ employee_id: "EMP-1", display_name: "Jo", email: null, status: "active" }];
    const { fn, calls } = mockFetch(rows);
    const tools = createOrgTools({ orgUrl, token, fetch: fn });

    const result = await toolByName(tools, "org_users_search").execute("c2", { query: "jo", limit: 5 });

    expect(calls[0].url).toBe("https://org.example/v1/users/search?q=jo&limit=5");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    expect(textOf(result)).toEqual(rows);
  });

  test("org_users_search omits limit when absent", async () => {
    const { fn, calls } = mockFetch([]);
    const tools = createOrgTools({ orgUrl, token, fetch: fn });

    await toolByName(tools, "org_users_search").execute("c3", { query: "abc" });

    expect(calls[0].url).toBe("https://org.example/v1/users/search?q=abc");
  });

  test("org_log_event POSTs /v1/usage-logs with JSON body", async () => {
    const { fn, calls } = mockFetch({ ok: true });
    const tools = createOrgTools({ orgUrl, token, fetch: fn });

    const result = await toolByName(tools, "org_log_event").execute("c4", {
      event_type: "agent_action",
      detail: "did a thing",
    });

    expect(calls[0].url).toBe("https://org.example/v1/usage-logs");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      event_type: "agent_action",
      detail: "did a thing",
    });
    expect(textOf(result)).toEqual({ ok: true });
  });

  test("org_whoami throws on non-ok response", async () => {
    const fn = (async () =>
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const tools = createOrgTools({ orgUrl, token, fetch: fn });

    await expect(toolByName(tools, "org_whoami").execute("c5", {})).rejects.toThrow("403");
  });

  test("strips trailing slash from org url", async () => {
    const { fn, calls } = mockFetch({});
    const tools = createOrgTools({ orgUrl: "https://org.example/", token, fetch: fn });

    await toolByName(tools, "org_whoami").execute("c6", {});

    expect(calls[0].url).toBe("https://org.example/v1/machines/me");
  });
});
