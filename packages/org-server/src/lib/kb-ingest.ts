import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { kbDocuments, users } from "../db/schema.ts";
import {
  KB_META_DOC_TYPE,
  KB_META_SENSITIVE,
  KbEngineClient,
  KbEngineError,
  KbUnavailableError,
} from "./kb.ts";

export const KB_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** MIME types / extensions accepted for dashboard uploads. */
const ALLOWED_EXTENSIONS = new Map<string, { mime: string; docType: string }>([
  ["md", { mime: "text/markdown", docType: "document" }],
  ["txt", { mime: "text/plain", docType: "document" }],
  ["pdf", { mime: "application/pdf", docType: "document" }],
]);

export class KbIngestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "KbIngestError";
    this.status = status;
  }
}

export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return base.length > 0 ? base : "Untitled document";
}

export function detectUpload(filename: string): {
  mime: string;
  docType: string;
} {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const allowed = ALLOWED_EXTENSIONS.get(ext);
  if (!allowed) {
    throw new KbIngestError(400, "unsupported file type (md, txt, pdf only)");
  }
  return allowed;
}

export type KbIngestDeps = {
  db: Db;
  client: KbEngineClient;
  space: string;
  /** Org id recorded in engine metadata and checked on retrieval. */
  orgId: string;
};

export type IngestDocumentInput = {
  title: string;
  filename?: string;
  /** Text content for md/txt uploads. */
  content?: string;
  /** Raw bytes for file uploads (PDF). */
  bytes?: Uint8Array;
  mime?: string;
  source: "upload" | "directory" | "skill_pack";
  docType: string;
  sensitive?: boolean;
  uploadedBy?: string;
  /** Stable id; defaults to doc:<uuid> for uploads. */
  customId?: string;
};

export async function ingestDocument(
  deps: KbIngestDeps,
  input: IngestDocumentInput,
): Promise<{ customId: string; engineId: string }> {
  const customId = input.customId ?? `doc:${crypto.randomUUID()}`;
  const metadata: Record<string, string | boolean> = {
    org_id: deps.orgId,
    source: input.source,
    [KB_META_DOC_TYPE]: input.docType,
  };
  if (input.uploadedBy) metadata.uploaded_by = input.uploadedBy;
  if (input.sensitive === true) metadata[KB_META_SENSITIVE] = true;

  let engineId: string;
  let sizeBytes: number;
  if (input.bytes !== undefined) {
    if (input.bytes.byteLength > KB_MAX_UPLOAD_BYTES) {
      throw new KbIngestError(413, "document exceeds the 10 MiB limit");
    }
    if (!input.mime) throw new KbIngestError(400, "missing content type");
    if (input.filename) {
      const allowed = detectUpload(input.filename);
      if (allowed.mime !== input.mime) {
        throw new KbIngestError(400, "unsupported file type (md, txt, pdf only)");
      }
    }
    ({ engineId } = await deps.client.addFile({
      filename: input.filename ?? "document",
      contentType: input.mime,
      bytes: input.bytes,
      customId,
      space: deps.space,
      metadata,
    }).catch(mapEngineError));
    sizeBytes = input.bytes.byteLength;
  } else {
    if (input.content === undefined) {
      throw new KbIngestError(400, "missing document content");
    }
    sizeBytes = Buffer.byteLength(input.content, "utf8");
    if (sizeBytes > KB_MAX_UPLOAD_BYTES) {
      throw new KbIngestError(413, "document exceeds the 10 MiB limit");
    }
    ({ engineId } = await deps.client.addDocument({
      content: input.content,
      customId,
      space: deps.space,
      metadata,
    }).catch(mapEngineError));
  }

  // Upsert the registry row so dashboard listing and engine ids survive
  // engine-side regeneration.
  await deps.db
    .insert(kbDocuments)
    .values({
      customId,
      title: input.title,
      source: input.source,
      docType: input.docType,
      sensitive: input.sensitive === true,
      sizeBytes,
      uploadedBy: input.uploadedBy,
      engineId,
    })
    .onConflictDoUpdate({
      target: kbDocuments.customId,
      set: {
        title: input.title,
        docType: input.docType,
        sensitive: input.sensitive === true,
        sizeBytes,
        engineId,
        deletedAt: null,
      },
    });

  return { customId, engineId };
}

export async function deleteDocument(
  deps: KbIngestDeps,
  customId: string,
): Promise<boolean> {
  const [row] = await deps.db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.customId, customId), isNull(kbDocuments.deletedAt)))
    .limit(1);
  if (!row) return false;
  await deps.client.deleteDocument(customId, deps.space);
  await deps.db
    .update(kbDocuments)
    .set({ deletedAt: new Date() })
    .where(eq(kbDocuments.id, row.id));
  return true;
}

export type KbCorpusStats = {
  documents: number;
  sensitive: number;
  totalBytes: number;
  bySource: Record<string, number>;
};

export async function corpusStats(deps: KbIngestDeps): Promise<KbCorpusStats> {
  const rows = await deps.db
    .select({
      source: kbDocuments.source,
      count: sql<number>`count(*)::int`,
      sensitive: sql<number>`count(*) filter (where ${kbDocuments.sensitive})::int`,
      bytes: sql<number>`coalesce(sum(${kbDocuments.sizeBytes}), 0)::bigint`,
    })
    .from(kbDocuments)
    .where(isNull(kbDocuments.deletedAt))
    .groupBy(kbDocuments.source);
  const stats: KbCorpusStats = {
    documents: 0,
    sensitive: 0,
    totalBytes: 0,
    bySource: {},
  };
  for (const row of rows) {
    stats.documents += row.count;
    stats.sensitive += row.sensitive;
    stats.totalBytes += Number(row.bytes);
    stats.bySource[row.source] = row.count;
  }
  return stats;
}

export async function listDocuments(
  deps: KbIngestDeps,
  limit = 100,
): Promise<Array<typeof kbDocuments.$inferSelect>> {
  return deps.db
    .select()
    .from(kbDocuments)
    .where(isNull(kbDocuments.deletedAt))
    .orderBy(sql`${kbDocuments.createdAt} desc`)
    .limit(limit);
}

/**
 * Directory profile sync: every active user gets a profile document in the
 * engine so `who_knows` can rank people by knowledge evidence.
 */
export function profileDocument(user: {
  employeeId: string;
  displayName: string;
  role: string;
  email: string | null;
}): string {
  const lines = [
    `# ${user.displayName}`,
    "",
    `- employee_id: ${user.employeeId}`,
    `- role: ${user.role}`,
  ];
  if (user.email) lines.push(`- email: ${user.email}`);
  lines.push("", `Staka directory profile for ${user.displayName} (${user.employeeId}).`);
  return lines.join("\n");
}

export async function syncUserProfile(
  deps: KbIngestDeps,
  user: { employeeId: string; displayName: string; role: string; email: string | null },
): Promise<void> {
  await ingestDocument(deps, {
    title: user.displayName,
    content: profileDocument(user),
    source: "directory",
    docType: "profile",
    customId: `profile:${user.employeeId}`,
  });
}

export async function syncDirectoryProfiles(deps: KbIngestDeps): Promise<number> {
  const rows = await deps.db
    .select({
      employeeId: users.employeeId,
      displayName: users.displayName,
      role: users.role,
      email: users.email,
    })
    .from(users)
    .where(and(eq(users.status, "active"), isNull(users.deletedAt)));
  for (const user of rows) {
    await syncUserProfile(deps, user);
  }
  return rows.length;
}

function mapEngineError(err: unknown): never {
  if (err instanceof KbUnavailableError) {
    throw new KbIngestError(503, "knowledge base engine unavailable");
  }
  if (err instanceof KbEngineError) {
    throw new KbIngestError(502, "knowledge base engine rejected the document");
  }
  throw err as Error;
}
