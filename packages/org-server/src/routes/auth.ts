import { AdminLoginRequest } from "@staka/protocol";
import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import type { AdminSessionStore } from "../lib/admin-session.ts";
import { bearerToken, err } from "../lib/http.ts";
import { signJwt, verifyJwt, type JwtKeyring } from "../lib/jwt.ts";
import { verifyPassword } from "../lib/password.ts";
import {
  clientIp,
  type ActivationRateLimiters,
} from "../lib/rate-limit.ts";
import { getActiveAdminByEmployeeId } from "../lib/users.ts";

const ADMIN_JWT_TTL = "8h";
const ADMIN_JWT_TTL_SEC = 8 * 60 * 60;

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

    const user = await getActiveAdminByEmployeeId(
      deps.dbApp,
      parsed.data.employee_id,
    );
    if (!user?.passwordHash) return err(c, 401, "invalid_credentials");
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) return err(c, 401, "invalid_credentials");

    const expiresAtSec = Math.floor(Date.now() / 1000) + ADMIN_JWT_TTL_SEC;
    const jti = deps.sessions.create({
      userId: user.id,
      employeeId: user.employeeId,
      expiresAt: expiresAtSec * 1000,
    });

    const { token, expiresAt } = await signJwt(
      deps.keyring,
      {
        sub: user.id,
        role: "admin",
        employee_id: user.employeeId,
        jti,
      },
      { expiresIn: ADMIN_JWT_TTL },
    );

    return c.json({
      admin_jwt: token,
      expires_at: expiresAt.toISOString(),
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

    const expiresAtSec = Math.floor(Date.now() / 1000) + ADMIN_JWT_TTL_SEC;
    const newJti = deps.sessions.rotate(oldJti, {
      userId,
      employeeId,
      expiresAt: expiresAtSec * 1000,
    });
    if (!newJti) return err(c, 401, "unauthorized");

    const { token: next, expiresAt } = await signJwt(
      deps.keyring,
      {
        sub: userId,
        role: "admin",
        employee_id: employeeId,
        jti: newJti,
      },
      { expiresIn: ADMIN_JWT_TTL },
    );

    return c.json({
      admin_jwt: next,
      expires_at: expiresAt.toISOString(),
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
