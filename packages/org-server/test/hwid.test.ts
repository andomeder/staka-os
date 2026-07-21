import { describe, expect, test } from "bun:test";
import { canonicalizeHwid, verifyEnrollHwid } from "../src/lib/hwid.ts";

describe("hwid", () => {
  const components = {
    product_uuid: "11111111-1111-1111-1111-111111111111",
    board_serial: "SN123",
    product_name: "HP ProBook 440 G3",
    cpu_id: "Intel(R) Core(TM) i5",
  };

  test("canonicalization is stable and deterministic", () => {
    const a = canonicalizeHwid(components);
    const b = canonicalizeHwid({
      ...components,
      product_uuid: ` ${components.product_uuid} `,
      board_serial: " SN123 ",
    });
    expect(a.hardwareId).toBe(b.hardwareId);
    expect(a.hwidHash).toBe(b.hwidHash);
    expect(a.hardwareId).toHaveLength(64);
    expect(a.hwidHash).toHaveLength(64);
    expect(a.hwidDisplay).toContain("ProBook");
    expect(a.hwidDisplay).toContain("1111");
  });

  test("rejects empty product_uuid", () => {
    expect(() =>
      canonicalizeHwid({ ...components, product_uuid: "  " }),
    ).toThrow(/product_uuid/);
  });

  test("hardware_id derives from product_uuid only", () => {
    const a = canonicalizeHwid(components);
    const b = canonicalizeHwid({
      ...components,
      board_serial: "OTHER",
      cpu_id: "OTHER CPU",
    });
    expect(a.hardwareId).toBe(b.hardwareId);
    expect(a.hwidHash).not.toBe(b.hwidHash);
  });

  test("verifyEnrollHwid rejects mismatched hashes", () => {
    const c = canonicalizeHwid(components);
    expect(() =>
      verifyEnrollHwid({
        hardware_id: c.hardwareId,
        hwid_hash: "0".repeat(64),
        hwid_components: components,
      }),
    ).toThrow(/hwid mismatch/);
  });
});
