import { KB_META_DOC_TYPE } from "../../src/lib/kb.ts";

export type StoredDoc = {
  space: string;
  content: string;
  metadata: Record<string, unknown>;
};

export type FakeEngine = {
  url: string;
  docs: Map<string, StoredDoc>;
  calls: Array<{ method: string; path: string; body: unknown }>;
  searches: Array<{ q: string; containerTag: string }>;
  setFailure: (status: number | null) => void;
  stop: () => void;
};

/**
 * Deterministic stand-in for supermemory-server. Honors the same contract
 * that matters to the org server: space-scoped search (containerTag is a
 * hard boundary), metadata round-trip, id-keyed document fetch that is
 * store-global (the client must enforce the org boundary itself), and
 * queue-then-done ingestion.
 */
export function startFakeEngine(): FakeEngine {
  const docs = new Map<string, StoredDoc>();
  const calls: FakeEngine["calls"] = [];
  const searches: FakeEngine["searches"] = [];
  let failWith: number | null = null;

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      calls.push({ method: req.method, path, body: null });

      if (failWith !== null) {
        return Response.json({ error: "injected" }, { status: failWith });
      }

      const jsonBody = async () =>
        req.method === "POST" || req.method === "DELETE"
          ? req.json().catch(() => undefined)
          : undefined;

      if (req.method === "POST" && path === "/v3/documents") {
        const b = (await jsonBody()) as {
          content: string;
          customId: string;
          containerTag: string;
          metadata?: Record<string, unknown>;
        };
        docs.set(b.customId, {
          space: b.containerTag,
          content: b.content,
          metadata: b.metadata ?? {},
        });
        return Response.json({ id: `eng-${b.customId}`, status: "queued" });
      }

      if (req.method === "POST" && path === "/v3/documents/file") {
        const form = await req.formData().catch(() => undefined);
        const file = form?.get("file");
        const customId = form?.get("customId");
        const containerTag = form?.get("containerTag");
        const metaRaw = form?.get("metadata");
        if (
          !(file instanceof File) ||
          typeof customId !== "string" ||
          typeof containerTag !== "string"
        ) {
          return Response.json({ error: "bad multipart" }, { status: 400 });
        }
        docs.set(customId, {
          space: containerTag,
          content: `# ${file.name}\n\n${file.size} bytes`,
          metadata:
            typeof metaRaw === "string" ? JSON.parse(metaRaw) : {},
        });
        return Response.json({ id: `eng-${customId}`, status: "queued" });
      }

      if (req.method === "POST" && path === "/v4/search") {
        const b = (await jsonBody()) as {
          q: string;
          containerTag: string;
          limit?: number;
          filters?: { AND?: Array<{ key: string; value: string }> };
        };
        searches.push({ q: b.q, containerTag: b.containerTag });
        const wantType = b.filters?.AND?.find((f) => f.key === KB_META_DOC_TYPE)?.value;
        const results = [...docs.entries()]
          .filter(([, d]) => d.space === b.containerTag)
          .filter(([, d]) => d.content.toLowerCase().includes(b.q.toLowerCase().slice(0, 10)))
          .filter(([, d]) => wantType === undefined || d.metadata[KB_META_DOC_TYPE] === wantType)
          .slice(0, b.limit ?? 10)
          .map(([customId, d], i) => ({
            id: `chunk-${i}`,
            chunk: d.content,
            similarity: 0.9 - i * 0.1,
            metadata: d.metadata,
            documents: [
              { id: customId, title: d.content.split("\n")[0], metadata: d.metadata },
            ],
          }));
        return Response.json({ results, timing: 4, total: results.length });
      }

      const docMatch = path.match(/^\/v3\/documents\/([^/]+)$/);
      if (req.method === "GET" && docMatch) {
        const id = decodeURIComponent(docMatch[1]!);
        const doc = docs.get(id);
        if (!doc) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({
          customId: id,
          content: doc.content,
          title: doc.content.split("\n")[0],
          status: "done",
          metadata: doc.metadata,
        });
      }
      if (req.method === "DELETE" && docMatch) {
        const id = decodeURIComponent(docMatch[1]!);
        return Response.json({ deleted: docs.delete(id) ? 1 : 0 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    docs,
    calls,
    searches,
    setFailure: (status: number | null) => {
      failWith = status;
    },
    stop: () => server.stop(true),
  };
}
