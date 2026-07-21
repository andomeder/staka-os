import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbPools } from "../src/db/client.ts";
import { closeDbPools } from "../src/db/client.ts";
import {
  activationCodes,
  adminAuditLog,
  machines,
  users,
} from "../src/db/schema.ts";
import {
  generateEnrollmentCode,
  hashEnrollmentCode,
  maskEnrollmentCode,
} from "../src/lib/codes.ts";
import { canonicalizeHwid } from "../src/lib/hwid.ts";
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

async function seedAdmin(password = "admin-pass-123") {
  const passwordHash = await hashPassword(password);
  const [admin] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-ADM-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Admin E2E",
      role: "admin",
      status: "active",
      passwordHash,
    })
    .returning();
  return { admin: admin!, password };
}

async function login(app: ReturnType<typeof createTestApp> extends Promise<infer T> ? T["app"] : never, employeeId: string, password: string) {
  const res = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ employee_id: employeeId, password }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { admin_jwt: string; expires_at: string };
  expect(body.admin_jwt).toBeTruthy();
  return body.admin_jwt;
}

function authHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function parseSetCookies(res: Response): Record<string, string> {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const raw =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
  const out: Record<string, string> = {};
  for (const line of raw) {
    const first = line.split(";")[0] ?? "";
    const eqIdx = first.indexOf("=");
    if (eqIdx <= 0) continue;
    const k = first.slice(0, eqIdx).trim();
    const v = decodeURIComponent(first.slice(eqIdx + 1).trim());
    out[k] = v;
  }
  return out;
}

describe("admin api e2e", () => {
  test("login refresh logout and admin flow A", async () => {
    const { app } = await createTestApp({ pools });
    const { admin, password } = await seedAdmin();

    const token = await login(app, admin.employeeId, password);

    const refreshRes = await app.request("/v1/auth/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as { admin_jwt: string };
    expect(refreshed.admin_jwt).toBeTruthy();
    expect(refreshed.admin_jwt).not.toBe(token);

    const stale = await app.request("/v1/admin/users", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stale.status).toBe(401);

    const jwt = refreshed.admin_jwt;

    const createUserRes = await app.request("/v1/admin/users", {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({
        employee_id: `EMP-STF-${crypto.randomUUID().slice(0, 8)}`,
        display_name: "Staff User",
        role: "staff",
      }),
    });
    expect(createUserRes.status).toBe(201);
    const createdUser = (await createUserRes.json()) as {
      user_id: string;
      status: string;
    };
    expect(createdUser.status).toBe("invited");

    const codeRes = await app.request("/v1/admin/codes", {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({
        user_id: createdUser.user_id,
        flow: "admin",
        max_uses: 1,
      }),
    });
    expect(codeRes.status).toBe(201);
    const codeBody = (await codeRes.json()) as {
      id: string;
      code: string;
      code_display: string;
    };
    expect(codeBody.code.startsWith("STAKA-")).toBe(true);

    const hw = hwidFixture(crypto.randomUUID());
    const enrollRes = await app.request("/v1/activate/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_code: codeBody.code,
        hardware_id: hw.hardware_id,
        hwid_hash: hw.hwid_hash,
        hwid_components: hw.components,
        hostname: hw.hostname,
        flow: "admin",
      }),
    });
    expect(enrollRes.status).toBe(202);
    const enrollBody = (await enrollRes.json()) as {
      machine_id: string;
      status: string;
    };
    expect(enrollBody.status).toBe("pending");

    const listRes = await app.request("/v1/admin/machines?status=pending", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      machines: Array<{ id: string; user_id: string }>;
    };
    expect(
      listBody.machines.some((m) => m.id === enrollBody.machine_id),
    ).toBe(true);

    const approveRes = await app.request(
      `/v1/admin/machines/${enrollBody.machine_id}/approve`,
      {
        method: "POST",
        headers: authHeaders(jwt),
        body: JSON.stringify({}),
      },
    );
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as {
      enrollment_nonce: string;
      status: string;
    };
    expect(approveBody.status).toBe("approved");
    expect(approveBody.enrollment_nonce).toBeTruthy();

    const tokenRes = await app.request("/v1/activate/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machine_id: enrollBody.machine_id,
        enrollment_nonce: approveBody.enrollment_nonce,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const machineToken = (await tokenRes.json()) as { machine_jwt: string };

    const hb = await app.request("/v1/activate/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${machineToken.machine_jwt}`,
      },
      body: JSON.stringify({}),
    });
    expect(hb.status).toBe(200);

    const hwidRes = await app.request(
      `/v1/admin/machines/${enrollBody.machine_id}/hwid`,
      { headers: { authorization: `Bearer ${jwt}` } },
    );
    expect(hwidRes.status).toBe(200);
    const hwidBody = (await hwidRes.json()) as {
      hwid_components: Record<string, string>;
    };
    expect(hwidBody.hwid_components.product_uuid).toBeTruthy();

    const summaryRes = await app.request("/v1/admin/reports/summary", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(summaryRes.status).toBe(200);
    const summary = (await summaryRes.json()) as {
      machines_by_status: Record<string, number>;
      recent_activations: number;
    };
    expect(summary.machines_by_status.active).toBeGreaterThanOrEqual(1);
    expect(summary.recent_activations).toBeGreaterThanOrEqual(1);

    const auditRes = await app.request("/v1/admin/audit?limit=20", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      entries: Array<{ action: string; target_id: string }>;
    };
    const actions = new Set(auditBody.entries.map((e) => e.action));
    expect(actions.has("user.create")).toBe(true);
    expect(actions.has("code.create")).toBe(true);
    expect(actions.has("machine.approve")).toBe(true);
    expect(actions.has("pii.read")).toBe(true);

    const logoutRes = await app.request("/v1/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(logoutRes.status).toBe(200);

    const afterLogout = await app.request("/v1/admin/users", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(afterLogout.status).toBe(401);
  });

  test("dashboard login XSS escape and approve", async () => {
    const { app } = await createTestApp({ pools });
    const { admin, password } = await seedAdmin();

    const loginPage = await app.request("/admin/login");
    expect(loginPage.status).toBe(200);
    const loginHtml = await loginPage.text();
    expect(loginHtml).toContain('name="csrf"');
    const cookies1 = parseSetCookies(loginPage);
    expect(cookies1.csrf).toBeTruthy();

    const csrfMatch = loginHtml.match(/name="csrf" value="([^"]+)"/);
    expect(csrfMatch?.[1]).toBeTruthy();
    const csrf = csrfMatch![1]!;

    const loginPost = await app.request("/admin/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `csrf=${encodeURIComponent(csrf)}`,
      },
      body: new URLSearchParams({
        csrf,
        employee_id: admin.employeeId,
        password,
      }).toString(),
      redirect: "manual",
    });
    expect([302, 303]).toContain(loginPost.status);
    const cookies2 = parseSetCookies(loginPost);
    expect(cookies2.staka_admin).toBeTruthy();
    const sessionCookie = `staka_admin=${encodeURIComponent(cookies2.staka_admin)}; csrf=${encodeURIComponent(cookies2.csrf ?? csrf)}`;

    // Protocol Zod rejects <> in display_name/hostname. Seed XSS strings via
    // owner to prove the dashboard escapes whatever is already stored.
    const xssName = 'Alice <script>alert("x")</script>';
    const [staff] = await pools.owner
      .insert(users)
      .values({
        employeeId: `EMP-XSS-${crypto.randomUUID().slice(0, 8)}`,
        displayName: xssName,
        role: "staff",
        status: "invited",
      })
      .returning();

    const plain = generateEnrollmentCode();
    const [code] = await pools.owner
      .insert(activationCodes)
      .values({
        codeHash: hashEnrollmentCode(plain),
        codeDisplay: maskEnrollmentCode(plain),
        userId: staff!.id,
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        maxUses: 1,
        flow: "admin",
      })
      .returning();

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
    const enrollBody = (await enrollRes.json()) as { machine_id: string };

    const xssHost = `<script>alert("h")</script>-box`;
    await pools.owner
      .update(machines)
      .set({ hostname: xssHost })
      .where(eq(machines.id, enrollBody.machine_id));

    const dash = await app.request("/admin", {
      headers: { cookie: sessionCookie },
    });
    expect(dash.status).toBe(200);
    const html = await dash.text();
    expect(html).toContain("Machines");
    expect(html).not.toContain('<script>alert("h")</script>');
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(
      html.includes("&lt;script&gt;") || html.includes("&#x3C;script&#x3E;"),
    ).toBe(true);

    const dashCookies = parseSetCookies(dash);
    const csrf2 = dashCookies.csrf;
    expect(csrf2).toBeTruthy();
    const cookieHeader = `staka_admin=${encodeURIComponent(cookies2.staka_admin)}; csrf=${encodeURIComponent(csrf2)}`;

    const approve = await app.request(
      `/admin/machines/${enrollBody.machine_id}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookieHeader,
        },
        body: new URLSearchParams({ csrf: csrf2 }).toString(),
        redirect: "manual",
      },
    );
    expect([302, 303]).toContain(approve.status);
    const loc = approve.headers.get("location") ?? "";
    expect(loc).toContain("nonce=");

    const [row] = await pools.owner
      .select()
      .from(machines)
      .where(eq(machines.id, enrollBody.machine_id));
    expect(row?.status).toBe("approved");
    expect(code?.id).toBeTruthy();

    const audits = await pools.owner.select().from(adminAuditLog);
    expect(audits.some((a) => a.action === "machine.approve")).toBe(true);
  });

  test("staff cannot login to admin", async () => {
    const { app } = await createTestApp({ pools });
    const passwordHash = await hashPassword("staff-pass-123");
    const [staff] = await pools.owner
      .insert(users)
      .values({
        employeeId: `EMP-STF-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Staff Only",
        role: "staff",
        status: "active",
        passwordHash,
      })
      .returning();

    const res = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        employee_id: staff!.employeeId,
        password: "staff-pass-123",
      }),
    });
    expect(res.status).toBe(401);
  });

  test("deactivate and revoke code", async () => {
    const { app } = await createTestApp({ pools });
    const { admin, password } = await seedAdmin();
    const jwt = await login(app, admin.employeeId, password);

    const createUserRes = await app.request("/v1/admin/users", {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({
        employee_id: `EMP-DEL-${crypto.randomUUID().slice(0, 8)}`,
        display_name: "To Deactivate",
        role: "staff",
        initial_password: "initial-pass-99",
      }),
    });
    expect(createUserRes.status).toBe(201);
    const created = (await createUserRes.json()) as {
      user_id: string;
      status: string;
    };
    expect(created.status).toBe("active");

    const codeRes = await app.request("/v1/admin/codes", {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ user_id: created.user_id, flow: "self" }),
    });
    expect(codeRes.status).toBe(201);
    const code = (await codeRes.json()) as { id: string };

    const revoke = await app.request(`/v1/admin/codes/${code.id}/revoke`, {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({}),
    });
    expect(revoke.status).toBe(200);

    const deact = await app.request(
      `/v1/admin/users/${created.user_id}/deactivate`,
      {
        method: "POST",
        headers: authHeaders(jwt),
        body: JSON.stringify({}),
      },
    );
    expect(deact.status).toBe(200);

    const selfDeact = await app.request(
      `/v1/admin/users/${admin.id}/deactivate`,
      {
        method: "POST",
        headers: authHeaders(jwt),
        body: JSON.stringify({}),
      },
    );
    expect(selfDeact.status).toBe(400);
  });
});
