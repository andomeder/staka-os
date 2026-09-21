import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbPools } from "../src/db/client.ts";
import { closeDbPools } from "../src/db/client.ts";
import { activationCodes, deliveries, machines, usageLogs, users } from "../src/db/schema.ts";
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
  password?: string;
}) {
  const [user] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-${crypto.randomUUID().slice(0, 8)}`,
      displayName: opts.displayName,
      role: opts.role ?? "staff",
      status: "active",
      passwordHash: opts.password
        ? await hashPassword(opts.password)
        : null,
    })
    .returning();
  return user!;
}

async function seedMachine(opts: {
  userId: string;
  adminId: string;
  status?: "active" | "suspended" | "pending";
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
      hostname: `dlv-host-${hwidId.slice(0, 8)}`,
      userId: opts.userId,
      enrollmentCodeId: code!.id,
      status: opts.status ?? "active",
      provisionFlow: "admin",
    })
    .returning();
  return machine!;
}

describe("POST /v1/deliveries", () => {
  test("records a delivery and a usage event for an active machine", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedUser({
      displayName: "Delivery Admin",
      role: "admin",
    });
    const staff = await seedUser({ displayName: "Delivery Staff" });
    const machine = await seedMachine({ userId: staff.id, adminId: admin.id });
    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });

    const recipient = await seedUser({ displayName: "John Mwangi" });
    const res = await app.request("/v1/deliveries", {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to_employee_id: recipient.employeeId,
        summary: "Q3 revenue figure plus report",
        artifact_ref: "file:///reports/q3.txt",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.to_user.employee_id).toBe(recipient.employeeId);
    expect(body.to_user.display_name).toBe("John Mwangi");
    expect(body.summary).toBe("Q3 revenue figure plus report");
    expect(typeof body.id).toBe("string");

    const rows = await pools.owner
      .select()
      .from(deliveries)
      .where(eq(deliveries.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.machineId).toBe(machine.id);
    expect(rows[0]!.artifactRef).toBe("file:///reports/q3.txt");

    const logs = await pools.owner
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.machineId, machine.id));
    expect(logs.some((l) => l.eventType === "delivery_created")).toBe(true);
  });

  test("rejects unknown recipients with user_not_found", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedUser({ displayName: "A", role: "admin" });
    const staff = await seedUser({ displayName: "S" });
    const machine = await seedMachine({ userId: staff.id, adminId: admin.id });
    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });
    const res = await app.request("/v1/deliveries", {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to_employee_id: "EMP-DOES-NOT-EXIST",
        summary: "x",
      }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("user_not_found");
  });

  test("rejects invalid bodies and unauthenticated calls", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedUser({ displayName: "A", role: "admin" });
    const staff = await seedUser({ displayName: "S" });
    const machine = await seedMachine({ userId: staff.id, adminId: admin.id });
    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });

    const badBody = await app.request("/v1/deliveries", {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to_employee_id: "", summary: "" }),
    });
    expect(badBody.status).toBe(400);

    const noAuth = await app.request("/v1/deliveries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to_employee_id: "EMP-1", summary: "x" }),
    });
    expect(noAuth.status).toBe(401);
  });

  test("denies suspended machines", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedUser({ displayName: "A", role: "admin" });
    const staff = await seedUser({ displayName: "S" });
    const machine = await seedMachine({
      userId: staff.id,
      adminId: admin.id,
      status: "suspended",
    });
    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });
    const res = await app.request("/v1/deliveries", {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to_employee_id: staff.employeeId, summary: "x" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("admin deliveries view", () => {
  test("shows recorded deliveries on the dashboard", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedUser({
      displayName: "Delivery Admin",
      role: "admin",
      password: "admin-pass-123",
    });
    const staff = await seedUser({ displayName: "Delivery Staff" });
    const machine = await seedMachine({ userId: staff.id, adminId: admin.id });
    const { token: machineJwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });

    const recipient = await seedUser({ displayName: "John Mwangi" });
    const post = await app.request("/v1/deliveries", {
      method: "POST",
      headers: {
        authorization: `Bearer ${machineJwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to_employee_id: recipient.employeeId,
        summary: "spreadsheet figure for review",
      }),
    });
    expect(post.status).toBe(201);

    const login = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        employee_id: admin.employeeId,
        password: "admin-pass-123",
      }),
    });
    expect(login.status).toBe(200);
    const { admin_jwt: adminJwt } = (await login.json()) as {
      admin_jwt: string;
    };

    const page = await app.request("/admin/deliveries", {
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Deliveries");
    expect(html).toContain("spreadsheet figure for review");
    expect(html).toContain(recipient.employeeId);
    expect(html).toContain(machine.hostname);
  });
});
