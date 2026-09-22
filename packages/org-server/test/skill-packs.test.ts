import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbPools } from "../src/db/client.ts";
import { closeDbPools } from "../src/db/client.ts";
import { kbDocuments, skillPacks } from "../src/db/schema.ts";
import {
  getSkillPackBytes,
  latestSkillPack,
  parsePackBytes,
  parseSkillMd,
  readTar,
  SkillPackError,
  storeSkillPack,
} from "../src/lib/skill-packs.ts";
import { buildTar, gzip } from "./helpers/tar.ts";
import { setupTestPools } from "./helpers/db.ts";
import { users } from "../src/db/schema.ts";
import { hashPassword } from "../src/lib/password.ts";

let pools: DbPools;

beforeAll(async () => {
  const setup = await setupTestPools();
  pools = setup.pools;
  await pools.owner.delete(skillPacks);
  await pools.owner.delete(kbDocuments);
});

afterAll(async () => {
  if (pools) await closeDbPools(pools);
});

const SKILL_A =
  "---\nname: q3-report-prep\ndescription: Prepare the quarterly Q3 report from the ERP export.\n---\n\nSteps here.\n";
const SKILL_B =
  "---\nname: vpn-diagnostics\ndescription: Diagnose VPN tunnel problems.\n---\n\nDiagnostics steps.\n";

describe("pack parsing", () => {
  test("readTar extracts files from ustar bytes", () => {
    const tar = buildTar([
      { name: "pack/q3-report-prep/SKILL.md", content: SKILL_A },
      { name: "pack/vpn-diagnostics/SKILL.md", content: SKILL_B },
    ]);
    const files = readTar(tar);
    expect(files.length).toBe(2);
    expect(files[0]!.name).toBe("pack/q3-report-prep/SKILL.md");
    expect(files[0]!.content).toBe(SKILL_A);
  });

  test("parseSkillMd enforces name + description", () => {
    expect(parseSkillMd(SKILL_A)?.name).toBe("q3-report-prep");
    expect(parseSkillMd("---\nname: broken\n---\n\nno description")).toBeNull();
    expect(parseSkillMd("no frontmatter at all")).toBeNull();
    expect(
      parseSkillMd("---\nname: BAD NAME\ndescription: x\n---\nbody"),
    ).toBeNull();
  });

  test("parsePackBytes accepts gzipped and plain tars", async () => {
    const tar = buildTar([
      { name: "q3-report-prep/SKILL.md", content: SKILL_A },
      { name: "vpn-diagnostics/SKILL.md", content: SKILL_B },
    ]);
    const zipped = await gzip(tar);
    const fromGzip = await parsePackBytes(zipped);
    expect(fromGzip.map((s) => s.name).sort()).toEqual([
      "q3-report-prep",
      "vpn-diagnostics",
    ]);
    const fromPlain = await parsePackBytes(tar);
    expect(fromPlain.length).toBe(2);
  });

  test("parsePackBytes rejects packs without a valid SKILL.md", async () => {
    const bad = buildTar([
      { name: "broken/SKILL.md", content: "no frontmatter" },
    ]);
    expect(parsePackBytes(bad)).rejects.toBeInstanceOf(SkillPackError);
    const empty = buildTar([{ name: "README.md", content: "not a skill" }]);
    expect(parsePackBytes(empty)).rejects.toBeInstanceOf(SkillPackError);
    expect(parsePackBytes(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      SkillPackError,
    );
  });
});

describe("pack storage", () => {
  test("storeSkillPack bumps versions and keeps one rollback generation", async () => {
    const passwordHash = await hashPassword("admin-pass-123");
    const [admin] = await pools.owner
      .insert(users)
      .values({
        employeeId: `EMP-PACK-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Pack Admin",
        role: "admin",
        status: "active",
        passwordHash,
      })
      .returning();

    const bytes1 = buildTar([{ name: "q3-report-prep/SKILL.md", content: SKILL_A }]);
    const first = await storeSkillPack({
      db: pools.owner,
      bytes: bytes1,
      uploadedBy: admin!.id,
      skills: await parsePackBytes(bytes1),
    });
    expect(first.version).toBe(1);

    const bytes2 = buildTar([
      { name: "q3-report-prep/SKILL.md", content: SKILL_A },
      { name: "vpn-diagnostics/SKILL.md", content: SKILL_B },
    ]);
    const second = await storeSkillPack({
      db: pools.owner,
      bytes: bytes2,
      uploadedBy: admin!.id,
      skills: await parsePackBytes(bytes2),
    });
    expect(second.version).toBe(2);
    expect(second.skillCount).toBe(2);

    // Version 1 stays as the single rollback generation.
    expect(await getSkillPackBytes(pools.owner, 1)).not.toBeNull();

    const bytes3 = buildTar([{ name: "vpn-diagnostics/SKILL.md", content: SKILL_B }]);
    const third = await storeSkillPack({
      db: pools.owner,
      bytes: bytes3,
      uploadedBy: admin!.id,
      skills: await parsePackBytes(bytes3),
    });
    expect(third.version).toBe(3);
    // Only one rollback generation: v1 is gone, v2 stays.
    expect(await getSkillPackBytes(pools.owner, 1)).toBeNull();
    expect(await getSkillPackBytes(pools.owner, 2)).not.toBeNull();

    const latest = await latestSkillPack(pools.owner);
    expect(latest?.version).toBe(3);
    expect(latest?.sha256).toBe(third.sha256);

    const pulled = await getSkillPackBytes(pools.owner, 3);
    expect(new TextDecoder().decode(pulled!.content)).toEqual(
      new TextDecoder().decode(bytes3),
    );

    await pools.owner.delete(skillPacks).where(eq(skillPacks.version, 3));
    await pools.owner.delete(skillPacks).where(eq(skillPacks.version, 2));
  });
});
