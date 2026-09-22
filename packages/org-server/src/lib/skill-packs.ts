import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { skillPacks, users } from "../db/schema.ts";
import type { KbIngestDeps } from "./kb-ingest.ts";
import { ingestDocument } from "./kb-ingest.ts";

export const SKILL_PACK_MAX_BYTES = 10 * 1024 * 1024;

export class SkillPackError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SkillPackError";
    this.status = status;
  }
}

export type PackSkill = {
  name: string;
  description: string;
  body: string;
};

/** Decompress gzip bytes via the runtime's native DecompressionStream. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Minimal tar reader for ustar archives (what `tar -czf` produces): 512-byte
 * headers, name at 0, size at 124 (octal), typeflag at 156, data padded to
 * 512-byte blocks. Long names via the "prefix" field at 345 are handled;
 * GNU longname entries fall back to skipping the file.
 */
export function readTar(bytes: Uint8Array): Array<{ name: string; content: string }> {
  const files: Array<{ name: string; content: string }> = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const sizeField = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8);
    const typeflag = String.fromCharCode(header[156] ?? 48);
    if (!Number.isFinite(size)) {
      throw new SkillPackError(400, "corrupt pack archive");
    }
    const dataStart = offset + 512;
    if (name.length === 0) break;
    if (typeflag === "0" || typeflag === "\0") {
      const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
      if (name !== "" && !name.startsWith("./PaxHeaders")) {
        files.push({
          name: fullName,
          content: decoder.decode(bytes.subarray(dataStart, dataStart + size)),
        });
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Parse a SKILL.md: `---` frontmatter with name + description, then body. */
export function parseSkillMd(content: string): PackSkill | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatter, body] = match;
  const name = frontmatter!.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter!.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return null;
  return { name, description, body: body!.trim() };
}

/**
 * Validate an uploaded pack: gunzip, read tar, and require at least one
 * directory carrying a valid SKILL.md. Every invalid SKILL.md rejects the
 * pack - a broken skill must not land on agents.
 */
export async function parsePackBytes(bytes: Uint8Array): Promise<PackSkill[]> {
  if (bytes.length > SKILL_PACK_MAX_BYTES) {
    throw new SkillPackError(413, "pack exceeds the 10 MiB limit");
  }
  let tarBytes: Uint8Array;
  try {
    // Detect a plain tar (POSIX ustar magic "ustar" at offset 257) so tests
    // can feed tars directly; everything else is treated as gzip.
    const magic = new TextDecoder().decode(bytes.subarray(257, 262));
    tarBytes = magic === "ustar" ? bytes : await gunzip(bytes);
  } catch (err) {
    if (err instanceof SkillPackError) throw err;
    throw new SkillPackError(400, "pack is not a valid tar.gz archive");
  }
  const skills = new Map<string, PackSkill>();
  for (const file of readTar(tarBytes)) {
    if (!file.name.endsWith("SKILL.md") || file.name.includes("/.")) continue;
    const skill = parseSkillMd(file.content);
    if (!skill) {
      throw new SkillPackError(400, `invalid SKILL.md frontmatter in ${file.name}`);
    }
    if (skills.has(skill.name)) {
      throw new SkillPackError(400, `duplicate skill name ${skill.name}`);
    }
    skills.set(skill.name, skill);
  }
  if (skills.size === 0) {
    throw new SkillPackError(400, "pack contains no skills (no valid SKILL.md)");
  }
  return [...skills.values()];
}

export type StoredPack = {
  version: number;
  sha256: string;
  skillCount: number;
};

export async function latestSkillPack(
  db: Db,
): Promise<{ version: number; sha256: string } | null> {
  const [row] = await db
    .select({ version: skillPacks.version, sha256: skillPacks.sha256 })
    .from(skillPacks)
    .orderBy(desc(skillPacks.version))
    .limit(1);
  return row ?? null;
}

export async function storeSkillPack(
  input: {
    db: Db;
    bytes: Uint8Array;
    uploadedBy: string;
    skills: PackSkill[];
  },
): Promise<StoredPack> {
  const sha256 = new Bun.CryptoHasher("sha256").update(input.bytes).digest("hex");
  const [{ nextVersion }] = await input.db
    .select({ nextVersion: sql<number>`coalesce(max(${skillPacks.version}), 0)::int + 1` })
    .from(skillPacks);
  await input.db.insert(skillPacks).values({
    version: nextVersion!,
    sha256,
    sizeBytes: input.bytes.byteLength,
    skillCount: input.skills.length,
    content: Buffer.from(input.bytes),
    uploadedBy: input.uploadedBy,
  });
  // Keep one generation for rollback: delete versions older than the
  // previous one.
  await input.db
    .delete(skillPacks)
    .where(sql`${skillPacks.version} < ${nextVersion! - 1}`);
  return { version: nextVersion!, sha256, skillCount: input.skills.length };
}

export async function getSkillPackBytes(
  db: Db,
  version?: number,
): Promise<{ content: Buffer; version: number; sha256: string } | null> {
  const rows = version
    ? await db
        .select()
        .from(skillPacks)
        .where(eq(skillPacks.version, version))
        .limit(1)
    : await db.select().from(skillPacks).orderBy(desc(skillPacks.version)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return { content: row.content, version: row.version, sha256: row.sha256 };
}

export async function listPackVersions(db: Db) {
  return db
    .select({
      version: skillPacks.version,
      sha256: skillPacks.sha256,
      sizeBytes: skillPacks.sizeBytes,
      skillCount: skillPacks.skillCount,
      createdAt: skillPacks.createdAt,
      uploadedBy: users.employeeId,
    })
    .from(skillPacks)
    .innerJoin(users, eq(users.id, skillPacks.uploadedBy))
    .orderBy(desc(skillPacks.version));
}

/** Index the pack's skills into the KB so search_skills can find them. */
export async function ingestPackSkills(
  kb: KbIngestDeps,
  skills: PackSkill[],
): Promise<void> {
  for (const skill of skills) {
    await ingestDocument(kb, {
      title: skill.name,
      content: [
        `# Skill: ${skill.name}`,
        "",
        skill.description,
        "",
        skill.body,
      ].join("\n"),
      source: "skill_pack",
      docType: "skill",
      customId: `skill:${skill.name}`,
    });
  }
}
