import { AdminLoginRequest } from "@staka/protocol";
import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import {
  loginAdmin,
  refreshAdminJwt,
} from "../lib/admin-auth-tokens.ts";
import type { AdminSessionStore } from "../lib/admin-session.ts";
import { bearerToken, err } from "../lib/http.ts";
import { verifyJwt, type JwtKeyring } from "../lib/jwt.ts";
import {
  clientIp,
  type ActivationRateLimiters,
} from "../lib/rate-limit.ts";

export type AuthDeps = {
  dbApp: Db;
  keyring: JwtKeyring;
  sessions: AdminSessionStore;
  rateLimiters: ActivationRateLimiters;
  trustProxy?: boolean;
};

export function authRoutes(deps: AuthDeps) {
  const app = new Hono();

  app.post("/v1/auth/login", async (c) => {
    const ip = clientIp(c.req.raw.headers, {
      trustProxy: deps.trustProxy === true,
    });
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid_body");
    }
    const parsed = AdminLoginRequest.safeParse(body);
    if (!parsed.success) return err(c, 400, "invalid_body");

    const ipHit = deps.rateLimiters.adminLoginIp.hit(`ip:${ip}`);
    if (!ipHit.ok) {
      c.header("Retry-After", String(ipHit.retryAfterSec));
      return err(c, 429, "rate_limited");
    }
    const empHit = deps.rateLimiters.adminLoginEmployee.hit(
      `emp:${parsed.data.employee_id}`,
    );
    if (!empHit.ok) {
      c.header("Retry-After", String(empHit.retryAfterSec));
      return err(c, 429, "rate_limited");
    }

    const minted = await loginAdmin({
      db: deps.dbApp,
      keyring: deps.keyring,
      sessions: deps.sessions,
      employeeId: parsed.data.employee_id,
      password: parsed.data.password,
    });
    if (!minted) return err(c, 401, "invalid_credentials");

    return c.json({
      admin_jwt: minted.token,
      expires_at: minted.expiresAt.toISOString(),
    });
  });

  app.post("/v1/auth/refresh", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return err(c, 401, "unauthorized");

    let payload;
    try {
      const verified = await verifyJwt(deps.keyring, token);
      payload = verified.payload;
    } catch {
      return err(c, 401, "unauthorized");
    }
    if (payload.role !== "admin") return err(c, 401, "unauthorized");
    const userId = typeof payload.sub === "string" ? payload.sub : null;
    const employeeId =
      typeof payload.employee_id === "string" ? payload.employee_id : null;
    const oldJti = typeof payload.jti === "string" ? payload.jti : null;
    if (!userId || !employeeId || !oldJti) return err(c, 401, "unauthorized");

    const minted = await refreshAdminJwt({
      db: deps.dbApp,
      keyring: deps.keyring,
      sessions: deps.sessions,
      userId,
      employeeId,
      oldJti,
    });
    if (!minted) return err(c, 401, "unauthorized");

    return c.json({
      admin_jwt: minted.token,
      expires_at: minted.expiresAt.toISOString(),
    });
  });

  app.post("/v1/auth/logout", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return err(c, 401, "unauthorized");
    try {
      const { payload } = await verifyJwt(deps.keyring, token);
      if (typeof payload.jti === "string") {
        deps.sessions.revoke(payload.jti);
      }
    } catch {
      return err(c, 401, "unauthorized");
    }
    return c.json({ ok: true as const });
  });

  return app;
}
