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
      displayName: "Config Admin",
      role: "admin",
      status: "active",
      passwordHash,
    })
    .returning();
  return admin!;
}

async function seedStaff() {
  const [user] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-STF-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Config Staff",
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
      hostname: `cfg-host-${hwidId.slice(0, 8)}`,
      userId: opts.userId,
      enrollmentCodeId: code!.id,
      status: opts.status ?? "active",
      provisionFlow: "admin",
    })
    .returning();
  return machine!;
}

describe("GET /v1/config", () => {
  test("returns config shape with valid machine JWT", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff();
    const machine = await seedMachine({
      userId: staff.id,
      adminId: admin.id,
      status: "active",
    });

    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });

    const res = await app.request("/v1/config", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.version).toBe(1);
    expect(typeof body.org_name).toBe("string");
    expect(body.features).toEqual({
      skills_sync: false,
      memory_sync: false,
    });
    expect(body.model).toEqual({
      provider: null,
      model_id: null,
      base_url: null,
    });
    expect(body.skill_pack_url).toBeNull();
    expect(body.skill_pack_hash).toBeNull();
  });

  test("logs config_pull usage event", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff();
    const machine = await seedMachine({
      userId: staff.id,
      adminId: admin.id,
      status: "active",
    });

    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });

    await app.request("/v1/config", {
      headers: { authorization: `Bearer ${jwt}` },
    });

    const logs = await pools.app
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.machineId, machine.id));
    const configPulls = logs.filter((l) => l.eventType === "config_pull");
    expect(configPulls.length).toBeGreaterThanOrEqual(1);
  });

  test("returns 401 without token", async () => {
    const { app } = await createTestApp({ pools });

    const res = await app.request("/v1/config");
    expect(res.status).toBe(401);
  });

  test("returns 401 with invalid token", async () => {
    const { app } = await createTestApp({ pools });

    const res = await app.request("/v1/config", {
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 for suspended machine", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff();
    const machine = await seedMachine({
      userId: staff.id,
      adminId: admin.id,
      status: "suspended",
    });

    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });

    const res = await app.request("/v1/config", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(403);
  });

  test("returns 403 for revoked machine", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff();
    const machine = await seedMachine({
      userId: staff.id,
      adminId: admin.id,
      status: "revoked",
    });

    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });

    const res = await app.request("/v1/config", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/machines/me", () => {
  test("returns machine and user info", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff();
    const machine = await seedMachine({
      userId: staff.id,
      adminId: admin.id,
      status: "active",
    });

    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });

    const res = await app.request("/v1/machines/me", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.machine.id).toBe(machine.id);
    expect(body.machine.hostname).toBe(machine.hostname);
    expect(body.machine.status).toBe("active");
    expect(body.machine.provision_flow).toBe("admin");
    expect(typeof body.machine.first_seen_at).toBe("string");
    expect(body.user.id).toBe(staff.id);
    expect(body.user.employee_id).toBe(staff.employeeId);
    expect(body.user.display_name).toBe(staff.displayName);
    expect(body.user.status).toBe("active");
  });

  test("returns 401 without token", async () => {
    const { app } = await createTestApp({ pools });

    const res = await app.request("/v1/machines/me");
    expect(res.status).toBe(401);
  });

  test("returns 403 for suspended machine", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff();
    const machine = await seedMachine({
      userId: staff.id,
      adminId: admin.id,
      status: "suspended",
    });

    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });

    const res = await app.request("/v1/machines/me", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(403);
  });

  test("returns 401 for admin JWT (wrong typ)", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedAdmin();

    const { token: jwt } = await signJwt(keyring, {
      sub: admin.id,
      typ: "admin",
      role: "admin",
    });

    const res = await app.request("/v1/machines/me", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(401);
  });

  test("does not expose hwid_components or password_hash", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff();
    const machine = await seedMachine({
      userId: staff.id,
      adminId: admin.id,
      status: "active",
    });

    const { token: jwt } = await signJwt(keyring, {
      sub: machine.id,
      typ: "machine",
    });

    const res = await app.request("/v1/machines/me", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const body = await res.json();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("hwid_components");
    expect(raw).not.toContain("password_hash");
    expect(raw).not.toContain("product_uuid");
  });
});
