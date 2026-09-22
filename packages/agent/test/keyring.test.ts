import { describe, expect, test } from "bun:test";
import { resolveModelApiKey } from "../src/keyring.ts";
import { loadEnv } from "../src/env.ts";

function envWith(apiKey?: string) {
  if (apiKey === undefined) {
    delete process.env.STAKA_MODEL_API_KEY;
  } else {
    process.env.STAKA_MODEL_API_KEY = apiKey;
  }
  return loadEnv();
}

function runner(
  result: { exitCode: number; stdout: string } | ((args: string[]) => { exitCode: number; stdout: string }),
) {
  const fn = typeof result === "function" ? result : () => result;
  return async (args: string[]) => fn(args);
}

describe("resolveModelApiKey", () => {
  test("env wins without calling secret-tool", async () => {
    let called = false;
    const result = await resolveModelApiKey(envWith("sk-env"), runner(() => {
      called = true;
      return { exitCode: 0, stdout: "sk-keyring" };
    }));
    expect(result).toEqual({ key: "sk-env", source: "env" });
    expect(called).toBe(false);
  });

  test("reads the key from the secret service when env is absent", async () => {
    const result = await resolveModelApiKey(
      envWith(undefined),
      runner({ exitCode: 0, stdout: "sk-keyring\n" }),
    );
    expect(result).toEqual({ key: "sk-keyring", source: "keyring" });
  });

  test("looks up the documented staka/model-api-key attributes", async () => {
    let seen: string[] = [];
    await resolveModelApiKey(
      envWith(undefined),
      runner((args) => {
        seen = args;
        return { exitCode: 0, stdout: "" };
      }),
    );
    expect(seen).toEqual(["lookup", "service", "staka", "username", "model-api-key"]);
  });

  test("missing secret resolves to none", async () => {
    const result = await resolveModelApiKey(
      envWith(undefined),
      runner({ exitCode: 1, stdout: "" }),
    );
    expect(result).toEqual({ key: null, source: "none" });
  });

  test("a missing secret-tool binary degrades to none instead of throwing", async () => {
    const run = async () => {
      throw new Error("secret-tool: command not found");
    };
    const result = await resolveModelApiKey(envWith(undefined), run);
    expect(result).toEqual({ key: null, source: "none" });
  });
});
