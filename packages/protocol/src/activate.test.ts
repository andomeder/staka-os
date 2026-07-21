import { describe, expect, test } from "bun:test";
import {
  EnrollRequest,
  Hostname,
  HwidComponents,
  SelfAuthenticateRequest,
} from "./activate.ts";

describe("protocol activate schemas", () => {
  test("accepts valid hostname", () => {
    expect(Hostname.parse("staka-demo-01")).toBe("staka-demo-01");
  });

  test("rejects hostname with script tags", () => {
    expect(() => Hostname.parse("<script>x</script>")).toThrow();
  });

  test("accepts flow A enroll body", () => {
    const body = EnrollRequest.parse({
      enrollment_code: "STAKA-AAAA-BBBB-CCCC-DDDD",
      hardware_id: "a".repeat(64),
      hwid_hash: "b".repeat(64),
      hwid_components: {
        product_uuid: "11111111-1111-1111-1111-111111111111",
        board_serial: "SN",
        product_name: "HP ProBook 440 G3",
        cpu_id: "Intel(R) Core(TM)",
      },
      hostname: "lab-01",
      flow: "admin",
    });
    expect(body.flow).toBe("admin");
  });

  test("rejects unknown keys", () => {
    expect(() =>
      HwidComponents.parse({
        product_uuid: "u",
        board_serial: "",
        product_name: "n",
        cpu_id: "c",
        extra: true,
      }),
    ).toThrow();
  });

  test("self authenticate requires employee_id shape", () => {
    expect(() =>
      SelfAuthenticateRequest.parse({
        employee_id: "bad id!",
        password: "secret",
        enrollment_code: "STAKA-AAAA-BBBB-CCCC-DDDD",
      }),
    ).toThrow();
    expect(
      SelfAuthenticateRequest.parse({
        employee_id: "23-1670",
        password: "secret",
        enrollment_code: "STAKA-AAAA-BBBB-CCCC-DDDD",
      }).employee_id,
    ).toBe("23-1670");
  });
});
