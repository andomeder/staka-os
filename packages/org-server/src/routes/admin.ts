import {
  CreateCodeRequest,
  CreateUserRequest,
  SetPasswordRequest,
} from "@staka/protocol";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import { appMachineColumns } from "../db/machine-columns.ts";
import { adminAuditLog, machines, usageLogs, users } from "../db/schema.ts";
import {
  createActivationCode,
  listActivationCodes,
  revokeActivationCode,
} from "../lib/admin-codes.ts";
import { appendAudit } from "../lib/audit.ts";
import { err } from "../lib/http.ts";
import {
  approveMachine,
  revokeMachine,
  suspendMachine,
} from "../lib/machines.ts";
import { getReportsSummary, listMachines, listStaleMachines } from "../lib/reports.ts";
import {
  createUser,
  deactivateUser,
  getUserById,
  listUsers,
  publicUserColumns,
  setUserPassword,
} from "../lib/users.ts";
import {
  adminBearerAuth,
  type AdminAuthDeps,
} from "../middleware/admin-auth.ts";

export type AdminRouteDeps = AdminAuthDeps & {
  dbApp: Db;
  dbAdmin: Db;
};

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    v,
  );
}

export function adminRoutes(deps: AdminRouteDeps) {
  const app = new Hono();
  app.use("/v1/admin/*", adminBearerAuth(deps));

  app.get("/v1/admin/machines", async (c) => {
    const statusRaw = c.req.query("status");
    const allowed = new Set([
      "pending",
      "approved",
      "active",
      "suspended",
      "revoked",
    ]);
    const status =
      statusRaw && allowed.has(statusRaw)
        ? (statusRaw as
            | "pending"
            | "approved"
            | "active"
            | "suspended"
            | "revoked")
        : undefined;
    const rows = await listMachines(
      deps.dbApp,
      status ? { status } : {},
    );
    return c.json({
      machines: rows.map((m) => ({
        id: m.id,
        hostname: m.hostname,
        status: m.status,
        user_id: m.userId,
        hardware_id: m.hardwareId,
        hwid_display: m.hwidDisplay,
        provision_flow: m.provisionFlow,
        first_seen_at: m.firstSeenAt.toISOString(),
        approved_at: m.approvedAt?.toISOString() ?? null,
        last_heartbeat_at: m.lastHeartbeatAt?.toISOString() ?? null,
        created_at: m.createdAt.toISOString(),
      })),
    });
  });

  app.get("/v1/admin/machines/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return err(c, 400, "invalid_id");
    const [machine] = await deps.dbApp
      .select(appMachineColumns)
      .from(machines)
      .where(eq(machines.id, id))
      .limit(1);
    if (!machine) return err(c, 404, "not_found");

    const logs = await deps.dbApp
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.machineId, id))
      .orderBy(desc(usageLogs.createdAt))
      .limit(50);

    const [user] = await deps.dbApp
      .select(publicUserColumns)
      .from(users)
      .where(eq(users.id, machine.userId))
      .limit(1);

    return c.json({
      machine: {
        id: machine.id,
        hostname: machine.hostname,
        status: machine.status,
        user_id: machine.userId,
        hardware_id: machine.hardwareId,
        hwid_display: machine.hwidDisplay,
        provision_flow: machine.provisionFlow,
        first_seen_at: machine.firstSeenAt.toISOString(),
        approved_at: machine.approvedAt?.toISOString() ?? null,
        approved_by: machine.approvedBy,
        last_heartbeat_at: machine.lastHeartbeatAt?.toISOString() ?? null,
        created_at: machine.createdAt.toISOString(),
      },
      user: user
        ? {
            id: user.id,
            employee_id: user.employeeId,
            display_name: user.displayName,
            status: user.status,
          }
        : null,
      logs: logs.map((l) => ({
        id: l.id,
        event_type: l.eventType,
        payload: l.payload,
        created_at: l.createdAt.toISOString(),
      })),
    });
  });

  app.get("/v1/admin/machines/:id/hwid", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return err(c, 400, "invalid_id");
    const auth = c.get("adminAuth");

    const [row] = await deps.dbAdmin
      .select({
        id: machines.id,
        hwidComponents: machines.hwidComponents,
      })
      .from(machines)
      .where(eq(machines.id, id))
      .limit(1);
    if (!row) return err(c, 404, "not_found");

    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "pii.read",
      targetType: "machine",
      targetId: id,
      payload: { field: "hwid_components" },
    });

    await deps.dbApp.insert(usageLogs).values({
      machineId: id,
      eventType: "admin_read_pii",
      payload: { actor_user_id: auth.userId },
    });

    return c.json({
      machine_id: row.id,
      hwid_components: row.hwidComponents,
    });
  });

  app.get("/v1/admin/machines/:id/logs", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return err(c, 400, "invalid_id");
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;

    const [machine] = await deps.dbApp
      .select({ id: machines.id })
      .from(machines)
      .where(eq(machines.id, id))
      .limit(1);
    if (!machine) return err(c, 404, "not_found");

    const logs = await deps.dbApp
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.machineId, id))
      .orderBy(desc(usageLogs.createdAt))
      .limit(limit);

    return c.json({
      logs: logs.map((l) => ({
        id: l.id,
        event_type: l.eventType,
        payload: l.payload,
        created_at: l.createdAt.toISOString(),
      })),
    });
  });

  app.post("/v1/admin/machines/:id/approve", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return err(c, 400, "invalid_id");
    const auth = c.get("adminAuth");

    const result = await approveMachine(deps.dbApp, {
      machineId: id,
      approvedBy: auth.userId,
    });
    if (!result) return err(c, 409, "not_pending");

    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "machine.approve",
      targetType: "machine",
      targetId: id,
      payload: {},
    });

    return c.json({
      machine_id: result.machine.id,
      status: result.machine.status,
      enrollment_nonce: result.enrollmentNonce,
    });
  });

  app.post("/v1/admin/machines/:id/suspend", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return err(c, 400, "invalid_id");
    const auth = c.get("adminAuth");

    const updated = await suspendMachine(deps.dbApp, id);
    if (!updated) return err(c, 409, "not_suspendable");

    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "machine.suspend",
      targetType: "machine",
      targetId: id,
      payload: {},
    });

    return c.json({ machine_id: updated.id, status: updated.status });
  });

  app.post("/v1/admin/machines/:id/revoke", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return err(c, 400, "invalid_id");
    const auth = c.get("adminAuth");

    const updated = await revokeMachine(deps.dbApp, id);
    if (!updated) return err(c, 409, "not_revokable");

    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "machine.revoke",
      targetType: "machine",
      targetId: id,
      payload: {},
    });

    return c.json({ machine_id: updated.id, status: updated.status });
  });

  app.get("/v1/admin/users", async (c) => {
    const rows = await listUsers(deps.dbApp);
    return c.json({
      users: rows.map((u) => ({
        id: u.id,
        employee_id: u.employeeId,
        display_name: u.displayName,
        email: u.email,
        role: u.role,
        status: u.status,
        created_at: u.createdAt.toISOString(),
      })),
    });
  });

  app.post("/v1/admin/users", async (c) => {
    const auth = c.get("adminAuth");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid_body");
    }
    const parsed = CreateUserRequest.safeParse(body);
    if (!parsed.success) return err(c, 400, "invalid_body");

    try {
      const createInput: Parameters<typeof createUser>[1] = {
        employeeId: parsed.data.employee_id,
        displayName: parsed.data.display_name,
        role: parsed.data.role,
      };
      if (parsed.data.initial_password !== undefined) {
        createInput.initialPassword = parsed.data.initial_password;
      }
      if (parsed.data.email !== undefined) {
        createInput.email = parsed.data.email;
      }
      const user = await createUser(deps.dbApp, createInput);

      await appendAudit(deps.dbApp, {
        actorUserId: auth.userId,
        action: "user.create",
        targetType: "user",
        targetId: user.id,
        payload: {
          employee_id: user.employeeId,
          role: user.role,
          status: user.status,
        },
      });

      return c.json(
        {
          user_id: user.id,
          employee_id: user.employeeId,
          status: user.status,
        },
        201,
      );
    } catch {
      return err(c, 409, "conflict");
    }
  });

  app.post("/v1/admin/users/:id/deactivate", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return err(c, 400, "invalid_id");
    const auth = c.get("adminAuth");
    if (id === auth.userId) return err(c, 400, "cannot_deactivate_self");

    const updated = await deactivateUser(deps.dbApp, id);
    if (!updated) return err(c, 404, "not_found");

    deps.sessions.revokeUser(id);

    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "user.deactivate",
      targetType: "user",
      targetId: id,
      payload: {},
    });

    return c.json({
      user_id: updated.id,
      status: updated.status,
      deleted_at: updated.deletedAt?.toISOString() ?? null,
    });
  });

  app.post("/v1/admin/users/:id/set-password", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return err(c, 400, "invalid_id");
    const auth = c.get("adminAuth");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid_body");
    }
    const parsed = SetPasswordRequest.safeParse(body);
    if (!parsed.success) return err(c, 400, "invalid_body");

    const updated = await setUserPassword(deps.dbApp, id, parsed.data.password);
    if (!updated) return err(c, 404, "not_found");

    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "user.set_password",
      targetType: "user",
      targetId: id,
      payload: {},
    });

    return c.json({ user_id: updated.id, status: updated.status });
  });

  app.get("/v1/admin/codes", async (c) => {
    const rows = await listActivationCodes(deps.dbApp);
    return c.json({
      codes: rows.map((code) => ({
        id: code.id,
        code_display: code.codeDisplay,
        user_id: code.userId,
        created_by: code.createdBy,
        flow: code.flow,
        max_uses: code.maxUses,
        uses: code.uses,
        expires_at: code.expiresAt.toISOString(),
        revoked_at: code.revokedAt?.toISOString() ?? null,
        created_at: code.createdAt.toISOString(),
      })),
    });
  });

  app.post("/v1/admin/codes", async (c) => {
    const auth = c.get("adminAuth");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid_body");
    }
    const parsed = CreateCodeRequest.safeParse(body);
    if (!parsed.success) return err(c, 400, "invalid_body");

    const user = await getUserById(deps.dbApp, parsed.data.user_id);
    if (!user) return err(c, 404, "user_not_found");

    const codeInput: Parameters<typeof createActivationCode>[1] = {
      userId: parsed.data.user_id,
      createdBy: auth.userId,
      flow: parsed.data.flow,
    };
    if (parsed.data.max_uses !== undefined) {
      codeInput.maxUses = parsed.data.max_uses;
    }
    if (parsed.data.expires_at !== undefined) {
      codeInput.expiresAt = new Date(parsed.data.expires_at);
    }
    const { code, plaintext } = await createActivationCode(
      deps.dbApp,
      codeInput,
    );

    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "code.create",
      targetType: "activation_code",
      targetId: code.id,
      payload: {
        user_id: code.userId,
        flow: code.flow,
        max_uses: code.maxUses,
      },
    });

    return c.json(
      {
        id: code.id,
        code: plaintext,
        code_display: code.codeDisplay,
        flow: code.flow,
        expires_at: code.expiresAt.toISOString(),
        max_uses: code.maxUses,
      },
      201,
    );
  });

  app.post("/v1/admin/codes/:id/revoke", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return err(c, 400, "invalid_id");
    const auth = c.get("adminAuth");

    const updated = await revokeActivationCode(deps.dbApp, id);
    if (!updated) return err(c, 404, "not_found");

    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "code.revoke",
      targetType: "activation_code",
      targetId: id,
      payload: {},
    });

    return c.json({
      id: updated.id,
      revoked_at: updated.revokedAt?.toISOString() ?? null,
    });
  });

  app.get("/v1/admin/reports/summary", async (c) => {
    const summary = await getReportsSummary(deps.dbApp);
    return c.json(summary);
  });

  app.get("/v1/admin/reports/stale-machines", async (c) => {
    const rows = await listStaleMachines(deps.dbApp);
    return c.json({
      machines: rows.map((m) => ({
        id: m.id,
        hostname: m.hostname,
        status: m.status,
        user_id: m.userId,
        hardware_id: m.hardwareId,
        hwid_display: m.hwidDisplay,
        provision_flow: m.provisionFlow,
        first_seen_at: m.firstSeenAt.toISOString(),
        approved_at: m.approvedAt?.toISOString() ?? null,
        last_heartbeat_at: m.lastHeartbeatAt?.toISOString() ?? null,
        created_at: m.createdAt.toISOString(),
      })),
    });
  });

  app.get("/v1/admin/audit", async (c) => {
    const limitRaw = Number(c.req.query("limit") ?? "100");
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500)
      : 100;

    const rows = await deps.dbApp
      .select()
      .from(adminAuditLog)
      .orderBy(desc(adminAuditLog.id))
      .limit(limit);

    return c.json({
      entries: rows.map((r) => ({
        id: r.id,
        actor_user_id: r.actorUserId,
        action: r.action,
        target_type: r.targetType,
        target_id: r.targetId,
        payload: r.payload,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  return app;
}
