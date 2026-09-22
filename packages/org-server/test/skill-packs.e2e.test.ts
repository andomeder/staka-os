import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbPools } from "../src/db/client.ts";
import { closeDbPools } from "../src/db/client.ts";
import { machines, users } from "../src/db/schema.ts";
import {
  activationCodes,
  skillPacks,
  kbDocuments,
} from "../src/db/schema.ts";
import {
  generateEnrollmentCode,
  hashEnrollmentCode,
  maskEnrollmentCode,
} from "../src/lib/codes.ts";
import { hashPassword } from "../src/lib/password.ts";
import { mintAdminJwt } from "../src/lib/admin-auth-tokens.ts";
import { signJwt } from "../src/lib/jwt.ts";
import { KbEngineClient, type KbConfig } from "../src/lib/kb.ts";
import { createTestApp } from "./helpers/app.ts";
import { startFakeEngine } from "./helpers/fake-engine.ts";
import { buildTar, gzip } from "./helpers/tar.ts";
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
  await pools.owner.delete(skillPacks);
  await pools.owner.delete(kbDocuments);
});

afterAll(async () => {
  if (pools) {
    await pools.owner.delete(skillPacks);
    await pools.owner.delete(kbDocuments);
    await closeDbPools(pools);
  }
  engine.stop();
});

async function seedAdminWithSession() {
  const passwordHash = await hashPassword("admin-pass-123");
  const [admin] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-PA-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Pack API Admin",
      role: "admin",
      status: "active",
      passwordHash,
    })
    .returning();
  const { app, keyring, sessions } = await createTestApp({
    pools,
    kb: kbConfig,
  });
  const { token } = await mintAdminJwt({
    keyring,
    sessions,
    userId: admin!.id,
    employeeId: admin!.employeeId,
  });
  return {
    app,
    adminHeaders: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
    },
  };
}

async function seedMachineWithJwt() {
  const [admin] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-PB-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Pack Machine Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
    })
    .returning();
  const [staff] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-PC-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Pack Machine Staff",
      role: "staff",
      status: "active",
      passwordHash: "x",
    })
    .returning();
  const plain = generateEnrollmentCode();
  const [code] = await pools.owner
    .insert(activationCodes)
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
      hostname: `pack-host-${hwid.slice(0, 8)}`,
      userId: staff!.id,
      enrollmentCodeId: code!.id,
      status: "active",
      provisionFlow: "admin",
    })
    .returning();
  const { app, keyring } = await createTestApp({ pools, kb: kbConfig });
  const { token } = await signJwt(keyring, { sub: machine!.id, typ: "machine" });
  return { app, jwt: token };
}

const PACK_TAR = buildTar([
  {
    name: "q3-report-prep/SKILL.md",
    content:
      "---\nname: q3-report-prep\ndescription: Prepare the quarterly Q3 report from the ERP export.\n---\n\nBuild the report.\n",
  },
]);

describe("skill pack API", () => {
  test("upload, config announcement, and machine pull round-trip", async () => {
    const { app, adminHeaders } = await seedAdminWithSession();
    const zipped = await gzip(PACK_TAR);
    const upload = await app.request("/v1/admin/skill-packs", {
      method: "POST",
      headers: adminHeaders,
      body: zipped,
    });
    expect(upload.status).toBe(200);
    const uploaded = await upload.json();
    expect(uploaded.version).toBe(1);
    expect(uploaded.skillCount).toBe(1);
    expect(uploaded.indexed).toBe(true);

    // The pack's skills are searchable through the KB skills endpoint.
    engine.docs.set("skill:q3-report-prep", {
      space: "org_alpha",
      content:
        "# Skill: q3-report-prep\n\nPrepare the quarterly Q3 report.\n\nBuild the report.",
      metadata: { org_id: "alpha", doc_type: "skill", source: "skill_pack" },
    });
    const { app: app2, jwt } = await seedMachineWithJwt();
    const skillsRes = await app2.request("/v1/kb/skills", {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "quarterly Q3 report" }),
    });
    expect(skillsRes.status).toBe(200);
    const skillsBody = await skillsRes.json();
    expect(skillsBody.skills[0]?.name).toBe("q3-report-prep");

    // Config announces the pack for machine sync.
    const configRes = await app2.request("/v1/config", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const config = await configRes.json();
    expect(config.features.skills_sync).toBe(true);
    expect(config.skill_pack_hash).toBe(uploaded.sha256);

    // Machine pull returns the exact uploaded bytes.
    const pull = await app2.request("/v1/skill-packs/pull", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(pull.status).toBe(200);
    const bytes = new Uint8Array(await pull.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toEqual(
      new TextDecoder().decode(zipped),
    );
    expect(pull.headers.get("x-staka-pack-sha256")).toBe(uploaded.sha256);
  });

  test("invalid packs are rejected", async () => {
    const { app, adminHeaders } = await seedAdminWithSession();
    const bad = await gzip(
      buildTar([{ name: "broken/SKILL.md", content: "no frontmatter" }]),
    );
    const res = await app.request("/v1/admin/skill-packs", {
      method: "POST",
      headers: adminHeaders,
      body: bad,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_pack");
  });

  test("pull requires machine auth", async () => {
    const { app } = await seedMachineWithJwt();
    const res = await app.request("/v1/skill-packs/pull");
    expect(res.status).toBe(401);
  });
});
