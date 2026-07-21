import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Db } from "../db/client.ts";
import { appMachineColumns } from "../db/machine-columns.ts";
import { machines, usageLogs, users } from "../db/schema.ts";
import {
  createActivationCode,
  listActivationCodes,
  revokeActivationCode,
} from "../lib/admin-codes.ts";
import { appendAudit } from "../lib/audit.ts";
import type { CsrfSigner } from "../lib/csrf.ts";
import { signJwt, verifyJwt } from "../lib/jwt.ts";
import {
  approveMachine,
  revokeMachine,
  suspendMachine,
} from "../lib/machines.ts";
import { verifyPassword } from "../lib/password.ts";
import {
  clientIp,
  type ActivationRateLimiters,
} from "../lib/rate-limit.ts";
import { listMachines } from "../lib/reports.ts";
import {
  createUser,
  getActiveAdminByEmployeeId,
  listUsers,
} from "../lib/users.ts";
import {
  adminCookieOrBearerAuth,
  type AdminAuthDeps,
} from "../middleware/admin-auth.ts";
import {
  CodesPage,
  LoginPage,
  MachineDetailPage,
  MachinesPage,
  NewUserPage,
  UsersPage,
} from "../views/pages.tsx";

const ADMIN_COOKIE = "staka_admin";
const CSRF_COOKIE = "csrf";
const ADMIN_JWT_TTL = "8h";
const ADMIN_JWT_TTL_SEC = 8 * 60 * 60;

export type DashboardDeps = AdminAuthDeps & {
  dbApp: Db;
  dbAdmin: Db;
  csrf: CsrfSigner;
  rateLimiters: ActivationRateLimiters;
  trustProxy?: boolean;
  secureCookies?: boolean;
};

function userLabel(employeeId: string, displayName: string): string {
  return `${displayName} (${employeeId})`;
}

export function dashboardRoutes(deps: DashboardDeps) {
  const app = new Hono();
  const secure = deps.secureCookies === true;

  function mintCsrf(c: Parameters<typeof setCookie>[0]): string {
    const { token, expiresAt } = deps.csrf.mint();
    setCookie(c, CSRF_COOKIE, token, {
      path: "/",
      httpOnly: false,
      sameSite: "Strict",
      secure,
      maxAge: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
    });
    return token;
  }

  async function requireCsrf(
    c: Parameters<typeof getCookie>[0] & {
      req: {
        header: (name: string) => string | undefined;
        parseBody: () => Promise<Record<string, string | File>>;
      };
    },
  ): Promise<{ ok: true; body: Record<string, string> } | { ok: false }> {
    const cookieToken = getCookie(c, CSRF_COOKIE);
    const body = await c.req.parseBody();
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string") flat[k] = v;
    }
    const submitted = flat.csrf ?? c.req.header("x-csrf-token") ?? undefined;
    if (!deps.csrf.verifyPair(cookieToken, submitted)) {
      return { ok: false };
    }
    return { ok: true, body: flat };
  }

  app.get("/admin/login", (c) => {
    const csrf = mintCsrf(c);
    const error = c.req.query("error");
    return c.html(<LoginPage csrf={csrf} {...(error ? { error } : {})} />);
  });

  app.post("/admin/login", async (c) => {
    const checked = await requireCsrf(c);
    if (!checked.ok) return c.redirect("/admin/login?error=csrf");

    const ip = clientIp(c.req.raw.headers, {
      trustProxy: deps.trustProxy === true,
    });
    const employeeId = checked.body.employee_id?.trim() ?? "";
    const password = checked.body.password ?? "";
    if (!employeeId || !password) {
      return c.redirect("/admin/login?error=invalid");
    }

    const ipHit = deps.rateLimiters.adminLoginIp.hit(`ip:${ip}`);
    if (!ipHit.ok) return c.redirect("/admin/login?error=rate_limited");
    const empHit = deps.rateLimiters.adminLoginEmployee.hit(`emp:${employeeId}`);
    if (!empHit.ok) return c.redirect("/admin/login?error=rate_limited");

    const user = await getActiveAdminByEmployeeId(deps.dbApp, employeeId);
    if (!user?.passwordHash) {
      return c.redirect("/admin/login?error=invalid");
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return c.redirect("/admin/login?error=invalid");

    const expiresAtSec = Math.floor(Date.now() / 1000) + ADMIN_JWT_TTL_SEC;
    const jti = deps.sessions.create({
      userId: user.id,
      employeeId: user.employeeId,
      expiresAt: expiresAtSec * 1000,
    });
    const { token } = await signJwt(
      deps.keyring,
      {
        sub: user.id,
        role: "admin",
        employee_id: user.employeeId,
        jti,
      },
      { expiresIn: ADMIN_JWT_TTL },
    );

    setCookie(c, ADMIN_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      secure,
      maxAge: ADMIN_JWT_TTL_SEC,
    });
    mintCsrf(c);
    return c.redirect("/admin");
  });

  app.post("/admin/logout", async (c) => {
    const token = getCookie(c, ADMIN_COOKIE);
    if (token) {
      try {
        const { payload } = await verifyJwt(deps.keyring, token);
        if (typeof payload.jti === "string") deps.sessions.revoke(payload.jti);
      } catch {
        // ignore
      }
    }
    deleteCookie(c, ADMIN_COOKIE, { path: "/" });
    deleteCookie(c, CSRF_COOKIE, { path: "/" });
    return c.redirect("/admin/login");
  });

  const authed = new Hono();
  authed.use("*", adminCookieOrBearerAuth({ ...deps, cookieName: ADMIN_COOKIE }));

  authed.get("/", async (c) => {
    const auth = c.get("adminAuth");
    const csrf = mintCsrf(c);
    const flash = c.req.query("flash") ?? undefined;
    const machineRows = await listMachines(deps.dbApp);
    const userRows = await listUsers(deps.dbApp);
    const byId = new Map(userRows.map((u) => [u.id, u]));

    return c.html(
      <MachinesPage
        employeeId={auth.employeeId}
        csrf={csrf}
        {...(flash ? { flash } : {})}
        machines={machineRows.map((m) => {
          const u = byId.get(m.userId);
          return {
            id: m.id,
            hostname: m.hostname,
            status: m.status,
            userLabel: u
              ? userLabel(u.employeeId, u.displayName)
              : m.userId,
            hwidDisplay: m.hwidDisplay,
            lastHeartbeatAt: m.lastHeartbeatAt?.toISOString() ?? null,
          };
        })}
      />,
    );
  });

  authed.get("/machines/:id", async (c) => {
    const auth = c.get("adminAuth");
    const id = c.req.param("id");
    const csrf = mintCsrf(c);
    const flash = c.req.query("flash") ?? undefined;
    const nonce = c.req.query("nonce") ?? undefined;
    const showPii = c.req.query("pii") === "1";

    const [machine] = await deps.dbApp
      .select(appMachineColumns)
      .from(machines)
      .where(eq(machines.id, id))
      .limit(1);
    if (!machine) return c.notFound();

    const [user] = await deps.dbApp
      .select()
      .from(users)
      .where(eq(users.id, machine.userId))
      .limit(1);

    const logs = await deps.dbApp
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.machineId, id))
      .orderBy(desc(usageLogs.createdAt))
      .limit(50);

    let hwidJson: string | undefined;
    if (showPii) {
      const [row] = await deps.dbAdmin
        .select({ hwidComponents: machines.hwidComponents })
        .from(machines)
        .where(eq(machines.id, id))
        .limit(1);
      if (row) {
        await appendAudit(deps.dbApp, {
          actorUserId: auth.userId,
          action: "pii.read",
          targetType: "machine",
          targetId: id,
          payload: { field: "hwid_components", via: "dashboard" },
        });
        await deps.dbApp.insert(usageLogs).values({
          machineId: id,
          eventType: "admin_read_pii",
          payload: { actor_user_id: auth.userId, via: "dashboard" },
        });
        hwidJson = JSON.stringify(row.hwidComponents, null, 2);
      }
    }

    return c.html(
      <MachineDetailPage
        employeeId={auth.employeeId}
        csrf={csrf}
        {...(flash ? { flash } : {})}
        {...(nonce ? { nonce } : {})}
        {...(hwidJson ? { hwidJson } : {})}
        machine={{
          id: machine.id,
          hostname: machine.hostname,
          status: machine.status,
          hardwareId: machine.hardwareId,
          hwidDisplay: machine.hwidDisplay,
          provisionFlow: machine.provisionFlow,
          firstSeenAt: machine.firstSeenAt.toISOString(),
          approvedAt: machine.approvedAt?.toISOString() ?? null,
          lastHeartbeatAt: machine.lastHeartbeatAt?.toISOString() ?? null,
        }}
        userLabel={
          user ? userLabel(user.employeeId, user.displayName) : machine.userId
        }
        logs={logs.map((l) => ({
          id: l.id,
          eventType: l.eventType,
          createdAt: l.createdAt.toISOString(),
        }))}
      />,
    );
  });

  authed.post("/machines/:id/approve", async (c) => {
    const auth = c.get("adminAuth");
    const id = c.req.param("id");
    const checked = await requireCsrf(c);
    if (!checked.ok) return c.redirect(`/admin/machines/${id}?flash=csrf`);

    const result = await approveMachine(deps.dbApp, {
      machineId: id,
      approvedBy: auth.userId,
    });
    if (!result) return c.redirect(`/admin/machines/${id}?flash=not_pending`);

    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "machine.approve",
      targetType: "machine",
      targetId: id,
      payload: { via: "dashboard" },
    });

    return c.redirect(
      `/admin/machines/${id}?flash=approved&nonce=${encodeURIComponent(result.enrollmentNonce)}`,
    );
  });

  authed.post("/machines/:id/suspend", async (c) => {
    const auth = c.get("adminAuth");
    const id = c.req.param("id");
    const checked = await requireCsrf(c);
    if (!checked.ok) return c.redirect(`/admin?flash=csrf`);

    const updated = await suspendMachine(deps.dbApp, id);
    if (updated) {
      await appendAudit(deps.dbApp, {
        actorUserId: auth.userId,
        action: "machine.suspend",
        targetType: "machine",
        targetId: id,
        payload: { via: "dashboard" },
      });
    }
    return c.redirect("/admin?flash=suspended");
  });

  authed.post("/machines/:id/revoke", async (c) => {
    const auth = c.get("adminAuth");
    const id = c.req.param("id");
    const checked = await requireCsrf(c);
    if (!checked.ok) return c.redirect(`/admin?flash=csrf`);

    const updated = await revokeMachine(deps.dbApp, id);
    if (updated) {
      await appendAudit(deps.dbApp, {
        actorUserId: auth.userId,
        action: "machine.revoke",
        targetType: "machine",
        targetId: id,
        payload: { via: "dashboard" },
      });
    }
    return c.redirect("/admin?flash=revoked");
  });

  authed.post("/machines/:id/hwid", async (c) => {
    const id = c.req.param("id");
    const checked = await requireCsrf(c);
    if (!checked.ok) return c.redirect(`/admin/machines/${id}?flash=csrf`);
    return c.redirect(`/admin/machines/${id}?pii=1`);
  });

  authed.get("/users", async (c) => {
    const auth = c.get("adminAuth");
    const flash = c.req.query("flash") ?? undefined;
    const rows = await listUsers(deps.dbApp);
    return c.html(
      <UsersPage
        employeeId={auth.employeeId}
        {...(flash ? { flash } : {})}
        users={rows.map((u) => ({
          id: u.id,
          employeeId: u.employeeId,
          displayName: u.displayName,
          role: u.role,
          status: u.status,
        }))}
      />,
    );
  });

  authed.get("/users/new", async (c) => {
    const auth = c.get("adminAuth");
    const csrf = mintCsrf(c);
    const error = c.req.query("error");
    return c.html(
      <NewUserPage
        employeeId={auth.employeeId}
        csrf={csrf}
        {...(error ? { error } : {})}
      />,
    );
  });

  authed.post("/users", async (c) => {
    const auth = c.get("adminAuth");
    const checked = await requireCsrf(c);
    if (!checked.ok) return c.redirect("/admin/users/new?error=csrf");

    const employeeId = checked.body.employee_id?.trim() ?? "";
    const displayName = checked.body.display_name?.trim() ?? "";
    const role = checked.body.role === "admin" ? "admin" : "staff";
    const emailRaw = checked.body.email?.trim();
    const passwordRaw = checked.body.initial_password;

    if (!employeeId || !displayName) {
      return c.redirect("/admin/users/new?error=invalid");
    }

    try {
      const createInput: Parameters<typeof createUser>[1] = {
        employeeId,
        displayName,
        role,
      };
      if (emailRaw) createInput.email = emailRaw;
      if (passwordRaw) createInput.initialPassword = passwordRaw;
      const user = await createUser(deps.dbApp, createInput);
      await appendAudit(deps.dbApp, {
        actorUserId: auth.userId,
        action: "user.create",
        targetType: "user",
        targetId: user.id,
        payload: { via: "dashboard", employee_id: employeeId, role },
      });
      return c.redirect("/admin/users?flash=created");
    } catch {
      return c.redirect("/admin/users/new?error=conflict");
    }
  });

  authed.get("/codes", async (c) => {
    const auth = c.get("adminAuth");
    const csrf = mintCsrf(c);
    const flash = c.req.query("flash");
    const createdCode = c.req.query("code");
    const userRows = await listUsers(deps.dbApp);
    const codeRows = await listActivationCodes(deps.dbApp);
    const byId = new Map(userRows.map((u) => [u.id, u]));

    return c.html(
      <CodesPage
        employeeId={auth.employeeId}
        csrf={csrf}
        {...(flash ? { flash } : {})}
        {...(createdCode ? { createdCode } : {})}
        users={userRows.map((u) => ({
          id: u.id,
          label: userLabel(u.employeeId, u.displayName),
        }))}
        codes={codeRows.map((code) => {
          const u = byId.get(code.userId);
          return {
            id: code.id,
            codeDisplay: code.codeDisplay,
            userLabel: u
              ? userLabel(u.employeeId, u.displayName)
              : code.userId,
            flow: code.flow,
            uses: code.uses,
            maxUses: code.maxUses,
            expiresAt: code.expiresAt.toISOString(),
            revokedAt: code.revokedAt?.toISOString() ?? null,
          };
        })}
      />,
    );
  });

  authed.post("/codes", async (c) => {
    const auth = c.get("adminAuth");
    const checked = await requireCsrf(c);
    if (!checked.ok) return c.redirect("/admin/codes?flash=csrf");

    const userId = checked.body.user_id ?? "";
    const flow = checked.body.flow === "self" ? "self" : "admin";
    const maxUses = Number(checked.body.max_uses ?? "1");
    if (!userId) return c.redirect("/admin/codes?flash=invalid");

    const { code, plaintext } = await createActivationCode(deps.dbApp, {
      userId,
      createdBy: auth.userId,
      flow,
      maxUses: Number.isFinite(maxUses) ? maxUses : 1,
    });
    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "code.create",
      targetType: "activation_code",
      targetId: code.id,
      payload: { via: "dashboard", flow },
    });
    return c.redirect(
      `/admin/codes?flash=created&code=${encodeURIComponent(plaintext)}`,
    );
  });

  authed.post("/codes/:id/revoke", async (c) => {
    const auth = c.get("adminAuth");
    const id = c.req.param("id");
    const checked = await requireCsrf(c);
    if (!checked.ok) return c.redirect("/admin/codes?flash=csrf");

    const updated = await revokeActivationCode(deps.dbApp, id);
    if (updated) {
      await appendAudit(deps.dbApp, {
        actorUserId: auth.userId,
        action: "code.revoke",
        targetType: "activation_code",
        targetId: id,
        payload: { via: "dashboard" },
      });
    }
    return c.redirect("/admin/codes?flash=revoked");
  });

  app.route("/admin", authed);
  return app;
}
