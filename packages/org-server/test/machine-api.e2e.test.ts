import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbPools } from "../src/db/client.ts";
import { closeDbPools } from "../src/db/client.ts";
import {
  activationCodes,
  machines,
  usageLogs,
  users,
} from "../src/db/schema.ts";
import {
  generateEnrollmentCode,
  hashEnrollmentCode,
  maskEnrollmentCode,
} from "../src/lib/codes.ts";
import { signJwt } from "../src/lib/jwt.ts";
import { hashPassword } from "../src/lib/password.ts";
import { createTestApp } from "./helpers/app.ts";
import { setupTestPools } from "./helpers/db.ts";

let pools: DbPools;

beforeAll(async () => {
  const setup = await setupTestPools();
  pools = setup.pools;
});

afterAll(async () => {
  if (pools) await closeDbPools(pools);
});

async function seedAdmin() {
  const passwordHash = await hashPassword("admin-pass-123");
  const [admin] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-ADM-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Machine API Admin",
      role: "admin",
      status: "active",
      passwordHash,
    })
    .returning();
  return admin!;
}

async function seedStaff(opts?: {
  employeeId?: string;
  displayName?: string;
  email?: string;
}) {
  const [user] = await pools.owner
    .insert(users)
    .values({
      employeeId: opts?.employeeId ?? `EMP-STF-${crypto.randomUUID().slice(0, 8)}`,
      displayName: opts?.displayName ?? "Machine API Staff",
      email: opts?.email ?? null,
      role: "staff",
      status: "active",
      passwordHash: await hashPassword("staff-pass-123"),
    })
    .returning();
  return user!;
}

async function seedMachine(opts: {
  userId: string;
  adminId: string;
  status?: "pending" | "approved" | "active" | "suspended" | "revoked";
}) {
  const plain = generateEnrollmentCode();
  const [code] = await pools.owner
    .insert(activationCodes)
    .values({
      codeHash: hashEnrollmentCode(plain),
      codeDisplay: maskEnrollmentCode(plain),
      userId: opts.userId,
      createdBy: opts.adminId,
      expiresAt: new Date(Date.now() + 86_400_000),
      flow: "admin",
    })
    .returning();

  const hwidId = crypto.randomUUID();
  const [machine] = await pools.owner
    .insert(machines)
    .values({
      hardwareId: hwidId,
      hwidHash: `hash-${hwidId}`,
      hwidDisplay: `Test-***-${hwidId.slice(0, 4)}`,
      hwidComponents: { product_uuid: hwidId },
      hostname: `mapi-host-${hwidId.slice(0, 8)}`,
      userId: opts.userId,
      enrollmentCodeId: code!.id,
      status: opts.status ?? "active",
      provisionFlow: "admin",
    })
    .returning();
  return machine!;
}

async function machineJwt(status: "active" | "suspended" = "active") {
  const { app, keyring } = await createTestApp({ pools });
  const admin = await seedAdmin();
  const staff = await seedStaff();
  const machine = await seedMachine({
    userId: staff.id,
    adminId: admin.id,
    status,
  });
  const { token } = await signJwt(keyring, {
    sub: machine.id,
    typ: "machine",
  });
  return { app, machine, token };
}

describe("GET /v1/users/search", () => {
  test("returns prefix matches with non-PII fields", async () => {
    const { app, token } = await machineJwt();
    const marker = crypto.randomUUID().slice(0, 8);
    await seedStaff({
      employeeId: `EMP-MATCH-${marker}`,
      displayName: `Matchable Person ${marker}`,
      email: `match-${marker}@example.com`,
    });

    const res = await app.request(`/v1/users/search?q=EMP-MATCH-${marker}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].employee_id).toBe(`EMP-MATCH-${marker}`);
    expect(body[0].display_name).toBe(`Matchable Person ${marker}`);
    expect(body[0].email).toBe(`match-${marker}@example.com`);
    expect(body[0].status).toBe("active");

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("password");
  });

  test("matches on display_name and email prefixes", async () => {
    const { app, token } = await machineJwt();
    const marker = crypto.randomUUID().slice(0, 8);
    await seedStaff({
      employeeId: `EMP-X-${marker}`,
      displayName: `Zedric ${marker}`,
      email: `zedric-${marker}@example.com`,
    });

    const byName = await app.request(`/v1/users/search?q=Zedric ${marker}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byName.status).toBe(200);
    expect((await byName.json()).length).toBe(1);

    const byEmail = await app.request(
      `/v1/users/search?q=zedric-${marker}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(byEmail.status).toBe(200);
    expect((await byEmail.json()).length).toBe(1);
  });

  test("returns 400 for query shorter than 2 chars", async () => {
    const { app, token } = await machineJwt();
    const res = await app.request("/v1/users/search?q=a", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  test("returns 401 without token", async () => {
    const { app } = await createTestApp({ pools });
    const res = await app.request("/v1/users/search?q=EMP");
    expect(res.status).toBe(401);
  });

  test("returns 403 for suspended machine", async () => {
    const { app, token } = await machineJwt("suspended");
    const res = await app.request("/v1/users/search?q=EMP", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  test("logs agent_user_search usage event", async () => {
    const { app, machine, token } = await machineJwt();
    await app.request("/v1/users/search?q=EMP", {
      headers: { authorization: `Bearer ${token}` },
    });

    const logs = await pools.app
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.machineId, machine.id));
    const searches = logs.filter((l) => l.eventType === "agent_user_search");
    expect(searches.length).toBeGreaterThanOrEqual(1);
  });

  test("returns 429 after exceeding per-machine limit", async () => {
    const { app, token } = await machineJwt();
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const res = await app.request("/v1/users/search?q=EMP", {
        headers: { authorization: `Bearer ${token}` },
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  test("treats LIKE wildcards in query literally", async () => {
    const { app, token } = await machineJwt();
    const marker = crypto.randomUUID().slice(0, 8);
    await seedStaff({ displayName: `wcard_${marker}` });
    await seedStaff({ displayName: `wcardX${marker}` });

    const res = await app.request(`/v1/users/search?q=wcard_${marker}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    const names = body.map((u: { display_name: string }) => u.display_name);
    expect(names).toContain(`wcard_${marker}`);
    expect(names).not.toContain(`wcardX${marker}`);
  });
});

describe("POST /v1/usage-logs", () => {
  test("records a whitelisted event", async () => {
    const { app, machine, token } = await machineJwt();
    const res = await app.request("/v1/usage-logs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event_type: "agent_action",
        detail: "opened spreadsheet",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const logs = await pools.app
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.machineId, machine.id));
    const events = logs.filter((l) => l.eventType === "agent_action");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ detail: "opened spreadsheet" });
  });

  test("returns 400 for non-whitelisted event_type", async () => {
    const { app, token } = await machineJwt();
    const res = await app.request("/v1/usage-logs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ event_type: "not_allowed" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 401 without token", async () => {
    const { app } = await createTestApp({ pools });
    const res = await app.request("/v1/usage-logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_type: "agent_action" }),
    });
    expect(res.status).toBe(401);
  });
});
