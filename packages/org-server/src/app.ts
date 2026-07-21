import { Hono } from "hono";
import { requestId } from "./middleware/request-id.ts";
import { healthRoutes, type HealthDeps } from "./routes/health.ts";

export type AppDeps = HealthDeps & {
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
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

  app.get("/v1/config", (c) => c.json({}));

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
