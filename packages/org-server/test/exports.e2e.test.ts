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
import { hashPassword } from "../src/lib/password.ts";
import { csvCell, csvDocument, letterheadPdf } from "../src/lib/exports.ts";
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
    board_serial: "SN-EXPORT",
    product_name: "HP ProBook 440 G3",
    cpu_id: "Intel(R) Core(TM) i5-6200U",
  };
  const c = canonicalizeHwid(components);
  return {
    components,
    hardware_id: c.hardwareId,
    hwid_hash: c.hwidHash,
    hostname: `export-${productUuid.slice(0, 8)}`,
  };
}

async function seedAdmin(password = "export-admin-pass") {
  const passwordHash = await hashPassword(password);
  const [admin] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-EXP-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Export Admin",
      role: "admin",
      status: "active",
      passwordHash,
    })
    .returning();
  return { admin: admin!, password };
}

async function dashboardSession(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  employeeId: string,
  password: string,
): Promise<string> {
  const loginPage = await app.request("/admin/login");
  const loginHtml = await loginPage.text();
  const csrf = loginHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
  expect(csrf).toBeTruthy();
  const cookies1 = parseSetCookies(loginPage);

  const loginPost = await app.request("/admin/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `csrf=${encodeURIComponent(csrf!)}`,
    },
    body: new URLSearchParams({
      csrf: csrf!,
      employee_id: employeeId,
      password,
    }).toString(),
    redirect: "manual",
  });
  expect([302, 303]).toContain(loginPost.status);
  const cookies2 = parseSetCookies(loginPost);
  expect(cookies2.staka_admin).toBeTruthy();
  return `staka_admin=${encodeURIComponent(cookies2.staka_admin!)}; csrf=${encodeURIComponent(cookies2.csrf ?? csrf!)}`;
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

async function seedActiveMachine(adminId: string) {
  const [staff] = await pools.owner
    .insert(users)
    .values({
      employeeId: `EMP-EXP-STF-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Export Staff",
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
      createdBy: adminId,
      expiresAt: new Date(Date.now() + 86_400_000),
      maxUses: 1,
      flow: "admin",
    })
    .returning();

  const hw = hwidFixture(crypto.randomUUID());
  const [machine] = await pools.owner
    .insert(machines)
    .values({
      hardwareId: hw.hardware_id,
      hwidHash: hw.hwid_hash,
      hwidDisplay: `${hw.components.product_name}-***-exp`,
      hwidComponents: hw.components,
      hostname: hw.hostname,
      userId: staff!.id,
      enrollmentCodeId: code!.id,
      status: "active",
      provisionFlow: "admin",
      lastHeartbeatAt: new Date(),
    })
    .returning();
  return { machine: machine!, staff: staff!, hostname: hw.hostname };
}

describe("exports lib", () => {
  test("csvCell escapes quotes commas and newlines", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("has,comma")).toBe('"has,comma"');
    expect(csvCell('has"quote')).toBe('"has""quote"');
    expect(csvCell("multi\nline")).toBe('"multi\nline"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(42)).toBe("42");
  });

  test("csvDocument joins with CRLF and trailing terminator", () => {
    const csv = csvDocument(["a", "b"], [["1", "2"]]);
    expect(csv).toBe("a,b\r\n1,2\r\n");
  });

  test("letterheadPdf produces a valid branded PDF", async () => {
    const pdf = await letterheadPdf({
      orgName: "Staka",
      title: "Fleet status report",
      subtitle: "Test subtitle",
      generatedBy: "23-1670",
      generatedAt: "2026-10-01T00:00:00Z",
      sections: [
        {
          heading: "Fleet summary",
          lines: [{ text: "Active: 7", bold: true }, { text: "Pending: 3" }],
          table: {
            header: ["Hostname", "Status"],
            rows: [["WS-1", "active"]],
          },
        },
      ],
    });
    const raw = new TextDecoder("windows-1252").decode(pdf);
    expect(raw.startsWith("%PDF-1.")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    // pdf-lib compresses all objects into object streams; the observable
    // contract is a well-formed header/trailer pair.
    expect(raw).toContain("startxref");
    expect(raw).toContain("%%EOF");
  });
});

describe("dashboard export routes", () => {
  test("machines.csv downloads CSV for a dashboard session", async () => {
    const { app } = await createTestApp({ pools });
    const { admin, password } = await seedAdmin();
    const session = await dashboardSession(app, admin.employeeId, password);
    const seeded = await seedActiveMachine(admin.id);

    const res = await app.request("/admin/machines.csv", {
      headers: { cookie: session },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(".csv");

    const body = await res.text();
    expect(body.startsWith("hostname,status,user,hwid_display,")).toBe(true);
    expect(body).toContain(seeded.hostname);
    // CRLF line endings per RFC 4180
    expect(body.includes("\r\n")).toBe(true);
  });

  test("machines.csv requires a session", async () => {
    const { app } = await createTestApp({ pools });
    const res = await app.request("/admin/machines.csv", {
      redirect: "manual",
    });
    // Cookie auth middleware redirects unauthenticated /admin paths to login
    expect([302, 303]).toContain(res.status);
  });

  test("machines.csv rejects a bearer-less forged cookie", async () => {
    const { app } = await createTestApp({ pools });
    const res = await app.request("/admin/machines.csv", {
      headers: { cookie: "staka_admin=forged.token.value" },
      redirect: "manual",
    });
    expect([302, 303]).toContain(res.status);
  });

  test("reports/stale.csv downloads the stale machine list", async () => {
    const { app } = await createTestApp({ pools });
    const { admin, password } = await seedAdmin();
    const session = await dashboardSession(app, admin.employeeId, password);
    const seeded = await seedActiveMachine(admin.id);
    // Make it stale: no heartbeat for 3 days
    await pools.owner
      .update(machines)
      .set({ lastHeartbeatAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(machines.id, seeded.machine.id));
    // Other rows from previous tests may also be stale; that is fine - the
    // assertion only checks that the seeded hostname appears.

    const res = await app.request("/admin/reports/stale.csv", {
      headers: { cookie: session },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    expect(body.startsWith("hostname,user,hwid_display,")).toBe(true);
    expect(body).toContain(seeded.hostname);
  });

  test("reports/summary.pdf downloads a letterhead PDF", async () => {
    const { app } = await createTestApp({ pools });
    const { admin, password } = await seedAdmin();
    const session = await dashboardSession(app, admin.employeeId, password);
    await seedActiveMachine(admin.id);

    const res = await app.request("/admin/reports/summary.pdf", {
      headers: { cookie: session },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(".pdf");

    const bytes = new Uint8Array(await res.arrayBuffer());
    const body = new TextDecoder("windows-1252").decode(bytes);
    expect(body.startsWith("%PDF-1.")).toBe(true);
    expect(body).toContain("obj");
    expect(body).toContain("startxref");
  });
});
