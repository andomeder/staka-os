import {
  CreateCodeRequest,
  CreateUserRequest,
} from "@staka/protocol";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Db } from "../db/client.ts";
import { appMachineColumns } from "../db/machine-columns.ts";
import { machines, usageLogs } from "../db/schema.ts";
import {
  createActivationCode,
  listActivationCodes,
  revokeActivationCode,
} from "../lib/admin-codes.ts";
import { loginAdmin } from "../lib/admin-auth-tokens.ts";
import type { AdminFlashStore } from "../lib/admin-flash.ts";
import { appendAudit } from "../lib/audit.ts";
import type { CsrfSigner } from "../lib/csrf.ts";
import { sanitizeFlash } from "../lib/flash-messages.ts";
import { verifyJwt } from "../lib/jwt.ts";
import {
  approveMachine,
  revokeMachine,
  suspendMachine,
} from "../lib/machines.ts";
import {
  clientIp,
  type ActivationRateLimiters,
} from "../lib/rate-limit.ts";
import type { KbConfig } from "../lib/kb.ts";
import {
  corpusStats,
  deleteDocument,
  detectUpload,
  ingestDocument,
  KbIngestError,
  KB_MAX_UPLOAD_BYTES,
  listDocuments,
  syncDirectoryProfiles,
  syncUserProfile,
  titleFromFilename,
} from "../lib/kb-ingest.ts";
import { listMachines, listStaleMachines } from "../lib/reports.ts";
import {
  createUser,
  getUserById,
  listUsers,
  publicUserColumns,
} from "../lib/users.ts";
import { users } from "../db/schema.ts";
import {
  adminCookieOrBearerAuth,
  type AdminAuthDeps,
} from "../middleware/admin-auth.ts";
import {
  CodesPage,
  KbPage,
  LoginPage,
  MachineDetailPage,
  MachinesPage,
  NewUserPage,
  StaleMachinesPage,
  UsersPage,
} from "../views/pages.tsx";

const ADMIN_COOKIE = "staka_admin";
const CSRF_COOKIE = "csrf";
const ADMIN_JWT_TTL_SEC = 8 * 60 * 60;

export type DashboardDeps = AdminAuthDeps & {
  dbAdmin: Db;
  csrf: CsrfSigner;
  flashes: AdminFlashStore;
  rateLimiters: ActivationRateLimiters;
  trustProxy?: boolean;
  secureCookies?: boolean;
  kb?: KbConfig;
};

function userLabel(employeeId: string, displayName: string): string {
  return `${displayName} (${employeeId})`;
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    v,
  );
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
    const error = sanitizeFlash(c.req.query("error"));
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

    const minted = await loginAdmin({
      db: deps.dbApp,
      keyring: deps.keyring,
      sessions: deps.sessions,
      employeeId,
      password,
    });
    if (!minted) return c.redirect("/admin/login?error=invalid");

    setCookie(c, ADMIN_COOKIE, minted.token, {
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
    const checked = await requireCsrf(c);
    if (!checked.ok) return c.redirect("/admin/login?error=csrf");

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
  authed.use(
    "*",
    adminCookieOrBearerAuth({
      keyring: deps.keyring,
      sessions: deps.sessions,
      dbApp: deps.dbApp,
      cookieName: ADMIN_COOKIE,
    }),
  );

  authed.get("/", async (c) => {
    const auth = c.get("adminAuth");
    const csrf = mintCsrf(c);
    const flash =
      deps.flashes.take(auth.jti)?.message ??
      sanitizeFlash(c.req.query("flash"));
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
    if (!isUuid(id)) return c.notFound();
    const csrf = mintCsrf(c);
    const taken = deps.flashes.take(auth.jti);
    const flash = taken?.message ?? sanitizeFlash(c.req.query("flash"));
    const nonce = taken?.nonce;
    const hwidJson = taken?.hwidJson;

    const [machine] = await deps.dbApp
      .select(appMachineColumns)
      .from(machines)
      .where(eq(machines.id, id))
      .limit(1);
    if (!machine) return c.notFound();

    const [user] = await deps.dbApp
      .select(publicUserColumns)
      .from(users)
      .where(eq(users.id, machine.userId))
      .limit(1);

    const logs = await deps.dbApp
      .select({
        id: usageLogs.id,
        eventType: usageLogs.eventType,
        createdAt: usageLogs.createdAt,
      })
      .from(usageLogs)
      .where(eq(usageLogs.machineId, id))
      .orderBy(desc(usageLogs.createdAt))
      .limit(50);

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
    if (!isUuid(id)) return c.redirect("/admin?flash=invalid");
    const checked = await requireCsrf(c);
    if (!checked.ok) {
      deps.flashes.set(auth.jti, { message: "csrf" });
      return c.redirect(`/admin/machines/${id}`);
    }

    const result = await approveMachine(deps.dbApp, {
      machineId: id,
      approvedBy: auth.userId,
    });
    if (!result) {
      deps.flashes.set(auth.jti, { message: "not_pending" });
      return c.redirect(`/admin/machines/${id}`);
    }

    await appendAudit(deps.dbApp, {
      actorUserId: auth.userId,
      action: "machine.approve",
      targetType: "machine",
      targetId: id,
      payload: { via: "dashboard" },
    });

    deps.flashes.set(auth.jti, {
      message: "approved",
      nonce: result.enrollmentNonce,
    });
    return c.redirect(`/admin/machines/${id}`);
  });

  authed.post("/machines/:id/suspend", async (c) => {
    const auth = c.get("adminAuth");
    const id = c.req.param("id");
    if (!isUuid(id)) return c.redirect("/admin?flash=invalid");
    const checked = await requireCsrf(c);
    if (!checked.ok) {
      deps.flashes.set(auth.jti, { message: "csrf" });
      return c.redirect("/admin");
    }

    const updated = await suspendMachine(deps.dbApp, id);
    if (updated) {
      await appendAudit(deps.dbApp, {
        actorUserId: auth.userId,
        action: "machine.suspend",
        targetType: "machine",
        targetId: id,
        payload: { via: "dashboard" },
      });
      deps.flashes.set(auth.jti, { message: "suspended" });
    }
    return c.redirect("/admin");
  });

  authed.post("/machines/:id/revoke", async (c) => {
    const auth = c.get("adminAuth");
    const id = c.req.param("id");
    if (!isUuid(id)) return c.redirect("/admin?flash=invalid");
    const checked = await requireCsrf(c);
    if (!checked.ok) {
      deps.flashes.set(auth.jti, { message: "csrf" });
      return c.redirect("/admin");
    }

    const updated = await revokeMachine(deps.dbApp, id);
    if (updated) {
      await appendAudit(deps.dbApp, {
        actorUserId: auth.userId,
        action: "machine.revoke",
        targetType: "machine",
        targetId: id,
        payload: { via: "dashboard" },
      });
      deps.flashes.set(auth.jti, { message: "revoked" });
    }
    return c.redirect("/admin");
  });

  authed.post("/machines/:id/hwid", async (c) => {
    const auth = c.get("adminAuth");
    const id = c.req.param("id");
    if (!isUuid(id)) return c.redirect("/admin?flash=invalid");
    const checked = await requireCsrf(c);
    if (!checked.ok) {
      deps.flashes.set(auth.jti, { message: "csrf" });
      return c.redirect(`/admin/machines/${id}`);
    }

    const [row] = await deps.dbAdmin
      .select({ hwidComponents: machines.hwidComponents })
      .from(machines)
      .where(eq(machines.id, id))
      .limit(1);
    if (!row) {
      deps.flashes.set(auth.jti, { message: "not_found" });
      return c.redirect(`/admin/machines/${id}`);
    }

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

    deps.flashes.set(auth.jti, {
      hwidJson: JSON.stringify(row.hwidComponents, null, 2),
    });
    return c.redirect(`/admin/machines/${id}`);
  });

  authed.get("/users", async (c) => {
    const auth = c.get("adminAuth");
    const csrf = mintCsrf(c);
    const flash =
      deps.flashes.take(auth.jti)?.message ??
      sanitizeFlash(c.req.query("flash"));
    const rows = await listUsers(deps.dbApp);
    return c.html(
      <UsersPage
        employeeId={auth.employeeId}
        csrf={csrf}
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
    const error =
      deps.flashes.take(auth.jti)?.message ??
      sanitizeFlash(c.req.query("error"));
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
    if (!checked.ok) {
      deps.flashes.set(auth.jti, { message: "csrf" });
      return c.redirect("/admin/users/new");
    }

    const raw = {
      employee_id: checked.body.employee_id?.trim() ?? "",
      display_name: checked.body.display_name?.trim() ?? "",
      role: checked.body.role === "admin" ? "admin" : "staff",
      ...(checked.body.email?.trim()
        ? { email: checked.body.email.trim() }
        : {}),
      ...(checked.body.initial_password
        ? { initial_password: checked.body.initial_password }
        : {}),
    };
    const parsed = CreateUserRequest.safeParse(raw);
    if (!parsed.success) {
      deps.flashes.set(auth.jti, { message: "invalid" });
      return c.redirect("/admin/users/new");
    }

    try {
      const createInput: Parameters<typeof createUser>[1] = {
        employeeId: parsed.data.employee_id,
        displayName: parsed.data.display_name,
        role: parsed.data.role,
      };
      if (parsed.data.email !== undefined) createInput.email = parsed.data.email;
      if (parsed.data.initial_password !== undefined) {
        createInput.initialPassword = parsed.data.initial_password;
      }
      const user = await createUser(deps.dbApp, createInput);
      await appendAudit(deps.dbApp, {
        actorUserId: auth.userId,
        action: "user.create",
        targetType: "user",
        targetId: user.id,
        payload: {
          via: "dashboard",
          employee_id: user.employeeId,
          role: user.role,
        },
      });
      deps.flashes.set(auth.jti, { message: "created" });
      const kb = kbIngestDeps();
      if (kb) {
        // Keep the KB directory profile in step with the new user. The
        // user exists either way; a KB hiccup must not fail the create.
        try {
          await syncUserProfile(kb, {
            employeeId: user.employeeId,
            displayName: user.displayName,
            role: user.role,
            email: user.email ?? null,
          });
        } catch {
          // non-fatal: the next directory sync repairs the profile
        }
      }
      return c.redirect("/admin/users");
    } catch {
      deps.flashes.set(auth.jti, { message: "conflict" });
      return c.redirect("/admin/users/new");
    }
  });

  authed.get("/codes", async (c) => {
    const auth = c.get("adminAuth");
    const csrf = mintCsrf(c);
    const taken = deps.flashes.take(auth.jti);
    const flash = taken?.message ?? sanitizeFlash(c.req.query("flash"));
    const createdCode = taken?.code;
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
    if (!checked.ok) {
      deps.flashes.set(auth.jti, { message: "csrf" });
      return c.redirect("/admin/codes");
    }

    const maxUsesRaw = checked.body.max_uses?.trim();
    const raw = {
      user_id: checked.body.user_id ?? "",
      flow: checked.body.flow === "self" ? "self" : "admin",
      ...(maxUsesRaw
        ? { max_uses: Number(maxUsesRaw) }
        : {}),
    };
    const parsed = CreateCodeRequest.safeParse(raw);
    if (!parsed.success) {
      deps.flashes.set(auth.jti, { message: "invalid" });
      return c.redirect("/admin/codes");
    }

    const user = await getUserById(deps.dbApp, parsed.data.user_id);
    if (!user) {
      deps.flashes.set(auth.jti, { message: "user_not_found" });
      return c.redirect("/admin/codes");
    }

    const codeInput: Parameters<typeof createActivationCode>[1] = {
      userId: parsed.data.user_id,
      createdBy: auth.userId,
      flow: parsed.data.flow,
    };
    if (parsed.data.max_uses !== undefined) {
      codeInput.maxUses = parsed.data.max_uses;
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
      payload: { via: "dashboard", flow: code.flow },
    });
    deps.flashes.set(auth.jti, { message: "created", code: plaintext });
    return c.redirect("/admin/codes");
  });

  authed.post("/codes/:id/revoke", async (c) => {
    const auth = c.get("adminAuth");
    const id = c.req.param("id");
    if (!isUuid(id)) {
      deps.flashes.set(auth.jti, { message: "invalid" });
      return c.redirect("/admin/codes");
    }
    const checked = await requireCsrf(c);
    if (!checked.ok) {
      deps.flashes.set(auth.jti, { message: "csrf" });
      return c.redirect("/admin/codes");
    }

    const updated = await revokeActivationCode(deps.dbApp, id);
    if (updated) {
      await appendAudit(deps.dbApp, {
        actorUserId: auth.userId,
        action: "code.revoke",
        targetType: "activation_code",
        targetId: id,
        payload: { via: "dashboard" },
      });
      deps.flashes.set(auth.jti, { message: "revoked" });
    }
    return c.redirect("/admin/codes");
  });

  authed.get("/reports/stale", async (c) => {
    const auth = c.get("adminAuth");
    const csrf = mintCsrf(c);
    const flash =
      deps.flashes.take(auth.jti)?.message ??
      sanitizeFlash(c.req.query("flash"));
    const staleRows = await listStaleMachines(deps.dbApp);
    const userRows = await listUsers(deps.dbApp);
    const byId = new Map(userRows.map((u) => [u.id, u]));

    return c.html(
      <StaleMachinesPage
        employeeId={auth.employeeId}
        csrf={csrf}
        {...(flash ? { flash } : {})}
        machines={staleRows.map((m) => {
          const u = byId.get(m.userId);
          return {
            id: m.id,
            hostname: m.hostname,
            userLabel: u
              ? userLabel(u.employeeId, u.displayName)
              : m.userId,
            hwidDisplay: m.hwidDisplay,
            lastHeartbeatAt: m.lastHeartbeatAt?.toISOString() ?? null,
            firstSeenAt: m.firstSeenAt.toISOString(),
          };
        })}
      />,
    );
  });

  function kbIngestDeps() {
    if (!deps.kb) return undefined;
    return {
      db: deps.dbAdmin,
      client: deps.kb.client,
      space: deps.kb.space,
      orgId: deps.kb.space.slice("org_".length),
    };
  }

  authed.get("/kb", async (c) => {
    const auth = c.get("adminAuth");
    const csrf = mintCsrf(c);
    const flash =
      deps.flashes.take(auth.jti)?.message ??
      sanitizeFlash(c.req.query("flash"));
    const kb = kbIngestDeps();
    const rows = kb ? await listDocuments(kb) : [];
    const stats = kb
      ? await corpusStats(kb)
      : { documents: 0, sensitive: 0, totalBytes: 0, bySource: {} };
    return c.html(
      <KbPage
        employeeId={auth.employeeId}
        csrf={csrf}
        {...(flash ? { flash } : {})}
        stats={stats}
        documents={rows.map((d) => ({
          customId: d.customId,
          title: d.title,
          source: d.source,
          docType: d.docType,
          sensitive: d.sensitive,
          sizeBytes: d.sizeBytes,
          createdAt: d.createdAt.toISOString().slice(0, 10),
        }))}
      />,
    );
  });

  authed.post("/kb/documents", async (c) => {
    const auth = c.get("adminAuth");
    const kb = kbIngestDeps();
    if (!kb) {
      deps.flashes.set(auth.jti, { message: "kb_disabled" });
      return c.redirect("/admin/kb");
    }

    const cookieToken = getCookie(c, CSRF_COOKIE);
    const form = await c.req.parseBody();
    const submitted =
      typeof form.csrf === "string" ? form.csrf : c.req.header("x-csrf-token");
    if (!deps.csrf.verifyPair(cookieToken, submitted)) {
      deps.flashes.set(auth.jti, { message: "csrf" });
      return c.redirect("/admin/kb");
    }

    const file = form.file;
    const title =
      typeof form.title === "string" && form.title.trim().length > 0
        ? form.title.trim()
        : undefined;
    const sensitive = form.sensitive === "1";

    try {
      if (!(file instanceof File) || file.size === 0) {
        throw new KbIngestError(400, "no_file");
      }
      if (file.size > KB_MAX_UPLOAD_BYTES) {
        throw new KbIngestError(413, "too_large");
      }
      const detected = detectUpload(file.name);
      await ingestDocument(kb, {
        title: title ?? titleFromFilename(file.name),
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        mime: detected.mime,
        source: "upload",
        docType: detected.docType,
        sensitive,
        uploadedBy: auth.userId,
      });
      await appendAudit(deps.dbAdmin, {
        actorUserId: auth.userId,
        action: "kb.document.upload",
        targetType: "kb_document",
        targetId: auth.userId,
        payload: { filename: file.name, sensitive },
      });
      deps.flashes.set(auth.jti, { message: "kb_uploaded" });
    } catch (err) {
      if (err instanceof KbIngestError) {
        deps.flashes.set(auth.jti, { message: `kb_${err.status}` });
      } else {
        deps.flashes.set(auth.jti, { message: "kb_error" });
      }
    }
    return c.redirect("/admin/kb");
  });

  authed.post("/kb/documents/:customId/delete", async (c) => {
    const auth = c.get("adminAuth");
    const kb = kbIngestDeps();
    if (!kb) {
      deps.flashes.set(auth.jti, { message: "kb_disabled" });
      return c.redirect("/admin/kb");
    }
    const checked = await requireCsrf(c);
    if (!checked.ok) {
      deps.flashes.set(auth.jti, { message: "csrf" });
      return c.redirect("/admin/kb");
    }
    const customId = c.req.param("customId");
    const removed = await deleteDocument(kb, customId);
    if (removed) {
      await appendAudit(deps.dbAdmin, {
        actorUserId: auth.userId,
        action: "kb.document.delete",
        targetType: "kb_document",
        targetId: auth.userId,
        payload: { custom_id: customId },
      });
      deps.flashes.set(auth.jti, { message: "kb_deleted" });
    } else {
      deps.flashes.set(auth.jti, { message: "kb_missing" });
    }
    return c.redirect("/admin/kb");
  });

  authed.post("/kb/profiles/sync", async (c) => {
    const auth = c.get("adminAuth");
    const kb = kbIngestDeps();
    if (!kb) {
      deps.flashes.set(auth.jti, { message: "kb_disabled" });
      return c.redirect("/admin/kb");
    }
    const checked = await requireCsrf(c);
    if (!checked.ok) {
      deps.flashes.set(auth.jti, { message: "csrf" });
      return c.redirect("/admin/kb");
    }
    try {
      const count = await syncDirectoryProfiles(kb);
      await appendAudit(deps.dbAdmin, {
        actorUserId: auth.userId,
        action: "kb.profiles.sync",
        targetType: "kb_document",
        targetId: auth.userId,
        payload: { profiles: count },
      });
      deps.flashes.set(auth.jti, { message: "kb_profiles_synced" });
    } catch {
      deps.flashes.set(auth.jti, { message: "kb_unavailable" });
    }
    return c.redirect("/admin/kb");
  });

  app.route("/admin", authed);
  return app;
}
