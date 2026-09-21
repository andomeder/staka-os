import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbPools } from "../src/db/client.ts";
import { closeDbPools } from "../src/db/client.ts";
import { machines, usageLogs, users } from "../src/db/schema.ts";
import {
  generateEnrollmentCode,
  hashEnrollmentCode,
  maskEnrollmentCode,
} from "../src/lib/codes.ts";
import { signJwt } from "../src/lib/jwt.ts";
import { createTestApp } from "./helpers/app.ts";
import { setupTestPools } from "./helpers/db.ts";

/**
 * Fake retrieval engine standing in for supermemory-server. Space-scoped:
 * a search only ever sees documents stored under the requested
 * containerTag, and the tag is read from the recorded request body (never
 * trusted from anywhere else).
 */
function startFakeEngine() {
  const docs = new Map<
    string,
    { space: string; content: string; metadata: Record<string, unknown> }
  >();
  const searches: Array<{ q: string; containerTag: string }> = [];

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body =
        req.method === "POST" ? await req.json().catch(() => undefined) : undefined;

      if (req.method === "POST" && url.pathname === "/v3/documents") {
        const b = body as {
          content: string;
          customId: string;
          containerTag: string;
          metadata?: Record<string, unknown>;
        };
        docs.set(b.customId, {
          space: b.containerTag,
          content: b.content,
          metadata: b.metadata ?? {},
        });
        return Response.json({ id: `eng-${b.customId}`, status: "queued" });
      }

      if (req.method === "POST" && url.pathname === "/v4/search") {
        const b = body as { q: string; containerTag: string; limit?: number };
        searches.push({ q: b.q, containerTag: b.containerTag });
        const results = [...docs.entries()]
          .filter(([, d]) => d.space === b.containerTag)
          .filter(([, d]) =>
            d.content.toLowerCase().includes(b.q.toLowerCase().slice(0, 10)),
          )
          .slice(0, b.limit ?? 10)
          .map(([customId, d], i) => ({
            id: `chunk-${i}`,
            chunk: d.content,
            similarity: 0.9 - i * 0.1,
            metadata: d.metadata,
            documents: [
              { id: customId, title: d.content.split("\n")[0], metadata: d.metadata },
            ],
          }));
        return Response.json({ results, timing: 4, total: results.length });
      }

      const docMatch = url.pathname.match(/^\/v3\/documents\/([^/]+)$/);
      if (req.method === "GET" && docMatch) {
        const doc = docs.get(decodeURIComponent(docMatch[1]!));
        if (!doc) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({
          customId: decodeURIComponent(docMatch[1]!),
          content: doc.content,
          title: doc.content.split("\n")[0],
          status: "done",
          metadata: doc.metadata,
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    docs,
    searches,
    stop: () => server.stop(true),
  };
}

let pools: DbPools;
let engine: ReturnType<typeof startFakeEngine>;

beforeAll(async () => {
  const setup = await setupTestPools();
  pools = setup.pools;
  engine = startFakeEngine();
});

afterAll(async () => {
  if (pools) await closeDbPools(pools);
  engine.stop();
});

async function seedMachineWithJwt() {
  const passwordHash = "x";
  const [admin] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-ADM-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "KB Admin",
      role: "admin",
      status: "active",
      passwordHash,
    })
    .returning();
  const [staff] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-STF-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "KB Staff",
      role: "staff",
      status: "active",
      passwordHash,
    })
    .returning();
  const plain = generateEnrollmentCode();
  const [code] = await pools.owner
    .insert((await import("../src/db/schema.ts")).activationCodes)
    .values({
      codeHash: hashEnrollmentCode(plain),
      codeDisplay: maskEnrollmentCode(plain),
      userId: staff!.id,
      createdBy: admin!.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      flow: "admin",
    })
    .returning();
  const hwid = crypto.randomUUID();
  const [machine] = await pools.owner
    .insert(machines)
    .values({
      hardwareId: hwid,
      hwidHash: `hash-${hwid}`,
      hwidDisplay: `Test-***-${hwid.slice(0, 4)}`,
      hwidComponents: { product_uuid: hwid },
      hostname: `kb-host-${hwid.slice(0, 8)}`,
      userId: staff!.id,
      enrollmentCodeId: code!.id,
      status: "active",
      provisionFlow: "admin",
    })
    .returning();
  const { app, keyring } = await createTestApp({
    pools,
    kb: {
      client: new (await import("../src/lib/kb.ts")).KbEngineClient({
        baseUrl: engine.url,
      }),
      space: "org_alpha",
    },
  });
  const { token } = await signJwt(keyring, {
    sub: machine!.id,
    typ: "machine",
  });
  return { app, jwt: token, machineId: machine!.id };
}

const SPACE_DOCS = {
  alpha: {
    space: "org_alpha",
    content: "# Alpha Q3 reporting procedure\n\nJohn Mwangi owns the Q3 report.",
    metadata: { org_id: "alpha", doc_type: "procedure", source: "upload" },
  },
  alphaProfile: {
    space: "org_alpha",
    content: "# John Mwangi\nemployee_id: EMP-0104\nOwns the Q3 reporting procedure.",
    metadata: { org_id: "alpha", doc_type: "profile", source: "directory" },
  },
  beta: {
    space: "org_beta",
    content: "# Beta confidential parking plan\n\nBeta-only facilities content.",
    metadata: { org_id: "beta", doc_type: "policy", source: "upload" },
  },
};

describe("KB routes", () => {
  test("search without KB config returns kb_unavailable", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await pools.owner
      .insert(users)
      .values({
        employeeId: `EMP-A-${crypto.randomUUID().slice(0, 6)}`,
        displayName: "NoKB Admin",
        role: "admin",
        status: "active",
        passwordHash: "x",
      })
      .returning();
    const staff = await pools.owner
      .insert(users)
      .values({
        employeeId: `EMP-S-${crypto.randomUUID().slice(0, 6)}`,
        displayName: "NoKB Staff",
        role: "staff",
        status: "active",
        passwordHash: "x",
      })
      .returning();
    const plain = generateEnrollmentCode();
    const [code] = await pools.owner
      .insert((await import("../src/db/schema.ts")).activationCodes)
      .values({
        codeHash: hashEnrollmentCode(plain),
        codeDisplay: maskEnrollmentCode(plain),
        userId: staff[0]!.id,
        createdBy: admin[0]!.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        flow: "admin",
      })
      .returning();
    const hwid = crypto.randomUUID();
    const [machine] = await pools.owner
      .insert(machines)
      .values({
        hardwareId: hwid,
        hwidHash: `hash-${hwid}`,
        hwidDisplay: `Test-***-${hwid.slice(0, 4)}`,
        hwidComponents: { product_uuid: hwid },
        hostname: `nokb-${hwid.slice(0, 6)}`,
        userId: staff[0]!.id,
        enrollmentCodeId: code!.id,
        status: "active",
        provisionFlow: "admin",
      })
      .returning();
    const { token } = await signJwt(keyring, { sub: machine!.id, typ: "machine" });
    const res = await app.request("/v1/kb/search", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("kb_unavailable");
  });

  test("search rejects unauthenticated requests", async () => {
    const { app } = await seedMachineWithJwt();
    const res = await app.request("/v1/kb/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Q3 report" }),
    });
    expect(res.status).toBe(401);
  });

  test("search returns scoped results and audits the query", async () => {
    const { app, jwt, machineId } = await seedMachineWithJwt();
    engine.docs.set("doc:alpha-q3", SPACE_DOCS.alpha!);
    const res = await app.request("/v1/kb/search", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "Alpha Q3 reporting" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]?.id).toBe("doc:alpha-q3");
    expect(body.results[0]?.doc_type).toBe("procedure");

    const [log] = await pools.owner
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.machineId, machineId))
      .orderBy(usageLogs.id);
    expect(log?.eventType).toBe("kb_search");
  });

  test("search rejects invalid request bodies", async () => {
    const { app, jwt } = await seedMachineWithJwt();
    const res = await app.request("/v1/kb/search", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ limit: 5 }),
    });
    expect(res.status).toBe(400);
  });

  test("cross-org leakage: queries bound to the org space never return other orgs' docs", async () => {
    const { app, jwt } = await seedMachineWithJwt();
    engine.docs.set("doc:alpha-q3", SPACE_DOCS.alpha!);
    engine.docs.set("doc:beta-secret", SPACE_DOCS.beta!);

    // Every query shape that matches the other org's content must come back
    // empty or alpha-only.
    for (const q of [
      "Beta confidential parking plan",
      "Beta-only facilities content",
      "confidential",
    ]) {
      const res = await app.request("/v1/kb/search", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.results.map((r: { id: string }) => r.id);
      expect(ids).not.toContain("doc:beta-secret");
    }
    // The route resolved the space server-side: every engine call carried
    // the org's container tag, whatever the query text was.
    for (const s of engine.searches) {
      expect(s.containerTag).toBe("org_alpha");
    }
  });

  test("request bodies cannot inject a different container tag", async () => {
    const { app, jwt } = await seedMachineWithJwt();
    engine.docs.set("doc:beta-secret", SPACE_DOCS.beta!);
    const res = await app.request("/v1/kb/search", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: "Beta confidential parking plan",
        containerTag: "org_beta",
        space: "org_beta",
        filters: { AND: [{ key: "org_id", value: "beta" }] },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { id: string }) => r.id)).not.toContain("doc:beta-secret");
  });

  test("who-knows returns profile-backed people with evidence", async () => {
    const { app, jwt } = await seedMachineWithJwt();
    engine.docs.set("profile:EMP-0104", SPACE_DOCS.alphaProfile!);
    const res = await app.request("/v1/kb/who-knows", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ topic: "Q3 reporting procedure" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.people[0]?.employee_id).toBe("EMP-0104");
    expect(body.people[0]?.evidence.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.people)).not.toContain("email");
  });

  test("get_document fails closed on other orgs' documents", async () => {
    const { app, jwt } = await seedMachineWithJwt();
    engine.docs.set("doc:beta-secret", SPACE_DOCS.beta!);
    const res = await app.request("/v1/kb/documents/doc%3Abeta-secret", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(404);
  });

  test("get_document returns the org's own document and audits the read", async () => {
    const { app, jwt, machineId } = await seedMachineWithJwt();
    engine.docs.set("doc:alpha-q3", SPACE_DOCS.alpha!);
    const res = await app.request("/v1/kb/documents/doc%3Aalpha-q3", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("doc:alpha-q3");
    expect(body.content).toContain("Q3 reporting procedure");
    const logs = await pools.owner
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.machineId, machineId));
    expect(logs.some((l) => l.eventType === "kb_read")).toBe(true);
  });
});
