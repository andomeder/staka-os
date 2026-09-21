import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigResponse } from "@staka/protocol";
import { loadEnv, type Env } from "../src/env.ts";
import { syncSkillPack } from "../src/skills/pack-sync.ts";
import { buildTar, gzip } from "./helpers/tar.ts";

const SKILL_A =
  "---\nname: q3-report-prep\ndescription: Prepare the quarterly Q3 report.\n---\n\nBuild the report.\n";
const SKILL_B =
  "---\nname: vpn-diagnostics\ndescription: Diagnose VPN problems.\n---\n\nDiagnose.\n";

function configWithPack(hash: string | null): ConfigResponse {
  return {
    version: 1,
    org_name: "Test Org",
    features: { skills_sync: true, memory_sync: false },
    model: { provider: null, model_id: null, base_url: null },
    skill_pack_url: hash ? "/v1/skill-packs/pull" : null,
    skill_pack_hash: hash,
  };
}

function startFakeOrg(packBytes: Uint8Array | null) {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      if (!packBytes) return Response.json({ error: "none" }, { status: 404 });
      return new Response(new Uint8Array(packBytes), {
        headers: { "content-type": "application/gzip" },
      });
    },
  });
  return `http://localhost:${server.port}`;
}

const sha = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

describe("syncSkillPack", () => {
  let packV1: Uint8Array, packV2: Uint8Array, packBad: Uint8Array;
  const make = async () => {
    packV1 = await gzip(
      buildTar([{ name: "q3-report-prep/SKILL.md", content: SKILL_A }]),
    );
    packV2 = await gzip(
      buildTar([
        { name: "q3-report-prep/SKILL.md", content: SKILL_A },
        { name: "vpn-diagnostics/SKILL.md", content: SKILL_B },
      ]),
    );
    packBad = await gzip(
      buildTar([{ name: "broken/SKILL.md", content: "no frontmatter" }]),
    );
  };

  async function makeEnv() {
    const dir = await mkdtemp(join(tmpdir(), "staka-pack-"));
    const saved = process.env.STAKA_STATE_DIR;
    process.env.STAKA_STATE_DIR = dir;
    const env = loadEnv();
    const linkPath = join(dir, "home-skills", "staka");
    const cleanup = async () => {
      if (saved === undefined) delete process.env.STAKA_STATE_DIR;
      else process.env.STAKA_STATE_DIR = saved;
      await rm(dir, { recursive: true });
    };
    return { dir, env, linkPath, cleanup };
  }

  test("skips when skills_sync is disabled", async () => {
    const { env, linkPath, cleanup } = await makeEnv();
    try {
      const res = await syncSkillPack(
        env,
        "http://localhost:9",
        "tok",
        { ...configWithPack(null), features: { skills_sync: false, memory_sync: false } },
        fetch,
        { linkPath },
      );
      expect(res).toEqual({ updated: false, reason: "disabled" });
    } finally {
      await cleanup();
    }
  });

  test("pulls, verifies, unpacks, and retargets the symlink", async () => {
    await make();
    const { dir, env, linkPath, cleanup } = await makeEnv();
    try {
      const orgUrl = startFakeOrg(packV1);
      const res = await syncSkillPack(
        env,
        orgUrl,
        "tok",
        configWithPack(sha(packV1)),
        fetch,
        { linkPath },
      );
      expect(res.updated).toBe(true);
      expect(res.skillCount).toBe(1);
      const skill = join(res.path!, "q3-report-prep", "SKILL.md");
      expect(await readFile(skill, "utf8")).toBe(SKILL_A);
      // The org skills symlink points at the unpacked pack.
      expect(await realpath(linkPath)).toBe(await realpath(res.path!));
    } finally {
      await cleanup();
    }
  });

  test("refuses a hash mismatch without swapping", async () => {
    await make();
    const { dir, env, linkPath, cleanup } = await makeEnv();
    try {
      const orgUrl = startFakeOrg(packV2);
      const res = await syncSkillPack(
        env,
        orgUrl,
        "tok",
        configWithPack(sha(packV1)),
        fetch,
        { linkPath },
      );
      expect(res).toEqual({ updated: false, reason: "hash_mismatch" });
      // No symlink was created for the refused pack.
      const parent = join(dir, "home-skills");
      let hasLink = false;
      try {
        await readdir(parent).then((es) => {
          hasLink = es.includes("staka");
        });
      } catch {
        hasLink = false;
      }
      expect(hasLink).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("refuses a pack with invalid frontmatter", async () => {
    await make();
    const { env, linkPath, cleanup } = await makeEnv();
    try {
      const orgUrl = startFakeOrg(packBad);
      const res = await syncSkillPack(
        env,
        orgUrl,
        "tok",
        configWithPack(sha(packBad)),
        fetch,
        { linkPath },
      );
      expect(res).toEqual({ updated: false, reason: "invalid_pack" });
    } finally {
      await cleanup();
    }
  });

  test("a second pull with the same hash is a no-op", async () => {
    await make();
    const { env, linkPath, cleanup } = await makeEnv();
    try {
      const orgUrl = startFakeOrg(packV1);
      const first = await syncSkillPack(
        env,
        orgUrl,
        "tok",
        configWithPack(sha(packV1)),
        fetch,
        { linkPath },
      );
      expect(first.updated).toBe(true);
      const second = await syncSkillPack(
        env,
        orgUrl,
        "tok",
        configWithPack(sha(packV1)),
        fetch,
        { linkPath },
      );
      expect(second).toMatchObject({ updated: false, reason: "current" });
    } finally {
      await cleanup();
    }
  });

  test("upgrading packs swaps the symlink to the new generation", async () => {
    await make();
    const { env, linkPath, cleanup } = await makeEnv();
    try {
      const orgV1 = startFakeOrg(packV1);
      await syncSkillPack(
        env,
        orgV1,
        "tok",
        configWithPack(sha(packV1)),
        fetch,
        { linkPath },
      );

      const orgV2 = startFakeOrg(packV2);
      const res = await syncSkillPack(
        env,
        orgV2,
        "tok",
        configWithPack(sha(packV2)),
        fetch,
        { linkPath },
      );
      expect(res.updated).toBe(true);
      expect(res.skillCount).toBe(2);
      const entries = await readdir(join(env.STAKA_STATE_DIR, "skills-pack"));
      expect(entries).toContain("state.json");
      // v1 generation kept for rollback.
      expect(entries.length).toBeGreaterThanOrEqual(3);
    } finally {
      await cleanup();
    }
  });
});
