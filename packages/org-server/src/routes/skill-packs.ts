import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import { err } from "../lib/http.ts";
import type { JwtKeyring } from "../lib/jwt.ts";
import {
  getSkillPackBytes,
  listPackVersions,
  latestSkillPack,
  parsePackBytes,
  SkillPackError,
  storeSkillPack,
  type PackSkill,
} from "../lib/skill-packs.ts";
import type { MachineStatusCache } from "../lib/machine-status-cache.ts";
import { machineBearerAuth } from "../middleware/machine-auth.ts";
import {
  adminBearerAuth,
  type AdminAuthDeps,
} from "../middleware/admin-auth.ts";

export type SkillPackRouteDeps = AdminAuthDeps & {
  dbApp: Db;
  keyring: JwtKeyring;
  statusCache?: MachineStatusCache;
};

export type SkillPackAdminDeps = AdminAuthDeps & {
  dbAdmin: Db;
  /** Index uploaded skills into the KB; absent when the KB is disabled. */
  parseAndIndex?: (bytes: Uint8Array) => Promise<{ skills: PackSkill[]; indexed: boolean }>;
};

export function skillPackAdminRoutes(deps: SkillPackAdminDeps) {
  const app = new Hono();
  const auth = adminBearerAuth(deps);
  app.use("/v1/admin/skill-packs", auth);
  app.use("/v1/admin/skill-packs/*", auth);

  app.get("/v1/admin/skill-packs", async (c) => {
    const versions = await listPackVersions(deps.dbAdmin);
    return c.json({ versions });
  });

  app.post("/v1/admin/skill-packs", async (c) => {
    const auth = c.get("adminAuth");
    const contentType = c.req.header("content-type") ?? "";
    let bytes: Uint8Array;
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File) || file.size === 0) {
        return err(c, 400, "missing_pack_file");
      }
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      bytes = new Uint8Array(await c.req.arrayBuffer());
    }
    if (!deps.parseAndIndex) {
      return err(c, 503, "kb_unavailable");
    }
    try {
      const { skills, indexed } = await deps.parseAndIndex(bytes);
      const stored = await storeSkillPack({
        db: deps.dbAdmin,
        bytes,
        uploadedBy: auth.userId,
        skills,
      });
      return c.json({ ...stored, indexed });
    } catch (e) {
      if (e instanceof SkillPackError) {
        return err(c, e.status, "invalid_pack", { detail: e.message });
      }
      throw e;
    }
  });

  return app;
}

export function skillPackMachineRoutes(deps: SkillPackRouteDeps) {
  const app = new Hono();
  const auth = machineBearerAuth({
    dbApp: deps.dbApp,
    keyring: deps.keyring,
    statusCache: deps.statusCache,
  });

  app.get("/v1/skill-packs/latest", auth, async (c) => {
    const latest = await latestSkillPack(deps.dbApp);
    if (!latest) return err(c, 404, "no_skill_pack");
    return c.json(latest);
  });

  app.get("/v1/skill-packs/pull", auth, async (c) => {
    const requested = c.req.query("version");
    if (requested !== undefined && !/^\d+$/.test(requested)) {
      return err(c, 400, "invalid_version");
    }
    const pack = await getSkillPackBytes(
      deps.dbApp,
      requested ? Number(requested) : undefined,
    );
    if (!pack) return err(c, 404, "no_skill_pack");
    return new Response(new Uint8Array(pack.content), {
      headers: {
        "content-type": "application/gzip",
        "x-staka-pack-version": String(pack.version),
        "x-staka-pack-sha256": pack.sha256,
      },
    });
  });

  return app;
}
