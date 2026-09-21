import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigResponse } from "@staka/protocol";
import type { Env } from "../env.ts";

export type PackSyncResult = {
  updated: boolean;
  reason:
    | "disabled"
    | "current"
    | "updated"
    | "pull_failed"
    | "hash_mismatch"
    | "invalid_pack";
  skillCount?: number;
  path?: string;
};

type PackState = {
  sha256: string;
  path: string;
};

export const ORG_SKILL_LINK = join(homedir(), ".agents", "skills", "staka");

export type PackSyncOptions = {
  /** Override for tests; defaults to the real org skills symlink. */
  linkPath?: string;
};

/** Minimal ustar reader (mirrors the org server's pack format). */
function readTar(bytes: Uint8Array): Array<{ name: string; content: string }> {
  const files: Array<{ name: string; content: string }> = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const sizeField = decoder
      .decode(header.subarray(124, 136))
      .replace(/\0.*$/, "")
      .trim();
    const size = parseInt(sizeField, 8);
    const typeflag = String.fromCharCode(header[156] ?? 48);
    if (!Number.isFinite(size)) return files;
    const dataStart = offset + 512;
    if (name.length === 0) break;
    if (typeflag === "0" || typeflag === "\0") {
      files.push({
        name: prefix.length > 0 ? `${prefix}/${name}` : name,
        content: decoder.decode(bytes.subarray(dataStart, dataStart + size)),
      });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function parseSkillMd(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const frontmatter = match[1]!;
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return null;
  return { name, description };
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function loadState(stateDir: string): PackState | null {
  try {
    return JSON.parse(
      readFileSync(join(stateDir, "skills-pack", "state.json"), "utf8"),
    ) as PackState;
  } catch {
    return null;
  }
}

function saveState(stateDir: string, state: PackState): void {
  writeFileSync(
    join(stateDir, "skills-pack", "state.json"),
    JSON.stringify(state, null, 2),
  );
}

function retargetSymlink(target: string, linkPath: string): boolean {
  try {
    const parent = join(linkPath, "..");
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    if (lstatExists(linkPath)) {
      try {
        if (
          lstatIsSymlink(linkPath) &&
          realpathSync(linkPath) === realpathSync(target)
        ) {
          return true;
        }
      } catch {
        // broken symlink or unreadable target - replace below
      }
      rmSync(linkPath, { recursive: true, force: true });
    }
    symlinkSync(target, linkPath, "dir");
    return true;
  } catch {
    return false;
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function lstatIsSymlink(path: string): boolean {
  // rmSync handles both cases; this only guards the already-current check.
  try {
    readlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull the org skill pack announced by the config. Hash-pinned: a mismatch
 * between the downloaded bytes and the config hash refuses the swap. The
 * previous pack generation is kept until the new one validates.
 */
export async function syncSkillPack(
  env: Env,
  orgUrl: string,
  token: string,
  config: ConfigResponse,
  doFetch: typeof fetch = fetch,
  opts: PackSyncOptions = {},
): Promise<PackSyncResult> {
  if (
    !config.features.skills_sync ||
    !config.skill_pack_url ||
    !config.skill_pack_hash
  ) {
    return { updated: false, reason: "disabled" };
  }

  const stateDir = env.STAKA_STATE_DIR;
  const state = loadState(stateDir);
  if (state?.sha256 === config.skill_pack_hash) {
    return { updated: false, reason: "current", path: state.path };
  }

  let bytes: Uint8Array;
  try {
    const url = new URL(config.skill_pack_url, orgUrl);
    const res = await doFetch(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { updated: false, reason: "pull_failed" };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { updated: false, reason: "pull_failed" };
  }

  if (sha256Hex(bytes) !== config.skill_pack_hash) {
    return { updated: false, reason: "hash_mismatch" };
  }

  // Unpack to a staging dir first; the old generation survives validation
  // failures.
  const staging = join(stateDir, "skills-pack", "staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  let tarBytes: Uint8Array;
  try {
    tarBytes = await gunzip(bytes);
  } catch {
    return { updated: false, reason: "invalid_pack" };
  }
  let skillCount = 0;
  for (const file of readTar(tarBytes)) {
    if (!file.name.endsWith("SKILL.md")) continue;
    if (!parseSkillMd(file.content)) {
      return { updated: false, reason: "invalid_pack" };
    }
    const outPath = join(staging, file.name);
    mkdirSync(join(outPath, ".."), { recursive: true });
    writeFileSync(outPath, file.content);
    skillCount++;
  }
  if (skillCount === 0) {
    rmSync(staging, { recursive: true, force: true });
    return { updated: false, reason: "invalid_pack" };
  }

  const finalDir = join(stateDir, "skills-pack", sha256Hex(bytes).slice(0, 12));
  rmSync(finalDir, { recursive: true, force: true });
  rmSync(join(stateDir, "skills-pack", "previous"), { recursive: true, force: true });
  if (state && existsSync(state.path)) {
    // keep one generation for rollback
    try {
      mkdirSync(join(stateDir, "skills-pack"), { recursive: true });
      renameOrCopy(state.path, join(stateDir, "skills-pack", "previous"));
    } catch {
      // rollback copy is best-effort
    }
  }
  renameOrCopy(staging, finalDir);
  const linkPath = opts.linkPath ?? ORG_SKILL_LINK;
  const swapped = retargetSymlink(finalDir, linkPath);
  saveState(stateDir, { sha256: config.skill_pack_hash, path: finalDir });
  return {
    updated: swapped,
    reason: swapped ? "updated" : "pull_failed",
    skillCount,
    path: finalDir,
  };
}

function renameOrCopy(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to);
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}
