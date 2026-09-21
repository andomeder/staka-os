import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAllowlist,
  createFsTools,
  MAX_READ_BYTES,
} from "../src/tools/fs.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0].text ?? "";
}

function toolByName(tools: { name: string }[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

describe("checkAllowlist", () => {
  const home = "/home/demo";

  test("expands ~ against the home dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "staka-fs-"));
    try {
      await writeFile(join(root, "notes.txt"), "hi");
      const check = await checkAllowlist("~/notes.txt", [root], root);
      expect(check.ok).toBe(true);
      if (check.ok) expect(check.path).toBe(join(root, "notes.txt"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denies when no allowlist is configured", async () => {
    const check = await checkAllowlist("/etc/passwd", [], home);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("no allowlist");
  });

  test("denies relative paths and nonexistent files", async () => {
    const root = await mkdtemp(join(tmpdir(), "staka-fs-"));
    try {
      const rel = await checkAllowlist("relative/path", [root], home);
      expect(rel.ok).toBe(false);
      const missing = await checkAllowlist("/no/such/file.txt", [root], home);
      expect(missing.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows files inside an allowlisted directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "staka-fs-"));
    try {
      const file = join(root, "reports", "q3.txt");
      await mkdir(join(root, "reports"), { recursive: true });
      await writeFile(file, "hello");
      const check = await checkAllowlist(file, [root], home);
      expect(check.ok).toBe(true);
      if (check.ok) expect(check.path).toBe(file);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("blocks .. traversal out of the allowlist", async () => {
    const parent = await mkdtemp(join(tmpdir(), "staka-fs-"));
    const root = join(parent, "allow");
    await mkdir(root, { recursive: true });
    await mkdir(join(parent, "elsewhere"), { recursive: true });
    try {
      const check = await checkAllowlist(
        join(root, "..", "elsewhere"),
        [root],
        home,
      );
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toContain("outside");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("blocks symlink escape out of the allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "staka-fs-"));
    const outside = await mkdtemp(join(tmpdir(), "staka-fs-out-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
      const check = await checkAllowlist(join(root, "link.txt"), [root], home);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toContain("outside");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("fs_read_file tool", () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "staka-fs-tool-"));
    const file = join(root, "q3.txt");
    await writeFile(file, "Q3 revenue: 4.82M KES");
    const bigFile = join(root, "big.txt");
    await writeFile(bigFile, "x".repeat(MAX_READ_BYTES + 1));
    return { root, file, bigFile };
  }

  test("reads an allowlisted file and audits the read", async () => {
    const { root, file, bigFile } = await setup();
    try {
      const audits: Array<{ url: string; body: unknown }> = [];
      const tools = createFsTools({
        allowlist: [root],
        orgUrl: "https://org.example",
        token: "tok",
        fetch: async (url, init) => {
          audits.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
      const result = await toolByName(tools, "fs_read_file").execute("f1", {
        path: file,
      });
      const body = JSON.parse(textOf(result));
      expect(body.content).toBe("Q3 revenue: 4.82M KES");
      expect(body.size).toBe("Q3 revenue: 4.82M KES".length);
      expect(body.audit_delivery_failed).toBeUndefined();
      expect(audits).toHaveLength(1);
      expect(audits[0]!.url).toBe("https://org.example/v1/usage-logs");
      expect(audits[0]!.body).toMatchObject({
        event_type: "agent_file_read",
        detail: { path: file, denied: false },
      });
      await rm(bigFile, { force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denies paths outside the allowlist and audits the denial", async () => {
    const { root, file, bigFile } = await setup();
    try {
      const audits: Array<{ url: string; body: unknown }> = [];
      const tools = createFsTools({
        allowlist: ["/definitely/elsewhere"],
        orgUrl: "https://org.example",
        token: "tok",
        fetch: async (url, init) => {
          audits.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
      const result = await toolByName(tools, "fs_read_file").execute("f2", {
        path: file,
      });
      expect(textOf(result)).toContain("path_denied");
      expect(textOf(result)).toContain("outside the read allowlist");
      expect(audits).toHaveLength(1);
      expect(audits[0]!.body).toMatchObject({
        event_type: "agent_file_read",
        detail: { path: file, denied: true },
      });
      await rm(bigFile, { force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enforces the size cap and audits the denial", async () => {
    const { root, bigFile, file } = await setup();
    try {
      const audits: unknown[] = [];
      const tools = createFsTools({
        allowlist: [root],
        orgUrl: "https://org.example",
        token: "tok",
        fetch: async (url, init) => {
          audits.push({ url, init });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
      const result = await toolByName(tools, "fs_read_file").execute("f3", {
        path: bigFile,
      });
      expect(textOf(result)).toContain("path_denied");
      expect(textOf(result)).toContain("byte cap");
      expect(audits).toHaveLength(1);
      await rm(file, { force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("still returns content when audit delivery fails, and says so", async () => {
    const { root, file, bigFile } = await setup();
    try {
      const tools = createFsTools({
        allowlist: [root],
        orgUrl: "https://org.example",
        token: "tok",
        fetch: async () => {
          throw new Error("org server down");
        },
      });
      const result = await toolByName(tools, "fs_read_file").execute("f4", {
        path: file,
      });
      const body = JSON.parse(textOf(result));
      expect(body.content).toBe("Q3 revenue: 4.82M KES");
      expect(body.audit_delivery_failed).toBe(true);
      await rm(bigFile, { force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
