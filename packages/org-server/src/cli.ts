export const CLI_COMMANDS = [
  "serve",
  "migrate",
  "seed",
  "audit-verify",
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

const COMMAND_SET = new Set<string>(CLI_COMMANDS);

export const CLI_USAGE =
  "usage: staka-org-server [serve|migrate|seed|audit-verify]";

export class UnknownCliCommandError extends Error {
  readonly token: string;

  constructor(token: string) {
    super(`unknown command: ${token}\n${CLI_USAGE}`);
    this.name = "UnknownCliCommandError";
    this.token = token;
  }
}

/** Bun/node put the entry script path in argv[1]; skip it when scanning. */
function isEntryScriptToken(arg: string): boolean {
  return (
    arg.endsWith(".ts") ||
    arg.endsWith(".js") ||
    arg.endsWith(".mjs") ||
    arg.endsWith(".cjs") ||
    arg.includes("/index.ts") ||
    arg.includes("\\index.ts") ||
    arg.endsWith("staka-org-server")
  );
}

/** Resolve CLI command from argv (works for `bun src/index.ts` and compiled binary). */
export function parseCliCommand(argv: readonly string[]): CliCommand {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) continue;
    if (isEntryScriptToken(arg)) continue;
    if (COMMAND_SET.has(arg)) return arg as CliCommand;
    throw new UnknownCliCommandError(arg);
  }
  return "serve";
}
