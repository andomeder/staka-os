import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySecretFiles, resolveSecret } from "../src/lib/secrets.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "staka-secret-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("resolveSecret", () => {
  test("reads plain env", () => {
    expect(resolveSecret({ DATABASE_URL: "postgres://x" }, "DATABASE_URL")).toBe(
      "postgres://x",
    );
  });

  test("file wins over plain env and trims trailing newline", () => {
    const path = tempFile("db", "postgres://from-file\n");
    expect(
      resolveSecret(
        {
          DATABASE_URL: "postgres://plain",
          DATABASE_URL_FILE: path,
        },
        "DATABASE_URL",
      ),
    ).toBe("postgres://from-file");
  });

  test("missing file hard-fails", () => {
    expect(() =>
      resolveSecret(
        { DATABASE_URL_FILE: "/no/such/staka-secret-file" },
        "DATABASE_URL",
      ),
    ).toThrow(/failed to read DATABASE_URL_FILE/);
  });

  test("empty plain is undefined", () => {
    expect(resolveSecret({ DATABASE_URL: "" }, "DATABASE_URL")).toBeUndefined();
  });
});

describe("applySecretFiles", () => {
  test("resolves listed secrets and strips _FILE keys", () => {
    const path = tempFile("jwt", '[{"kid":"k1"}]\n');
    const out = applySecretFiles(
      {
        STAKA_JWT_KEYS_FILE: path,
        STAKA_JWT_KEYS: "ignored",
        OTHER: "keep",
      },
      ["STAKA_JWT_KEYS"],
    );
    expect(out.STAKA_JWT_KEYS).toBe('[{"kid":"k1"}]');
    expect(out.STAKA_JWT_KEYS_FILE).toBeUndefined();
    expect(out.OTHER).toBe("keep");
  });
});
