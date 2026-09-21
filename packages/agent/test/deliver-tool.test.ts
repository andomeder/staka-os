import { describe, expect, test } from "bun:test";
import { createDeliverTools } from "../src/tools/deliver.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0].text ?? "";
}

function toolByName(tools: { name: string }[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

describe("org_deliver tool", () => {
  test("posts the delivery to the org server", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tools = createDeliverTools({
      orgUrl: "https://org.example",
      token: "tok",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(
          JSON.stringify({
            id: "d-1",
            to_user: { employee_id: "EMP-0042", display_name: "John Mwangi" },
          }),
          { status: 201 },
        );
      },
    });

    const result = await toolByName(tools, "org_deliver").execute("d1", {
      to_employee_id: "EMP-0042",
      summary: "Q3 revenue figure plus report",
      artifact_ref: "file:///reports/q3.txt",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://org.example/v1/deliveries");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: "Bearer tok",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      to_employee_id: "EMP-0042",
      summary: "Q3 revenue figure plus report",
      artifact_ref: "file:///reports/q3.txt",
    });

    const body = JSON.parse(textOf(result));
    expect(body.delivery_id).toBe("d-1");
    expect(body.to.display_name).toBe("John Mwangi");
  });

  test("omits artifact_ref when not provided", async () => {
    let body: unknown;
    const tools = createDeliverTools({
      orgUrl: "https://org.example",
      token: "tok",
      fetch: async (_url, init) => {
        body = JSON.parse(String((init as RequestInit).body));
        return new Response(JSON.stringify({ id: "d-2" }), { status: 201 });
      },
    });
    await toolByName(tools, "org_deliver").execute("d2", {
      to_employee_id: "EMP-1",
      summary: "note",
    });
    expect(body).toEqual({ to_employee_id: "EMP-1", summary: "note" });
  });

  test("reports an unknown employee id instead of throwing", async () => {
    const tools = createDeliverTools({
      orgUrl: "https://org.example",
      token: "tok",
      fetch: async () =>
        new Response(JSON.stringify({ error: "user_not_found" }), {
          status: 404,
        }),
    });
    const result = await toolByName(tools, "org_deliver").execute("d3", {
      to_employee_id: "EMP-9999",
      summary: "x",
    });
    expect(textOf(result)).toContain("user_not_found");
    expect(textOf(result)).toContain("org_users_search");
  });

  test("throws with server detail on other errors", async () => {
    const tools = createDeliverTools({
      orgUrl: "https://org.example",
      token: "tok",
      fetch: async () =>
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    await expect(
      toolByName(tools, "org_deliver").execute("d4", {
        to_employee_id: "EMP-1",
        summary: "x",
      }),
    ).rejects.toThrow(/403/);
  });
});
