import { eq } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { users } from "../db/schema.ts";
import { createActivationCode } from "../lib/admin-codes.ts";
import { appendAudit } from "../lib/audit.ts";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const employeeId = arg("employee-id") ?? arg("user");
  const userIdArg = arg("user-id");
  const flow = (arg("flow") === "self" ? "self" : "admin") as "admin" | "self";
  const maxUses = Number(arg("max-uses") ?? "1");
  const actorEmployeeId =
    arg("created-by") ?? process.env.STAKA_SEED_ADMIN_EMPLOYEE_ID ?? "EMP-0001";

  if (!employeeId && !userIdArg) {
    throw new Error("pass --employee-id <id> or --user-id <uuid>");
  }

  const db = createDb(databaseUrl);

  const [actor] = await db
    .select()
    .from(users)
    .where(eq(users.employeeId, actorEmployeeId))
    .limit(1);
  if (!actor || actor.role !== "admin") {
    throw new Error(`admin actor not found: ${actorEmployeeId}`);
  }

  let userId = userIdArg;
  if (!userId) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.employeeId, employeeId!))
      .limit(1);
    if (!user) throw new Error(`user not found: ${employeeId}`);
    userId = user.id;
  }

  const { code, plaintext } = await createActivationCode(db, {
    userId: userId!,
    createdBy: actor.id,
    flow,
    maxUses: Number.isFinite(maxUses) ? maxUses : 1,
  });

  await appendAudit(db, {
    actorUserId: actor.id,
    action: "code.create",
    targetType: "activation_code",
    targetId: code.id,
    payload: { via: "cli", flow, max_uses: code.maxUses },
  });

  console.log("code (shown once):", plaintext);
  console.log("code_id:", code.id);
  console.log("code_display:", code.codeDisplay);
  console.log("flow:", code.flow);
  console.log("user_id:", code.userId);
  console.log("expires_at:", code.expiresAt.toISOString());

  await db.$client.end({ timeout: 2 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
