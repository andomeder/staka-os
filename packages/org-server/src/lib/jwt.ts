import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import {
  exportJWK,
  importPKCS8,
  importSPKI,
  SignJWT,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { z } from "zod";

const JwtKeyEntry = z
  .object({
    kid: z.string().min(1),
    private_key_base64: z.string().min(1),
  })
  .strict();

const JwtKeysSchema = z.array(JwtKeyEntry).min(1);

type JoseKey = Awaited<ReturnType<typeof importPKCS8>>;

type RingEntry = {
  privateKey: JoseKey;
  publicKey: JoseKey;
  publicJwk: Record<string, unknown>;
};

export type JwtKeyring = {
  keys: Map<string, RingEntry>;
  activeKid: string;
};

function decodePrivateKeyPem(privateKeyBase64: string): string {
  const raw = Buffer.from(privateKeyBase64, "base64").toString("utf8").trim();
  if (raw.includes("BEGIN")) return raw;
  throw new Error("STAKA_JWT_KEYS private_key_base64 must be base64-encoded PEM");
}

function publicPemFromPrivatePem(privatePem: string): string {
  const priv = createPrivateKey(privatePem);
  // Node accepts KeyObject; @types/bun narrows createPublicKey too tightly.
  const pub = createPublicKey(priv as unknown as string);
  return pub.export({ type: "spki", format: "pem" }).toString();
}

export async function loadKeyring(raw: string): Promise<JwtKeyring> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("STAKA_JWT_KEYS must be valid JSON");
  }
  const entries = JwtKeysSchema.parse(parsed);
  const keys = new Map<string, RingEntry>();

  for (const entry of entries) {
    if (keys.has(entry.kid)) {
      throw new Error(`duplicate JWT kid: ${entry.kid}`);
    }
    const pem = decodePrivateKeyPem(entry.private_key_base64);
    const privateKey = await importPKCS8(pem, "EdDSA");
    const publicPem = publicPemFromPrivatePem(pem);
    const publicKey = await importSPKI(publicPem, "EdDSA");
    const jwk = await exportJWK(publicKey);
    keys.set(entry.kid, {
      privateKey,
      publicKey,
      publicJwk: {
        ...jwk,
        kid: entry.kid,
        use: "sig",
        alg: "EdDSA",
      },
    });
  }

  return {
    keys,
    activeKid: entries[0]!.kid,
  };
}

export function jwksDocument(keyring: JwtKeyring): {
  keys: Record<string, unknown>[];
} {
  return {
    keys: [...keyring.keys.values()].map((k) => k.publicJwk),
  };
}

function resolveExpiry(expiresIn: string | number, now: number): number {
  if (typeof expiresIn === "number") return now + expiresIn;
  if (expiresIn.endsWith("d")) {
    return now + Number(expiresIn.slice(0, -1)) * 86_400;
  }
  if (expiresIn.endsWith("h")) {
    return now + Number(expiresIn.slice(0, -1)) * 3_600;
  }
  if (expiresIn.endsWith("m")) {
    return now + Number(expiresIn.slice(0, -1)) * 60;
  }
  if (expiresIn.endsWith("s")) {
    return now + Number(expiresIn.slice(0, -1));
  }
  throw new Error(`unsupported expiresIn: ${expiresIn}`);
}

export async function signJwt(
  keyring: JwtKeyring,
  claims: JWTPayload,
  opts: { expiresIn: string | number; kid?: string } = { expiresIn: "30d" },
): Promise<{ token: string; kid: string; expiresAt: Date }> {
  const kid = opts.kid ?? keyring.activeKid;
  const entry = keyring.keys.get(kid);
  if (!entry) throw new Error(`unknown kid: ${kid}`);

  const now = Math.floor(Date.now() / 1000);
  const exp = resolveExpiry(opts.expiresIn, now);

  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(entry.privateKey);

  return { token, kid, expiresAt: new Date(exp * 1000) };
}

export async function verifyJwt(
  keyring: JwtKeyring,
  token: string,
): Promise<{ payload: JWTPayload; kid: string }> {
  const headerPart = token.split(".")[0];
  if (!headerPart) throw new Error("invalid token");
  const header = JSON.parse(
    Buffer.from(headerPart, "base64url").toString("utf8"),
  ) as { kid?: string };
  const kid = header.kid;
  if (!kid) throw new Error("missing kid");
  const entry = keyring.keys.get(kid);
  if (!entry) throw new Error("unknown kid");

  const { payload } = await jwtVerify(token, entry.publicKey, {
    algorithms: ["EdDSA"],
  });
  return { payload, kid };
}

export function generateJwtKeyEntry(kid: string): {
  kid: string;
  private_key_base64: string;
} {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    kid,
    private_key_base64: Buffer.from(pem, "utf8").toString("base64"),
  };
}
