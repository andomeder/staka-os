import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { usageLogs } from "../db/schema.ts";
import {
  KB_META_DOC_TYPE,
  KB_META_SENSITIVE,
  KbEngineError,
  KbUnavailableError,
  type KbConfig,
  type KbSearchResult,
} from "../lib/kb.ts";
import type { JwtKeyring } from "../lib/jwt.ts";
import { err } from "../lib/http.ts";
import { MachineStatusCache } from "../lib/machine-status-cache.ts";
import { machineBearerAuth } from "../middleware/machine-auth.ts";

export type KbRoutesDeps = {
  dbApp: Db;
  keyring: JwtKeyring;
  kb?: KbConfig;
  statusCache?: MachineStatusCache;
  /** Cap for full document text returned to agents. */
  maxDocumentChars?: number;
};

const searchSchema = z.object({
  query: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(20).optional(),
});

const whoKnowsSchema = z.object({
  topic: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(10).optional(),
});

const DOC_TYPE_PROFILE = "profile";
const DEFAULT_MAX_DOCUMENT_CHARS = 20_000;

/** Drop documents flagged sensitive before they reach an agent. */
function withoutSensitive(results: KbSearchResult[]): KbSearchResult[] {
  return results.filter((r) => r.metadata[KB_META_SENSITIVE] !== true);
}

type ProfileFacts = {
  employee_id: string | null;
  display_name: string | null;
};

function extractProfileFacts(content: string): ProfileFacts {
  const employee = content.match(/employee_id\s*:\s*([A-Za-z0-9_.-]+)/);
  const name = content.match(/(?:^|\n)#\s+(.+)/);
  return {
    employee_id: employee?.[1] ?? null,
    display_name: name?.[1]?.trim() ?? null,
  };
}

export function kbRoutes(deps: KbRoutesDeps) {
  const app = new Hono();
  const auth = machineBearerAuth({
    dbApp: deps.dbApp,
    keyring: deps.keyring,
    statusCache: deps.statusCache,
  });

  app.post("/v1/kb/search", auth, async (c) => {
    if (!deps.kb) return err(c, 503, "kb_unavailable");
    const machineId = c.get("machineAuth").machineId;

    let parsedBody: z.infer<typeof searchSchema>;
    try {
      parsedBody = searchSchema.parse(await c.req.json());
    } catch {
      return err(c, 400, "invalid_request");
    }

    try {
      const results = withoutSensitive(
        await deps.kb.client.search({
          query: parsedBody.query,
          space: deps.kb.space,
          limit: parsedBody.limit,
        }),
      );
      await deps.dbApp.insert(usageLogs).values({
        machineId,
        eventType: "kb_search",
        payload: { results: results.length },
      });
      return c.json({
        results: results.map((r) => ({
          id: r.documentId,
          title: r.title,
          snippet: r.snippet,
          score: r.score,
          source: r.metadata.source ?? null,
          uploaded_by: r.metadata.uploaded_by ?? null,
          doc_type: r.metadata[KB_META_DOC_TYPE] ?? null,
        })),
      });
    } catch (e) {
      if (e instanceof KbEngineError) return err(c, 502, "kb_engine_error");
      if (e instanceof KbUnavailableError) return err(c, 503, "kb_unavailable");
      throw e;
    }
  });

  app.post("/v1/kb/who-knows", auth, async (c) => {
    if (!deps.kb) return err(c, 503, "kb_unavailable");
    const machineId = c.get("machineAuth").machineId;

    let parsedBody: z.infer<typeof whoKnowsSchema>;
    try {
      parsedBody = whoKnowsSchema.parse(await c.req.json());
    } catch {
      return err(c, 400, "invalid_request");
    }

    try {
      const hits = withoutSensitive(
        await deps.kb.client.search({
          query: parsedBody.topic,
          space: deps.kb.space,
          limit: Math.min(20, (parsedBody.limit ?? 5) * 4),
          filters: {
            AND: [{ key: KB_META_DOC_TYPE, value: DOC_TYPE_PROFILE }],
          },
        }),
      );
      const people = new Map<
        string,
        {
          employee_id: string | null;
          display_name: string | null;
          evidence: string[];
          score: number;
        }
      >();
      for (const hit of hits) {
        if (hit.metadata[KB_META_DOC_TYPE] !== DOC_TYPE_PROFILE) continue;
        const facts = extractProfileFacts(hit.snippet);
        const key = facts.employee_id ?? hit.documentId;
        const existing = people.get(key);
        if (existing) {
          existing.score = Math.max(existing.score, hit.score);
        } else {
          people.set(key, {
            employee_id: facts.employee_id,
            display_name: facts.display_name,
            evidence: [hit.snippet.slice(0, 300)],
            score: hit.score,
          });
        }
      }
      const ranked = [...people.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, parsedBody.limit ?? 5);
      await deps.dbApp.insert(usageLogs).values({
        machineId,
        eventType: "kb_who_knows",
        payload: { people: ranked.length },
      });
      return c.json({ people: ranked });
    } catch (e) {
      if (e instanceof KbEngineError) return err(c, 502, "kb_engine_error");
      if (e instanceof KbUnavailableError) return err(c, 503, "kb_unavailable");
      throw e;
    }
  });

  app.post("/v1/kb/skills", auth, async (c) => {
    if (!deps.kb) return err(c, 503, "kb_unavailable");
    const machineId = c.get("machineAuth").machineId;

    let parsedBody: z.infer<typeof searchSchema>;
    try {
      parsedBody = searchSchema.parse(await c.req.json());
    } catch {
      return err(c, 400, "invalid_request");
    }

    try {
      const results = await deps.kb.client.search({
        query: parsedBody.query,
        space: deps.kb.space,
        limit: parsedBody.limit,
        filters: { AND: [{ key: KB_META_DOC_TYPE, value: "skill" }] },
      });
      await deps.dbApp.insert(usageLogs).values({
        machineId,
        eventType: "kb_search",
        payload: { kind: "skills", results: results.length },
      });
      return c.json({
        skills: results.map((r) => ({
          id: r.documentId,
          name: r.documentId.startsWith("skill:")
            ? r.documentId.slice("skill:".length)
            : r.title,
          description: r.snippet.split("\n").slice(0, 3).join(" ").slice(0, 300),
          score: r.score,
          source: "org",
        })),
      });
    } catch (e) {
      if (e instanceof KbEngineError) return err(c, 502, "kb_engine_error");
      if (e instanceof KbUnavailableError) return err(c, 503, "kb_unavailable");
      throw e;
    }
  });

  app.get("/v1/kb/documents/:documentId", auth, async (c) => {
    if (!deps.kb) return err(c, 503, "kb_unavailable");
    const machineId = c.get("machineAuth").machineId;
    const documentId = c.req.param("documentId");

    try {
      const doc = await deps.kb.client.getDocument(documentId, deps.kb.space);
      if (doc === null || doc.metadata[KB_META_SENSITIVE] === true) {
        // Sensitive docs do not confirm their existence to agents.
        return err(c, 404, "not_found");
      }
      await deps.dbApp.insert(usageLogs).values({
        machineId,
        eventType: "kb_read",
        payload: { document_id: documentId },
      });
      return c.json({
        id: doc.documentId,
        title: doc.title,
        content: doc.content.slice(0, deps.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS),
        source: doc.metadata.source ?? null,
        uploaded_by: doc.metadata.uploaded_by ?? null,
      });
    } catch (e) {
      if (e instanceof KbEngineError) return err(c, 502, "kb_engine_error");
      if (e instanceof KbUnavailableError) return err(c, 503, "kb_unavailable");
      throw e;
    }
  });

  return app;
}
