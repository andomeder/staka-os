import { loadEnv } from "./env.ts";
import { serve } from "./serve.ts";
import { bootstrap } from "./bootstrap.ts";
import { createAgent } from "./agent-factory.ts";
import { resolveModelApiKey } from "./keyring.ts";

const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve": {
    const env = loadEnv();
    await serve(env);
    break;
  }
  case "chat": {
    const env = loadEnv();
    const message = process.argv.slice(3).join(" ").trim();
    if (!message) {
      console.error("usage: staka-agent chat <message>");
      process.exit(2);
    }
    const boot = await bootstrap(env);
    const modelKey = await resolveModelApiKey(env);
    if (modelKey.source !== "keyring") console.log(`keyring: ${modelKey.source}`);
    const agent = createAgent({ env, orgUrl: boot.orgUrl, token: boot.token, apiKey: modelKey.key });
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });
    await agent.prompt(message);
    await agent.waitForIdle();
    process.stdout.write("\n");
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
