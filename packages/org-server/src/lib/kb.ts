/**
 * Client for the knowledge base retrieval engine (supermemory-server).
 *
 * The engine is private: it never has a public port and agents never talk
 * to it directly. Every call is bound to a space (one per organisation)
 * that the org server resolves server-side. Client-facing code must never
 * accept a space, container tag, or engine id from request input.
 */

export class KbUnavailableError extends Error {
  readonly code = "kb_unavailable";
  constructor(cause: unknown) {
    super("knowledge base engine unreachable");
    this.name = "KbUnavailableError";
    this.cause = cause;
  }
}

export class KbEngineError extends Error {
  readonly code = "kb_engine_error";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "KbEngineError";
    this.status = status;
  }
}

export type KbMetadata = Record<string, string | number | boolean>;

export type KbSearchResult = {
  /** Engine chunk id. */
  engineId: string;
  /** Caller-supplied document id (customId at ingest). */
  documentId: string;
  title: string | null;
  snippet: string;
  score: number;
  metadata: KbMetadata;
};

export type KbDocument = {
  documentId: string;
  title: string | null;
  content: string;
  status: string;
  metadata: KbMetadata;
};

export type KbEngineDeps = {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
};

/** Metadata key carrying the document type (procedure, profile, skill). */
export const KB_META_DOC_TYPE = "doc_type";
/** Metadata key marking documents excluded from agent retrieval. */
export const KB_META_SENSITIVE = "sensitive";

const SPACE_RE = /^org_[a-z0-9][a-z0-9_-]{0,62}$/;
const CONTENT_TYPE_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

/** Build the space id for an org and enforce its shape. */
export function orgSpace(orgId: string): string {
  const slug = orgId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48);
  const space = `org_${slug || "default"}`;
  if (!SPACE_RE.test(space)) {
    throw new KbEngineError(500, "invalid knowledge base space id");
  }
  return space;
}

type EngineFilter = {
  AND?: Array<{ key: string; value: string; negate?: boolean }>;
  OR?: Array<{ key: string; value: string; negate?: boolean }>;
};

export class KbEngineClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly doFetch: typeof fetch;

  constructor(deps: KbEngineDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, "");
    this.apiKey = deps.apiKey;
    this.doFetch = deps.fetch ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new KbUnavailableError(err);
    }
    if (res.status === 404) return undefined;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status >= 500 || res.status === 429) {
        throw new KbUnavailableError(new Error(`${res.status} ${text.slice(0, 200)}`));
      }
      throw new KbEngineError(res.status, text.slice(0, 300) || `engine returned ${res.status}`);
    }
    const text = await res.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new KbEngineError(502, "engine returned a non-JSON body");
    }
  }

  async addDocument(input: {
    content: string;
    customId: string;
    space: string;
    metadata?: KbMetadata;
  }): Promise<{ engineId: string }> {
    assertSpace(input.space);
    const body = await this.request("POST", "/v3/documents", {
      content: input.content,
      customId: input.customId,
      containerTag: input.space,
      metadata: input.metadata,
    });
    const engineId = (body as { id?: unknown } | undefined)?.id;
    if (typeof engineId !== "string") {
      throw new KbEngineError(502, "engine did not return a document id");
    }
    return { engineId };
  }

  async addFile(input: {
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    customId: string;
    space: string;
    metadata?: KbMetadata;
  }): Promise<{ engineId: string }> {
    assertSpace(input.space);
    if (!CONTENT_TYPE_RE.test(input.contentType)) {
      throw new KbEngineError(400, "invalid content type");
    }
    const form = new FormData();
    form.append("file", new Blob([input.bytes as BlobPart], { type: input.contentType }), input.filename);
    form.append("customId", input.customId);
    form.append("containerTag", input.space);
    if (input.metadata) {
      form.append("metadata", JSON.stringify(input.metadata));
    }
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}/v3/documents/file`, {
        method: "POST",
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new KbUnavailableError(err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status >= 500 || res.status === 429) {
        throw new KbUnavailableError(new Error(`${res.status} ${text.slice(0, 200)}`));
      }
      throw new KbEngineError(res.status, text.slice(0, 300) || `engine returned ${res.status}`);
    }
    const body = (await res.json().catch(() => undefined)) as { id?: unknown } | undefined;
    const engineId = body?.id;
    if (typeof engineId !== "string") {
      throw new KbEngineError(502, "engine did not return a document id");
    }
    return { engineId };
  }

  async search(input: {
    query: string;
    space: string;
    limit?: number;
    filters?: EngineFilter;
  }): Promise<KbSearchResult[]> {
    assertSpace(input.space);
    const query = input.query.trim();
    if (query.length === 0) return [];
    if (query.length > 1000) {
      throw new KbEngineError(400, "query too long");
    }
    const limit = clamp(input.limit ?? 5, 1, 20);
    const body = (await this.request("POST", "/v4/search", {
      q: query,
      containerTag: input.space,
      searchMode: "documents",
      limit,
      ...(input.filters ? { filters: input.filters } : {}),
    })) as
      | {
          results?: Array<{
            id?: string;
            chunk?: string;
            memory?: string;
            similarity?: number;
            metadata?: KbMetadata;
            documents?: Array<{ id?: string; title?: string; metadata?: KbMetadata }>;
          }>;
        }
      | undefined;
    const results = body?.results ?? [];
    return results.map((r) => ({
      engineId: typeof r.id === "string" ? r.id : "",
      documentId: r.documents?.[0]?.id ?? "",
      title: r.documents?.[0]?.title ?? null,
      snippet: (r.chunk ?? r.memory ?? "").slice(0, 1200),
      score: typeof r.similarity === "number" ? r.similarity : 0,
      metadata: r.documents?.[0]?.metadata ?? r.metadata ?? {},
    }));
  }

  async getDocument(customId: string, space: string): Promise<KbDocument | null> {
    assertSpace(space);
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(customId)) {
      throw new KbEngineError(400, "invalid document id");
    }
    const body = (await this.request(
      "GET",
      `/v3/documents/${encodeURIComponent(customId)}`,
    )) as
      | {
          content?: string;
          title?: string;
          status?: string;
          metadata?: KbMetadata;
          customId?: string;
          id?: string;
        }
      | undefined;
    if (body === undefined) return null;
    // The engine's id lookup is store-global, so the space boundary is
    // enforced here: a document whose ingest metadata does not carry this
    // space's org id is treated as not found (fail closed).
    const spaceOrg = space.slice("org_".length);
    if (body.metadata?.org_id !== spaceOrg) return null;
    return {
      documentId: body.customId ?? body.id ?? customId,
      title: body.title ?? null,
      content: body.content ?? "",
      status: body.status ?? "unknown",
      metadata: body.metadata ?? {},
    };
  }

  async deleteDocument(customId: string, space: string): Promise<boolean> {
    assertSpace(space);
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(customId)) {
      throw new KbEngineError(400, "invalid document id");
    }
    // The engine deletes by customId across the whole store, so verify the
    // document belongs to this space first - never delete blind.
    const doc = await this.getDocument(customId, space);
    if (doc === null) return false;
    await this.request("DELETE", `/v3/documents/${encodeURIComponent(customId)}`);
    return true;
  }
}

export type KbConfig = {
  client: KbEngineClient;
  space: string;
};

export function kbConfigFromEnv(env: {  STAKA_KB_ENGINE_URL?: string;
  STAKA_KB_ENGINE_KEY?: string;
  STAKA_KB_SPACE?: string;
}): KbConfig | undefined {
  if (!env.STAKA_KB_ENGINE_URL) return undefined;
  return {
    client: new KbEngineClient({
      baseUrl: env.STAKA_KB_ENGINE_URL,
      apiKey: env.STAKA_KB_ENGINE_KEY,
    }),
    space: orgSpace(env.STAKA_KB_SPACE ?? "default"),
  };
}

function assertSpace(space: string): void {
  if (!SPACE_RE.test(space)) {
    throw new KbEngineError(500, "invalid knowledge base space id");
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
