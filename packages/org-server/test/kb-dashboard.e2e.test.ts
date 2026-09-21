import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbPools } from "../src/db/client.ts";
import { closeDbPools } from "../src/db/client.ts";
import { kbDocuments } from "../src/db/schema.ts";
import { users } from "../src/db/schema.ts";
import { hashPassword } from "../src/lib/password.ts";
import { mintAdminJwt } from "../src/lib/admin-auth-tokens.ts";
import { createTestApp } from "./helpers/app.ts";
import { KbEngineClient, type KbConfig } from "../src/lib/kb.ts";
import { startFakeEngine } from "./helpers/fake-engine.ts";
import { setupTestPools } from "./helpers/db.ts";

let pools: DbPools;
let engine: ReturnType<typeof startFakeEngine>;
let kbConfig: KbConfig;

beforeAll(async () => {
  const setup = await setupTestPools();
  pools = setup.pools;
  engine = startFakeEngine();
  kbConfig = {
    client: new KbEngineClient({ baseUrl: engine.url }),
    space: "org_alpha",
  };
});

afterAll(async () => {
  if (pools) await closeDbPools(pools);
  engine.stop();
});

beforeAll(async () => {
  // The registry persists across runs while the fake engine does not.
  await pools.owner.delete(kbDocuments);
});

async function seedAdminSession(opts: { withKb: boolean }) {
  const passwordHash = await hashPassword("admin-pass-123");
  const [admin] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-KB-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "KB Dashboard Admin",
      role: "admin",
      status: "active",
      passwordHash,
    })
    .returning();
  const { app, keyring, sessions, csrf } = await createTestApp({
    pools,
    kb: opts.withKb ? kbConfig : undefined,
  });
  const { token } = await mintAdminJwt({
    keyring,
    sessions,
    userId: admin!.id,
    employeeId: admin!.employeeId,
  });
  // Mirror the dashboard's CSRF cookie pair contract.
  const { token: csrfToken } = csrf.mint();
  return {
    app,
    adminId: admin!.id,
    headers: {
      authorization: `Bearer ${token}`,
      cookie: `csrf=${csrfToken}`,
    },
    csrfToken,
  };
}

function multipartBody(fields: Record<string, string>, file?: { name: string; content: string }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) {
    form.append(
      "file",
      new Blob([file.content], { type: "text/markdown" }),
      file.name,
    );
  }
  return form;
}

describe("dashboard KB management", () => {
  test("GET /admin/kb renders the management page", async () => {
    const { app, headers } = await seedAdminSession({ withKb: true });
    const res = await app.request("/admin/kb", { headers });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Knowledge base");
    expect(html).toContain("Upload document");
  });

  test("upload stores the document and it is agent-searchable", async () => {
    const { app, headers, csrfToken } = await seedAdminSession({ withKb: true });
    const res = await app.request("/admin/kb/documents", {
      method: "POST",
      headers: headers,
      body: multipartBody(
        {
          csrf: csrfToken,
          title: "Expense claim policy",
          sensitive: "0",
        },
        { name: "expense-policy.md", content: "# Expense claim policy\n\nKES 2,500 daily meal cap." },
      ),
    });
    expect(res.status).toBe(302);

    const rows = await pools.owner
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.title, "Expense claim policy"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.source).toBe("upload");
    expect(engine.docs.get(rows[0]!.customId)?.space).toBe("org_alpha");
  });

  test("upload without CSRF is rejected", async () => {
    const { app, headers } = await seedAdminSession({ withKb: true });
    const res = await app.request("/admin/kb/documents", {
      method: "POST",
      headers,
      body: multipartBody({}, { name: "no-csrf.md", content: "no csrf" }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/kb");
    const rows = await pools.owner
      .select()
      .from(kbDocuments);
    expect(rows.filter((r) => r.title === "no-csrf.md" || r.title === "Untitled document").length).toBe(0);
  });

  test("sensitive uploads are excluded from agent search results", async () => {
    const { app, headers, csrfToken } = await seedAdminSession({ withKb: true });
    await app.request("/admin/kb/documents", {
      method: "POST",
      headers,
      body: multipartBody(
        { csrf: csrfToken, title: "Salary bands", sensitive: "1" },
        { name: "salary-bands.md", content: "Salary bands confidential content." },
      ),
    });
    const rows = await pools.owner
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.title, "Salary bands"));
    expect(rows[0]!.sensitive).toBe(true);
    expect(engine.docs.get(rows[0]!.customId)?.metadata.sensitive).toBe(true);
  });

  test("delete removes the document from agent reach", async () => {
    const { app, headers, csrfToken } = await seedAdminSession({ withKb: true });
    await app.request("/admin/kb/documents", {
      method: "POST",
      headers,
      body: multipartBody(
        { csrf: csrfToken, title: "Delete me doc" },
        { name: "delete-me.md", content: "Delete me doc content here." },
      ),
    });
    const rows = await pools.owner
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.title, "Delete me doc"));
    expect(rows.length).toBe(1);

    const res = await app.request(
      `/admin/kb/documents/${encodeURIComponent(rows[0]!.customId)}/delete`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: `csrf=${encodeURIComponent(csrfToken)}`,
      },
    );
    expect(res.status).toBe(302);
    expect(engine.docs.has(rows[0]!.customId)).toBe(false);
    const [after] = await pools.owner
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.customId, rows[0]!.customId));
    expect(after?.deletedAt).not.toBeNull();
  });

  test("directory profile sync ingests one profile per active user", async () => {
    const { app, headers, csrfToken } = await seedAdminSession({ withKb: true });
    const res = await app.request("/admin/kb/profiles/sync", {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf=${encodeURIComponent(csrfToken)}`,
    });
    expect(res.status).toBe(302);
    const profileDocs = [...engine.docs.entries()].filter(([id]) =>
      id.startsWith("profile:"),
    );
    expect(profileDocs.length).toBeGreaterThan(0);
    for (const [, doc] of profileDocs) {
      expect(doc.metadata.doc_type).toBe("profile");
      expect(doc.metadata.org_id).toBe("alpha");
    }
  });
});
