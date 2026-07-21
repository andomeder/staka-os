import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { appendAudit, verifyAuditChain } from "../src/lib/audit.ts";
import {
  hashEnrollmentCode,
  maskEnrollmentCode,
} from "../src/lib/codes.ts";
import { hashPassword } from "../src/lib/password.ts";
import {
  activationCodes,
  adminAuditLog,
  machines,
  users,
} from "../src/db/schema.ts";
import { createDb } from "../src/db/client.ts";
import { roleUrl, setupTestDb } from "./helpers/db.ts";

let ownerDb: ReturnType<typeof createDb>;
let databaseUrl: string;

beforeAll(async () => {
  const setup = await setupTestDb();
  ownerDb = setup.db;
  databaseUrl = setup.databaseUrl;
});

afterAll(async () => {
  await ownerDb?.$client.end({ timeout: 2 });
});

describe("schema + grants", () => {
  test("creates users with uuidv7 ids and unique employee_id", async () => {
    const passwordHash = await hashPassword("test-password-123");
    const [admin] = await ownerDb
      .insert(users)
      .values({
        employeeId: `EMP-SCHEMA-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Schema Admin",
        role: "admin",
        status: "active",
        passwordHash,
      })
      .returning();

    expect(admin?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    let threw = false;
    try {
      await ownerDb.insert(users).values({
        employeeId: admin!.employeeId,
        displayName: "Dup",
        role: "staff",
        status: "invited",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("machine user_id is required and bound from enrollment code", async () => {
    const passwordHash = await hashPassword("test-password-123");
    const emp = `EMP-M-${crypto.randomUUID().slice(0, 8)}`;
    const [user] = await ownerDb
      .insert(users)
      .values({
        employeeId: emp,
        displayName: "Staff User",
        role: "staff",
        status: "invited",
      })
      .returning();
    const [admin] = await ownerDb
      .insert(users)
      .values({
        employeeId: `EMP-A-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Admin",
        role: "admin",
        status: "active",
        passwordHash,
      })
      .returning();

    const codePlain = `STAKA-TEST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const [code] = await ownerDb
      .insert(activationCodes)
      .values({
        codeHash: hashEnrollmentCode(codePlain),
        codeDisplay: maskEnrollmentCode(codePlain),
        userId: user!.id,
        createdBy: admin!.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        flow: "admin",
      })
      .returning();

    const [machine] = await ownerDb
      .insert(machines)
      .values({
        hardwareId: `hw-${crypto.randomUUID()}`,
        hwidHash: "h".repeat(64),
        hwidDisplay: "ProBook-***-1234",
        hwidComponents: {
          product_uuid: "11111111-1111-1111-1111-111111111111",
          board_serial: "SN",
          product_name: "HP ProBook 440 G3",
          cpu_id: "cpu",
        },
        hostname: "lab-01",
        userId: user!.id,
        enrollmentCodeId: code!.id,
        provisionFlow: "admin",
      })
      .returning();

    expect(machine?.userId).toBe(user!.id);
    expect(machine?.status).toBe("pending");
  });

  test("admin_audit_log rejects UPDATE/DELETE for staka_app", async () => {
    const passwordHash = await hashPassword("test-password-123");
    const [admin] = await ownerDb
      .insert(users)
      .values({
        employeeId: `EMP-AUD-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Audit Admin",
        role: "admin",
        status: "active",
        passwordHash,
      })
      .returning();

    const row = await appendAudit(ownerDb, {
      actorUserId: admin!.id,
      action: "user.create",
      targetType: "user",
      targetId: admin!.id,
      payload: { employee_id: admin!.employeeId },
    });

    const chain = await verifyAuditChain(ownerDb);
    expect(chain.ok).toBe(true);
    expect(chain.checked).toBeGreaterThan(0);

    const appSql = postgres(roleUrl(databaseUrl, "staka_app"), {
      max: 1,
      prepare: false,
    });
    try {
      let updateBlocked = false;
      try {
        await appSql`update admin_audit_log set action = 'tamper' where id = ${row.id}`;
      } catch {
        updateBlocked = true;
      }
      expect(updateBlocked).toBe(true);

      let deleteBlocked = false;
      try {
        await appSql`delete from admin_audit_log where id = ${row.id}`;
      } catch {
        deleteBlocked = true;
      }
      expect(deleteBlocked).toBe(true);

      const insertOk = await appSql`
        insert into admin_audit_log (actor_user_id, action, target_type, target_id, payload, prev_hash)
        values (${admin!.id}, 'probe', 'user', ${admin!.id}, '{}'::jsonb, ${"0".repeat(64)})
        returning id
      `;
      expect(insertOk.length).toBe(1);
    } finally {
      await appSql.end({ timeout: 1 });
    }

    // keep chain verifier usable after probe insert
    await ownerDb.delete(adminAuditLog);
  });

  test("staka_app cannot SELECT machines.hwid_components; staka_admin can", async () => {
    const passwordHash = await hashPassword("test-password-123");
    const [user] = await ownerDb
      .insert(users)
      .values({
        employeeId: `EMP-PII-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "PII User",
        role: "staff",
        status: "invited",
      })
      .returning();
    const [admin] = await ownerDb
      .insert(users)
      .values({
        employeeId: `EMP-PIIA-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "PII Admin",
        role: "admin",
        status: "active",
        passwordHash,
      })
      .returning();
    const [code] = await ownerDb
      .insert(activationCodes)
      .values({
        codeHash: hashEnrollmentCode(`STAKA-PII-${crypto.randomUUID().slice(0, 4)}`),
        codeDisplay: "STAKA-PII…XXXX",
        userId: user!.id,
        createdBy: admin!.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        flow: "admin",
      })
      .returning();
    const [machine] = await ownerDb
      .insert(machines)
      .values({
        hardwareId: `hw-pii-${crypto.randomUUID()}`,
        hwidHash: "p".repeat(64),
        hwidDisplay: "ProBook-***-9999",
        hwidComponents: {
          product_uuid: "22222222-2222-2222-2222-222222222222",
          board_serial: "SN2",
          product_name: "HP ProBook 440 G3",
          cpu_id: "cpu2",
        },
        hostname: "lab-pii",
        userId: user!.id,
        enrollmentCodeId: code!.id,
        provisionFlow: "admin",
      })
      .returning();

    const appSql = postgres(roleUrl(databaseUrl, "staka_app"), {
      max: 1,
      prepare: false,
    });
    const adminSql = postgres(roleUrl(databaseUrl, "staka_admin"), {
      max: 1,
      prepare: false,
    });
    try {
      let appBlocked = false;
      try {
        await appSql`select hwid_components from machines where id = ${machine!.id}`;
      } catch {
        appBlocked = true;
      }
      expect(appBlocked).toBe(true);

      const allowed = await appSql`
        select id, hostname, hwid_display from machines where id = ${machine!.id}
      `;
      expect(allowed[0]?.hostname).toBe("lab-pii");

      const pii = await adminSql`
        select hwid_components from machines where id = ${machine!.id}
      `;
      expect(pii[0]?.hwid_components).toBeTruthy();
    } finally {
      await appSql.end({ timeout: 1 });
      await adminSql.end({ timeout: 1 });
    }
  });
});
