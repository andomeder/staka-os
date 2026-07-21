import { Hono } from "hono";

export type HealthDeps = {
  checkDb?: () => Promise<boolean>;
};

export function healthRoutes(deps: HealthDeps = {}) {
  const app = new Hono();

  app.get("/v1/health", (c) =>
    c.json({ ok: true, service: "staka-org-server" }),
  );

  app.get("/v1/ready", async (c) => {
    if (!deps.checkDb) {
      return c.json({ ok: true, db: "unchecked" });
    }
    try {
      const ok = await deps.checkDb();
      if (!ok) {
        return c.json({ ok: false, db: "unreachable" }, 503);
      }
      return c.json({ ok: true, db: "up" });
    } catch {
      return c.json({ ok: false, db: "unreachable" }, 503);
    }
  });

  return app;
}
