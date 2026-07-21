import { describe, expect, test } from "bun:test";
import {
  generateJwtKeyEntry,
  jwksDocument,
  loadKeyring,
  signJwt,
  verifyJwt,
} from "../src/lib/jwt.ts";

describe("jwt keyring", () => {
  test("sign/verify with kid", async () => {
    const keys = [generateJwtKeyEntry("k1"), generateJwtKeyEntry("k2")];
    const keyring = await loadKeyring(JSON.stringify(keys));
    expect(keyring.activeKid).toBe("k1");

    const { token, kid, expiresAt } = await signJwt(
      keyring,
      { sub: "11111111-1111-4111-8111-111111111111" },
      { expiresIn: "30d" },
    );
    expect(kid).toBe("k1");
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const verified = await verifyJwt(keyring, token);
    expect(verified.kid).toBe("k1");
    expect(verified.payload.sub).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  test("multi-key JWKS and rotation verify", async () => {
    const keys = [generateJwtKeyEntry("old"), generateJwtKeyEntry("new")];
    const keyring = await loadKeyring(JSON.stringify(keys));
    const jwks = jwksDocument(keyring);
    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual(["new", "old"]);

    const oldTok = await signJwt(
      keyring,
      { sub: "22222222-2222-4222-8222-222222222222" },
      { kid: "old", expiresIn: "1h" },
    );
    const newTok = await signJwt(
      keyring,
      { sub: "33333333-3333-4333-8333-333333333333" },
      { kid: "new", expiresIn: "1h" },
    );

    expect((await verifyJwt(keyring, oldTok.token)).kid).toBe("old");
    expect((await verifyJwt(keyring, newTok.token)).kid).toBe("new");
  });

  test("unknown kid rejected", async () => {
    const keyring = await loadKeyring(
      JSON.stringify([generateJwtKeyEntry("only")]),
    );
    const other = await loadKeyring(
      JSON.stringify([generateJwtKeyEntry("other")]),
    );
    const { token } = await signJwt(other, { sub: "x" }, { expiresIn: 60 });
    await expect(verifyJwt(keyring, token)).rejects.toThrow(/unknown kid/);
  });

  test("expired token rejected", async () => {
    const keyring = await loadKeyring(
      JSON.stringify([generateJwtKeyEntry("k")]),
    );
    const { token } = await signJwt(keyring, { sub: "x" }, { expiresIn: 1 });
    await Bun.sleep(1200);
    await expect(verifyJwt(keyring, token)).rejects.toThrow();
  });
});
