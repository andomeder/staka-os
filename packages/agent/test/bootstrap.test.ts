import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { readTokenFile, readOrgUrl } from "../src/bootstrap.ts";

describe("readTokenFile", () => {
  let dir: string;

  test("reads and trims token", async () => {
    dir = await mkdtemp(join(tmpdir(), "staka-test-"));
    const path = join(dir, "machine.token");
    await writeFile(path, "  my-jwt-token  \n");
    const token = await readTokenFile(path);
    expect(token).toBe("my-jwt-token");
    await rm(dir, { recursive: true });
  });

  test("throws on missing file", async () => {
    await expect(readTokenFile("/nonexistent/path/token")).rejects.toThrow();
  });

  test("throws on empty file", async () => {
    dir = await mkdtemp(join(tmpdir(), "staka-test-"));
    const path = join(dir, "empty.token");
    await writeFile(path, "   \n  ");
    await expect(readTokenFile(path)).rejects.toThrow("empty");
    await rm(dir, { recursive: true });
  });
});

describe("readOrgUrl", () => {
  let dir: string;

  test("reads and strips trailing slashes", async () => {
    dir = await mkdtemp(join(tmpdir(), "staka-test-"));
    const path = join(dir, "org-url");
    await writeFile(path, "https://org.example.com///\n");
    const url = await readOrgUrl(path);
    expect(url).toBe("https://org.example.com");
    await rm(dir, { recursive: true });
  });

  test("throws on missing file", async () => {
    await expect(readOrgUrl("/nonexistent/org-url")).rejects.toThrow();
  });

  test("throws on empty file", async () => {
    dir = await mkdtemp(join(tmpdir(), "staka-test-"));
    const path = join(dir, "empty-url");
    await writeFile(path, "  \n");
    await expect(readOrgUrl(path)).rejects.toThrow("empty");
    await rm(dir, { recursive: true });
  });
});

describe("verifyMachineToken", () => {
  test("verifies valid machine JWT against JWKS", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-kid-1";
    publicJwk.alg = "EdDSA";
    publicJwk.use = "sig";

    const jwks = { keys: [publicJwk] };

    const jwt = await new SignJWT({ sub: "machine-uuid-123", typ: "machine" })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-kid-1" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(privateKey);

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/.well-known/jwks.json") {
          return Response.json(jwks);
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const { verifyMachineToken } = await import("../src/bootstrap.ts");
      const orgUrl = `http://127.0.0.1:${server.port}`;
      const result = await verifyMachineToken(jwt, orgUrl);
      expect(result.machineId).toBe("machine-uuid-123");
    } finally {
      server.stop(true);
    }
  });

  test("rejects JWT with wrong typ", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-kid-2";
    publicJwk.alg = "EdDSA";
    publicJwk.use = "sig";

    const jwks = { keys: [publicJwk] };

    const jwt = await new SignJWT({ sub: "admin-uuid", typ: "admin" })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-kid-2" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/.well-known/jwks.json") {
          return Response.json(jwks);
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const { verifyMachineToken } = await import("../src/bootstrap.ts");
      const orgUrl = `http://127.0.0.1:${server.port}`;
      await expect(verifyMachineToken(jwt, orgUrl)).rejects.toThrow("typ");
    } finally {
      server.stop(true);
    }
  });
});
