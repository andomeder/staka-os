import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbPools } from "../src/db/client.ts";
import { closeDbPools } from "../src/db/client.ts";
import { activationCodes, machines, usageLogs, users } from "../src/db/schema.ts";
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

async function seedUser(opts: {
  displayName: string;
  role?: "admin" | "staff";
  email?: string;
}) {
  const [user] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-${crypto.randomUUID().slice(0, 8)}`,
      displayName: opts.displayName,
      role: opts.role ?? "staff",
      status: "active",
      ...(opts.email ? { email: opts.email } : {}),
    })
    .returning();
  return user!;
}

async function seedActiveMachine(opts: { userId: string; adminId: string }) {
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
      hostname: `usr-host-${hwidId.slice(0, 8)}`,
      userId: opts.userId,
      enrollmentCodeId: code!.id,
      status: "active",
      provisionFlow: "admin",
    })
    .returning();
  return machine!;
}

async function machineJwt(keyring: Parameters<typeof signJwt>[0], machineId: string) {
  const { token } = await signJwt(keyring, { sub: machineId, typ: "machine" });
  return token;
}

describe("GET /v1/users/search", () => {
  test("finds colleagues by employee id and display name, without PII", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedUser({ displayName: "Search Admin", role: "admin" });
    const staff = await seedUser({ displayName: "Search Staff" });
    const machine = await seedActiveMachine({ userId: staff.id, adminId: admin.id });
    const jwt = await machineJwt(keyring, machine.id);

    const colleague = await seedUser({
      displayName: `John Mwangi ${crypto.randomUUID().slice(0, 8)}`,
      email: `john.mwangi.${crypto.randomUUID().slice(0, 8)}@acme.co`,
    });

    const byName = await app.request(
      `/v1/users/search?q=${encodeURIComponent(colleague.displayName.slice(0, 16))}`,
      { headers: { authorization: `Bearer ${jwt}` } },
    );
    expect(byName.status).toBe(200);
    const byNameBody = await byName.json();
    expect(byNameBody.count).toBe(1);
    expect(byNameBody.users[0]).toEqual({
      id: colleague.id,
      employee_id: colleague.employeeId,
      display_name: colleague.displayName,
      role: "staff",
      status: "active",
    });
    expect(JSON.stringify(byNameBody)).not.toContain("@acme.co");

    const byIdPrefix = await app.request(
      `/v1/users/search?q=${encodeURIComponent(colleague.employeeId.slice(0, 10))}`,
      { headers: { authorization: `Bearer ${jwt}` } },
    );
    expect((await byIdPrefix.json()).count).toBe(1);
  });

  test("requires a query and machine auth", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedUser({ displayName: "A", role: "admin" });
    const staff = await seedUser({ displayName: "S" });
    const machine = await seedActiveMachine({ userId: staff.id, adminId: admin.id });
    const jwt = await machineJwt(keyring, machine.id);

    const noQuery = await app.request("/v1/users/search", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(noQuery.status).toBe(400);

    const noAuth = await app.request("/v1/users/search?q=x");
    expect(noAuth.status).toBe(401);
  });
});

describe("POST /v1/usage-logs", () => {
  test("records machine-reported agent events", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedUser({ displayName: "A", role: "admin" });
    const staff = await seedUser({ displayName: "S" });
    const machine = await seedActiveMachine({ userId: staff.id, adminId: admin.id });
    const jwt = await machineJwt(keyring, machine.id);

    const res = await app.request("/v1/usage-logs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event_type: "agent_action",
        detail: "pulled a figure into a spreadsheet",
      }),
    });
    expect(res.status).toBe(201);

    const logs = await pools.owner
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.machineId, machine.id));
    const match = logs.find((l) => l.eventType === "agent_action");
    expect(match).toBeDefined();
    expect(match!.payload).toEqual({
      detail: "pulled a figure into a spreadsheet",
    });
  });

  test("accepts structured detail payloads (file-read audit)", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedUser({ displayName: "A", role: "admin" });
    const staff = await seedUser({ displayName: "S" });
    const machine = await seedActiveMachine({ userId: staff.id, adminId: admin.id });
    const jwt = await machineJwt(keyring, machine.id);

    const res = await app.request("/v1/usage-logs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event_type: "agent_file_read",
        detail: { path: "/home/u/reports/q3.txt", size: 120, denied: false },
      }),
    });
    expect(res.status).toBe(201);
  });

  test("rejects admin-only event types and malformed bodies", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedUser({ displayName: "A", role: "admin" });
    const staff = await seedUser({ displayName: "S" });
    const machine = await seedActiveMachine({ userId: staff.id, adminId: admin.id });
    const jwt = await machineJwt(keyring, machine.id);

    const adminEvent = await app.request("/v1/usage-logs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ event_type: "admin_action" }),
    });
    expect(adminEvent.status).toBe(400);

    const badBody = await app.request("/v1/usage-logs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: "not json",
    });
    expect(badBody.status).toBe(400);
  });
});
