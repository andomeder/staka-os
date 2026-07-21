import { createHash } from "node:crypto";
import type { HwidComponents } from "@staka/protocol";

export type CanonicalHwid = {
  hardwareId: string;
  hwidHash: string;
  hwidDisplay: string;
  components: HwidComponents;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function last4(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9]/g, "");
  if (clean.length === 0) return "????";
  return clean.slice(-4).toUpperCase();
}

/** Canonicalize DMI components into stable hardware_id / hwid_hash / display. */
export function canonicalizeHwid(input: HwidComponents): CanonicalHwid {
  const productUuid = input.product_uuid.trim();
  if (!productUuid) {
    throw new Error("product_uuid is required");
  }

  const components: HwidComponents = {
    product_uuid: productUuid,
    board_serial: input.board_serial.trim(),
    product_name: input.product_name.trim() || "unknown",
    cpu_id: input.cpu_id.trim(),
  };

  const hardwareId = sha256Hex(components.product_uuid);
  const hwidHash = sha256Hex(
    `${components.product_uuid}|${components.board_serial}|${components.cpu_id}`,
  );
  const hwidDisplay = `${components.product_name}-***-${last4(components.product_uuid)}`;

  return { hardwareId, hwidHash, hwidDisplay, components };
}

export function verifyEnrollHwid(input: {
  hardware_id: string;
  hwid_hash: string;
  hwid_components: HwidComponents;
}): CanonicalHwid {
  const canonical = canonicalizeHwid(input.hwid_components);
  if (
    input.hardware_id !== canonical.hardwareId ||
    input.hwid_hash !== canonical.hwidHash
  ) {
    throw new Error("hwid mismatch");
  }
  return canonical;
}
