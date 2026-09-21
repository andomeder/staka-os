import { Hono } from "hono";
import type { Db } from "./db/client.ts";
import type { AdminFlashStore } from "./lib/admin-flash.ts";
import type { AdminSessionStore } from "./lib/admin-session.ts";
import type { CsrfSigner } from "./lib/csrf.ts";
import type { JwtKeyring } from "./lib/jwt.ts";
import { MachineStatusCache } from "./lib/machine-status-cache.ts";
import type { ActivationRateLimiters } from "./lib/rate-limit.ts";
import type { KbConfig } from "./lib/kb.ts";
import { requestId } from "./middleware/request-id.ts";
import { activateRoutes } from "./routes/activate.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { dashboardRoutes } from "./routes/dashboard.tsx";
import { healthRoutes, type HealthDeps } from "./routes/health.ts";
import { configRoutes } from "./routes/config.ts";
import { kbRoutes } from "./routes/kb.ts";

export type AppDeps = HealthDeps & {
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  dbApp?: Db;
  dbAdmin?: Db;
  keyring?: JwtKeyring;
  rateLimiters?: ActivationRateLimiters;
  statusCache?: MachineStatusCache;
  sessions?: AdminSessionStore;
  flashes?: AdminFlashStore;
  csrf?: CsrfSigner;
  autoApprove?: boolean;
  autoApproveActorId?: string;
  trustProxy?: boolean;
  secureCookies?: boolean;
  kb?: KbConfig;
};

export function createApp(deps: AppDeps = {}) {
  const app = new Hono();

  app.use("*", requestId);

  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    const durationMs = Math.round(performance.now() - started);
    deps.logger?.info(
      {
        request_id: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: durationMs,
      },
      "request",
    );
  });

  app.route("/", healthRoutes(deps));

  if (deps.dbApp && deps.keyring && deps.rateLimiters) {
    const activateDeps: Parameters<typeof activateRoutes>[0] = {
      dbApp: deps.dbApp,
      keyring: deps.keyring,
      rateLimiters: deps.rateLimiters,
    };
    if (deps.statusCache) activateDeps.statusCache = deps.statusCache;
    if (deps.autoApprove !== undefined) {
      activateDeps.autoApprove = deps.autoApprove;
    }
    if (deps.autoApproveActorId !== undefined) {
      activateDeps.autoApproveActorId = deps.autoApproveActorId;
    }
    if (deps.trustProxy !== undefined) {
      activateDeps.trustProxy = deps.trustProxy;
    }
    app.route("/", activateRoutes(activateDeps));

    if (deps.sessions) {
      const authDeps: Parameters<typeof authRoutes>[0] = {
        dbApp: deps.dbApp,
        keyring: deps.keyring,
        sessions: deps.sessions,
        rateLimiters: deps.rateLimiters,
      };
      if (deps.trustProxy !== undefined) {
        authDeps.trustProxy = deps.trustProxy;
      }
      app.route("/", authRoutes(authDeps));
    }

    if (deps.sessions && deps.dbAdmin) {
      app.route(
        "/",
        adminRoutes({
          dbApp: deps.dbApp,
          dbAdmin: deps.dbAdmin,
          keyring: deps.keyring,
          sessions: deps.sessions,
        }),
      );
    }

    if (deps.sessions && deps.dbAdmin && deps.csrf && deps.flashes) {
      const dashDeps: Parameters<typeof dashboardRoutes>[0] = {
        dbApp: deps.dbApp,
        dbAdmin: deps.dbAdmin,
        keyring: deps.keyring,
        sessions: deps.sessions,
        csrf: deps.csrf,
        flashes: deps.flashes,
        rateLimiters: deps.rateLimiters,
      };
      if (deps.trustProxy !== undefined) {
        dashDeps.trustProxy = deps.trustProxy;
      }
      if (deps.secureCookies !== undefined) {
        dashDeps.secureCookies = deps.secureCookies;
      }
      if (deps.kb) dashDeps.kb = deps.kb;
      app.route("/", dashboardRoutes(dashDeps));
    }
  }

  if (deps.dbApp && deps.keyring) {
    const cfgDeps: Parameters<typeof configRoutes>[0] = {
      dbApp: deps.dbApp,
      keyring: deps.keyring,
    };
    if (deps.statusCache) cfgDeps.statusCache = deps.statusCache;
    app.route("/", configRoutes(cfgDeps));
  }

  if (deps.dbApp && deps.keyring) {
    const kbDeps: Parameters<typeof kbRoutes>[0] = {
      dbApp: deps.dbApp,
      keyring: deps.keyring,
    };
    if (deps.statusCache) kbDeps.statusCache = deps.statusCache;
    if (deps.kb) kbDeps.kb = deps.kb;
    app.route("/", kbRoutes(kbDeps));
  }

  app.notFound((c) =>
    c.json({ error: "not_found", request_id: c.get("requestId") }, 404),
  );

  app.onError((err, c) => {
    deps.logger?.error(
      { err, request_id: c.get("requestId") },
      "unhandled_error",
    );
    return c.json(
      { error: "internal_error", request_id: c.get("requestId") },
      500,
    );
  });

  return app;
}
