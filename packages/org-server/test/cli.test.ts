import { describe, expect, test } from "bun:test";
import {
  parseCliCommand,
  UnknownCliCommandError,
} from "../src/cli.ts";

describe("parseCliCommand", () => {
  test("defaults to serve", () => {
    expect(parseCliCommand(["staka-org-server"])).toBe("serve");
    expect(parseCliCommand(["bun", "src/index.ts"])).toBe("serve");
  });

  test("parses migrate seed audit-verify serve", () => {
    expect(parseCliCommand(["staka-org-server", "migrate"])).toBe("migrate");
    expect(parseCliCommand(["staka-org-server", "seed"])).toBe("seed");
    expect(parseCliCommand(["staka-org-server", "audit-verify"])).toBe(
      "audit-verify",
    );
    expect(parseCliCommand(["staka-org-server", "serve"])).toBe("serve");
  });

  test("skips flags before command", () => {
    expect(parseCliCommand(["staka-org-server", "--foo", "migrate"])).toBe(
      "migrate",
    );
  });

  test("rejects unknown non-flag tokens", () => {
    expect(() => parseCliCommand(["staka-org-server", "wat"])).toThrow(
      UnknownCliCommandError,
    );
    expect(() => parseCliCommand(["staka-org-server", "migrat"])).toThrow(
      /unknown command: migrat/,
    );
    try {
      parseCliCommand(["staka-org-server", "aduit-verify"]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownCliCommandError);
      expect((err as UnknownCliCommandError).token).toBe("aduit-verify");
    }
  });
});
