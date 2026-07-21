import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/client.ts";
import type { AdminSessionStore } from "../lib/admin-session.ts";
import { bearerToken, parseCookies } from "../lib/http.ts";
import { verifyJwt, type JwtKeyring } from "../lib/jwt.ts";
import { getActiveAdminById } from "../lib/users.ts";

export type AdminAuth = {
  userId: string;
  employeeId: string;
  jti: string;
  token: string;
};

declare module "hono" {
  interface ContextVariableMap {
    adminAuth: AdminAuth;
  }
}

export type AdminAuthDeps = {
  keyring: JwtKeyring;
  sessions: AdminSessionStore;
  dbApp: Db;
  cookieName?: string;
};

export function adminBearerAuth(deps: AdminAuthDeps): MiddlewareHandler {
  return async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) {
      return c.json(
        { error: "unauthorized", request_id: c.get("requestId") },
        401,
      );
    }
    const auth = await resolveAdminToken(deps, token);
    if (!auth) {
      return c.json(
        { error: "unauthorized", request_id: c.get("requestId") },
        401,
      );
    }
    c.set("adminAuth", auth);
    await next();
  };
}

export function adminCookieOrBearerAuth(
  deps: AdminAuthDeps,
): MiddlewareHandler {
  const cookieName = deps.cookieName ?? "staka_admin";
  return async (c, next) => {
    const headerToken = bearerToken(c.req.header("authorization"));
    const cookies = parseCookies(c.req.header("cookie"));
    const token = headerToken ?? cookies[cookieName];
    if (!token) {
      if (c.req.path.startsWith("/admin")) {
        return c.redirect("/admin/login");
      }
      return c.json(
        { error: "unauthorized", request_id: c.get("requestId") },
        401,
      );
    }
    const auth = await resolveAdminToken(deps, token);
    if (!auth) {
      if (c.req.path.startsWith("/admin") && !headerToken) {
        return c.redirect("/admin/login");
      }
      return c.json(
        { error: "unauthorized", request_id: c.get("requestId") },
        401,
      );
    }
    c.set("adminAuth", auth);
    await next();
  };
}

async function resolveAdminToken(
  deps: AdminAuthDeps,
  token: string,
): Promise<AdminAuth | null> {
  let payload;
  try {
    const verified = await verifyJwt(deps.keyring, token);
    payload = verified.payload;
  } catch {
    return null;
  }
  if (payload.role !== "admin") return null;
  const userId = typeof payload.sub === "string" ? payload.sub : null;
  const employeeId =
    typeof payload.employee_id === "string" ? payload.employee_id : null;
  const jti = typeof payload.jti === "string" ? payload.jti : null;
  if (!userId || !employeeId || !jti) return null;

  const session = deps.sessions.get(jti);
  if (!session || session.userId !== userId) return null;

  const admin = await getActiveAdminById(deps.dbApp, userId);
  if (!admin || admin.employeeId !== employeeId) {
    deps.sessions.revoke(jti);
    return null;
  }

  return {
    userId,
    employeeId,
    jti,
    token,
  };
}
