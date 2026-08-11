import { loadEnv } from "./env.ts";
import { serve } from "./serve.ts";

const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve": {
    const env = loadEnv();
    await serve(env);
    break;
  }
  case "chat": {
    console.error("chat: not yet implemented");
    process.exit(1);
    break;
  }
  case "skills-list": {
    console.error("skills-list: not yet implemented");
    process.exit(1);
    break;
  }
  default: {
    console.error(`unknown command: ${command}`);
    console.error("usage: staka-agent <serve|chat|skills-list>");
    process.exit(2);
  }
}
