import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbPools } from "../src/db/client.ts";
import { closeDbPools } from "../src/db/client.ts";
import {
  activationCodes,
  machines,
  users,
} from "../src/db/schema.ts";
import {
  generateEnrollmentCode,
  hashEnrollmentCode,
  maskEnrollmentCode,
} from "../src/lib/codes.ts";
import { canonicalizeHwid } from "../src/lib/hwid.ts";
import { approveMachine, revokeMachine } from "../src/lib/machines.ts";
import { hashPassword } from "../src/lib/password.ts";
import { RateLimiter, createActivationRateLimiters } from "../src/lib/rate-limit.ts";
import { createTestApp } from "./helpers/app.ts";
import { setupTestPools } from "./helpers/db.ts";

let pools: DbPools;
let databaseUrl: string;

beforeAll(async () => {
  const setup = await setupTestPools();
  pools = setup.pools;
  databaseUrl = setup.databaseUrl;
});

afterAll(async () => {
  if (pools) await closeDbPools(pools);
});

function hwidFixture(productUuid: string) {
  const components = {
    product_uuid: productUuid,
    board_serial: "SN-TEST",
    product_name: "HP ProBook 440 G3",
    cpu_id: "Intel(R) Core(TM) i5-6200U",
  };
  const c = canonicalizeHwid(components);
  return {
    components,
    hardware_id: c.hardwareId,
    hwid_hash: c.hwidHash,
    hostname: `host-${productUuid.slice(0, 8)}`,
  };
}

async function seedAdmin() {
  const passwordHash = await hashPassword("admin-pass-123");
  const [admin] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-ADM-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "E2E Admin",
      role: "admin",
      status: "active",
      passwordHash,
    })
    .returning();
  return admin!;
}

async function seedStaff(opts: {
  status: "invited" | "active";
  password?: string;
}) {
  const passwordHash = opts.password
    ? await hashPassword(opts.password)
    : undefined;
  const [user] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-STF-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "E2E Staff",
      role: "staff",
      status: opts.status,
      passwordHash,
    })
    .returning();
  return user!;
}

async function seedCode(opts: {
  userId: string;
  createdBy: string;
  flow: "admin" | "self";
  maxUses?: number;
}) {
  const plain = generateEnrollmentCode();
  const [code] = await pools.owner
    .insert(activationCodes)
    .values({
      codeHash: hashEnrollmentCode(plain),
      codeDisplay: maskEnrollmentCode(plain),
      userId: opts.userId,
      createdBy: opts.createdBy,
      expiresAt: new Date(Date.now() + 86_400_000),
      maxUses: opts.maxUses ?? 1,
      flow: opts.flow,
    })
    .returning();
  return { plain, code: code! };
}

describe("activate e2e", () => {
  test("Flow A: enroll -> approve -> token -> heartbeat", async () => {
    const { app } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });
    const { plain, code } = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
    });
    const hw = hwidFixture(crypto.randomUUID());

    const enrollRes = await app.request("/v1/activate/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_code: plain,
        hardware_id: hw.hardware_id,
        hwid_hash: hw.hwid_hash,
        hwid_components: hw.components,
        hostname: hw.hostname,
        flow: "admin",
      }),
    });
    expect(enrollRes.status).toBe(202);
    const enrollBody = await enrollRes.json();
    expect(enrollBody.status).toBe("pending");
    expect(enrollBody.machine_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const statusPending = await app.request(
      `/v1/activate/status/${enrollBody.machine_id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enrollment_code: plain }),
      },
    );
    expect(statusPending.status).toBe(200);
    const pendingBody = await statusPending.json();
    expect(pendingBody.status).toBe("pending");
    expect(pendingBody.enrollment_nonce).toBeUndefined();
    expect(pendingBody.user_id).toBeUndefined();

    const approved = await approveMachine(pools.app, {
      machineId: enrollBody.machine_id,
      approvedBy: admin.id,
    });
    expect(approved?.enrollmentNonce).toBeTruthy();

    const statusApproved = await app.request(
      `/v1/activate/status/${enrollBody.machine_id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enrollment_code: plain }),
      },
    );
    const approvedBody = await statusApproved.json();
    expect(approvedBody.status).toBe("approved");
    expect(approvedBody.enrollment_nonce).toBe(approved!.enrollmentNonce);

    const tokenRes = await app.request("/v1/activate/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machine_id: enrollBody.machine_id,
        enrollment_nonce: approved!.enrollmentNonce,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json();
    expect(tokenBody.machine_jwt).toBeTruthy();

    const replay = await app.request("/v1/activate/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machine_id: enrollBody.machine_id,
        enrollment_nonce: approved!.enrollmentNonce,
      }),
    });
    expect(replay.status).toBe(410);

    const hb = await app.request("/v1/activate/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenBody.machine_jwt}`,
      },
      body: JSON.stringify({ metrics: { uptime: 1 } }),
    });
    expect(hb.status).toBe(200);
    const hbBody = await hb.json();
    expect(hbBody).toEqual({ ok: true, status: "active" });

    const [row] = await pools.owner
      .select()
      .from(machines)
      .where(eq(machines.id, enrollBody.machine_id));
    expect(row?.userId).toBe(staff.id);
    expect(row?.enrollmentCodeId).toBe(code.id);
    expect(row?.status).toBe("active");
  });

  test("Flow B: self authenticate -> enroll -> approve -> token", async () => {
    const { app } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const password = "staff-pass-123";
    const staff = await seedStaff({ status: "active", password });
    const { plain } = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "self",
    });
    const hw = hwidFixture(crypto.randomUUID());

    const authRes = await app.request("/v1/activate/self/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        employee_id: staff.employeeId,
        password,
        enrollment_code: plain,
      }),
    });
    expect(authRes.status).toBe(200);
    const authBody = await authRes.json();
    expect(authBody.self_provision_token).toBeTruthy();

    const enrollRes = await app.request("/v1/activate/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_code: plain,
        self_provision_token: authBody.self_provision_token,
        hardware_id: hw.hardware_id,
        hwid_hash: hw.hwid_hash,
        hwid_components: hw.components,
        hostname: hw.hostname,
        flow: "self",
      }),
    });
    expect(enrollRes.status).toBe(202);
    const enrollBody = await enrollRes.json();

    const approved = await approveMachine(pools.app, {
      machineId: enrollBody.machine_id,
      approvedBy: admin.id,
    });
    const tokenRes = await app.request("/v1/activate/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machine_id: enrollBody.machine_id,
        enrollment_nonce: approved!.enrollmentNonce,
      }),
    });
    expect(tokenRes.status).toBe(200);
  });

  test("idempotent enroll returns same machine_id", async () => {
    const { app } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });
    const { plain } = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
    });
    const hw = hwidFixture(crypto.randomUUID());
    const body = {
      enrollment_code: plain,
      hardware_id: hw.hardware_id,
      hwid_hash: hw.hwid_hash,
      hwid_components: hw.components,
      hostname: hw.hostname,
      flow: "admin" as const,
    };
    const a = await (await app.request("/v1/activate/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })).json();
    const b = await (await app.request("/v1/activate/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })).json();
    expect(a.machine_id).toBe(b.machine_id);
  });

  test("concurrent single-use enroll: one wins", async () => {
    const { app } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });
    const { plain } = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
      maxUses: 1,
    });
    const hw1 = hwidFixture(crypto.randomUUID());
    const hw2 = hwidFixture(crypto.randomUUID());

    const mk = (hw: typeof hw1) =>
      app.request("/v1/activate/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_code: plain,
          hardware_id: hw.hardware_id,
          hwid_hash: hw.hwid_hash,
          hwid_components: hw.components,
          hostname: hw.hostname,
          flow: "admin",
        }),
      });

    const [r1, r2] = await Promise.all([mk(hw1), mk(hw2)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([202, 401]);
  });

  test("token after revoke returns 409", async () => {
    const { app } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });
    const { plain } = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
    });
    const hw = hwidFixture(crypto.randomUUID());
    const enrollBody = await (
      await app.request("/v1/activate/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_code: plain,
          hardware_id: hw.hardware_id,
          hwid_hash: hw.hwid_hash,
          hwid_components: hw.components,
          hostname: hw.hostname,
          flow: "admin",
        }),
      })
    ).json();

    const approved = await approveMachine(pools.app, {
      machineId: enrollBody.machine_id,
      approvedBy: admin.id,
    });
    await revokeMachine(pools.app, enrollBody.machine_id);

    const tokenRes = await app.request("/v1/activate/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machine_id: enrollBody.machine_id,
        enrollment_nonce: approved!.enrollmentNonce,
      }),
    });
    expect(tokenRes.status).toBe(409);
  });

  test("cross-flow code rejection", async () => {
    const { app } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const password = "staff-pass-xyz";
    const staff = await seedStaff({ status: "active", password });
    const adminCode = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
    });
    const selfCode = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "self",
    });
    const hw = hwidFixture(crypto.randomUUID());

    const authWithAdminCode = await app.request(
      "/v1/activate/self/authenticate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          employee_id: staff.employeeId,
          password,
          enrollment_code: adminCode.plain,
        }),
      },
    );
    expect(authWithAdminCode.status).toBe(401);

    const enrollSelfWithAdminCode = await app.request("/v1/activate/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_code: adminCode.plain,
        self_provision_token: "nope",
        hardware_id: hw.hardware_id,
        hwid_hash: hw.hwid_hash,
        hwid_components: hw.components,
        hostname: hw.hostname,
        flow: "self",
      }),
    });
    expect(enrollSelfWithAdminCode.status).toBe(401);

    const enrollAdminWithSelfCode = await app.request("/v1/activate/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_code: selfCode.plain,
        hardware_id: hw.hardware_id,
        hwid_hash: hw.hwid_hash,
        hwid_components: hw.components,
        hostname: hw.hostname,
        flow: "admin",
      }),
    });
    expect(enrollAdminWithSelfCode.status).toBe(401);
  });

  test("enroll rate limit per IP", async () => {
    const rateLimiters = createActivationRateLimiters();
    // shrink window limiters for enroll IP only
    rateLimiters.enrollIp = new RateLimiter(5, 60_000);
    const { app } = await createTestApp({ pools, rateLimiters });
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { plain } = await seedCode({
        userId: staff.id,
        createdBy: admin.id,
        flow: "admin",
      });
      const hw = hwidFixture(crypto.randomUUID());
      const res = await app.request("/v1/activate/enroll", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.50",
        },
        body: JSON.stringify({
          enrollment_code: plain,
          hardware_id: hw.hardware_id,
          hwid_hash: hw.hwid_hash,
          hwid_components: hw.components,
          hostname: `rl-${i}`,
          flow: "admin",
        }),
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.slice(0, 5).every((s) => s === 202 || s === 401)).toBe(true);
  });

  test("JWKS serves all kids", async () => {
    const { app, jwtKeysJson } = await createTestApp({ pools });
    const kids = JSON.parse(jwtKeysJson).map((k: { kid: string }) => k.kid);
    const res = await app.request("/v1/.well-known/jwks.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toHaveLength(kids.length);
    expect(body.keys.map((k: { kid: string }) => k.kid).sort()).toEqual(
      [...kids].sort(),
    );
  });

  test("status without code is 401", async () => {
    const { app } = await createTestApp({ pools });
    const res = await app.request(
      `/v1/activate/status/${crypto.randomUUID()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(401);
  });

  test("heartbeat rejects revoked machine", async () => {
    const { app } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });
    const { plain } = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
    });
    const hw = hwidFixture(crypto.randomUUID());
    const enrollBody = await (
      await app.request("/v1/activate/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_code: plain,
          hardware_id: hw.hardware_id,
          hwid_hash: hw.hwid_hash,
          hwid_components: hw.components,
          hostname: hw.hostname,
          flow: "admin",
        }),
      })
    ).json();
    const approved = await approveMachine(pools.app, {
      machineId: enrollBody.machine_id,
      approvedBy: admin.id,
    });
    const tokenBody = await (
      await app.request("/v1/activate/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          machine_id: enrollBody.machine_id,
          enrollment_nonce: approved!.enrollmentNonce,
        }),
      })
    ).json();

    await revokeMachine(pools.app, enrollBody.machine_id);
    // leave statusCache stale on purpose - write path must still 403

    const hb = await app.request("/v1/activate/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenBody.machine_jwt}`,
      },
      body: JSON.stringify({}),
    });
    expect(hb.status).toBe(403);
  });

  test("heartbeat rejects JWT without typ=machine", async () => {
    const { app, keyring } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });
    const { plain } = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
    });
    const hw = hwidFixture(crypto.randomUUID());
    const enrollBody = await (
      await app.request("/v1/activate/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_code: plain,
          hardware_id: hw.hardware_id,
          hwid_hash: hw.hwid_hash,
          hwid_components: hw.components,
          hostname: hw.hostname,
          flow: "admin",
        }),
      })
    ).json();
    const approved = await approveMachine(pools.app, {
      machineId: enrollBody.machine_id,
      approvedBy: admin.id,
    });
    await (
      await app.request("/v1/activate/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          machine_id: enrollBody.machine_id,
          enrollment_nonce: approved!.enrollmentNonce,
        }),
      })
    ).json();

    const { signJwt } = await import("../src/lib/jwt.ts");
    const bare = await signJwt(
      keyring,
      { sub: enrollBody.machine_id },
      { expiresIn: "30d" },
    );
    const selfTok = await signJwt(
      keyring,
      {
        typ: "self_provision",
        user_id: staff.id,
        code_id: crypto.randomUUID(),
        sub: enrollBody.machine_id,
      },
      { expiresIn: 900 },
    );

    for (const token of [bare.token, selfTok.token]) {
      const hb = await app.request("/v1/activate/heartbeat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      expect(hb.status).toBe(401);
    }
  });

  test("pending re-bind same user different code under staka_app", async () => {
    const { app } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });
    const first = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
    });
    const second = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
    });
    const hw = hwidFixture(crypto.randomUUID());
    const enroll1 = await (
      await app.request("/v1/activate/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_code: first.plain,
          hardware_id: hw.hardware_id,
          hwid_hash: hw.hwid_hash,
          hwid_components: hw.components,
          hostname: hw.hostname,
          flow: "admin",
        }),
      })
    ).json();

    const enroll2Res = await app.request("/v1/activate/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_code: second.plain,
        hardware_id: hw.hardware_id,
        hwid_hash: hw.hwid_hash,
        hwid_components: hw.components,
        hostname: `${hw.hostname}-rebind`,
        flow: "admin",
      }),
    });
    expect(enroll2Res.status).toBe(202);
    const enroll2 = await enroll2Res.json();
    expect(enroll2.machine_id).toBe(enroll1.machine_id);

    const [row] = await pools.owner
      .select()
      .from(machines)
      .where(eq(machines.id, enroll1.machine_id));
    expect(row?.enrollmentCodeId).toBe(second.code.id);
    expect(row?.hostname).toBe(`${hw.hostname}-rebind`);
  });

  test("auto-approve enroll returns approved", async () => {
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });
    const { plain } = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
    });
    const { app } = await createTestApp({
      pools,
      autoApprove: true,
      autoApproveActorId: admin.id,
    });
    const hw = hwidFixture(crypto.randomUUID());
    const res = await app.request("/v1/activate/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_code: plain,
        hardware_id: hw.hardware_id,
        hwid_hash: hw.hwid_hash,
        hwid_components: hw.components,
        hostname: hw.hostname,
        flow: "admin",
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("approved");

    const statusRes = await app.request(`/v1/activate/status/${body.machine_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollment_code: plain }),
    });
    const statusBody = await statusRes.json();
    expect(statusBody.status).toBe("approved");
    expect(statusBody.enrollment_nonce).toBeTruthy();
  });

  test("status rejects revoked enrollment code", async () => {
    const { app } = await createTestApp({ pools });
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });
    const { plain, code } = await seedCode({
      userId: staff.id,
      createdBy: admin.id,
      flow: "admin",
    });
    const hw = hwidFixture(crypto.randomUUID());
    const enrollBody = await (
      await app.request("/v1/activate/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_code: plain,
          hardware_id: hw.hardware_id,
          hwid_hash: hw.hwid_hash,
          hwid_components: hw.components,
          hostname: hw.hostname,
          flow: "admin",
        }),
      })
    ).json();

    await pools.owner
      .update(activationCodes)
      .set({ revokedAt: new Date() })
      .where(eq(activationCodes.id, code.id));

    const statusRes = await app.request(
      `/v1/activate/status/${enrollBody.machine_id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enrollment_code: plain }),
      },
    );
    expect(statusRes.status).toBe(401);
  });

  test("spoofed X-Forwarded-For does not bypass IP limiter", async () => {
    const rateLimiters = createActivationRateLimiters();
    rateLimiters.enrollIp = new RateLimiter(2, 60_000);
    const { app } = await createTestApp({ pools, rateLimiters, trustProxy: false });
    const admin = await seedAdmin();
    const staff = await seedStaff({ status: "invited" });

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { plain } = await seedCode({
        userId: staff.id,
        createdBy: admin.id,
        flow: "admin",
      });
      const hw = hwidFixture(crypto.randomUUID());
      const res = await app.request("/v1/activate/enroll", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `198.51.100.${i + 1}`,
        },
        body: JSON.stringify({
          enrollment_code: plain,
          hardware_id: hw.hardware_id,
          hwid_hash: hw.hwid_hash,
          hwid_components: hw.components,
          hostname: `spoof-${i}`,
          flow: "admin",
        }),
      });
      statuses.push(res.status);
    }
    expect(statuses[2]).toBe(429);
  });

});
