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
import { KbEngineClient, type KbConfig } from "../src/lib/kb.ts";
import { signJwt } from "../src/lib/jwt.ts";
import { createTestApp } from "./helpers/app.ts";
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
  const { app, keyring } = await createTestApp({ pools, kb: kbConfig });
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

  test("machine requests are rate limited per machine", async () => {
    const { app, jwt } = await seedMachineWithJwt();
    engine.docs.set("doc:alpha-q3", SPACE_DOCS.alpha!);

    let saw429 = 0;
    for (let i = 0; i < 61; i++) {
      const res = await app.request("/v1/kb/search", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "Alpha Q3 reporting" }),
      });
      if (res.status === 429) {
        saw429 += 1;
        expect(res.headers.get("retry-after")).not.toBeNull();
      } else {
        expect(res.status).toBe(200);
      }
    }
    expect(saw429).toBe(1);
  });
});
