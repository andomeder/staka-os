import { eq } from "drizzle-orm";
import {
  generateEnrollmentCode,
  hashEnrollmentCode,
  maskEnrollmentCode,
} from "../lib/codes.ts";
import { hashPassword } from "../lib/password.ts";
import { createDb } from "./client.ts";
import { activationCodes, users } from "./schema.ts";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const db = createDb(databaseUrl);

  const employeeId = process.env.STAKA_SEED_ADMIN_EMPLOYEE_ID ?? "EMP-0001";
  const password = process.env.STAKA_SEED_ADMIN_PASSWORD;
  if (!password) {
    throw new Error("STAKA_SEED_ADMIN_PASSWORD is required for seed");
  }
  const displayName = process.env.STAKA_SEED_ADMIN_DISPLAY_NAME ?? "Staka Admin";

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.employeeId, employeeId))
    .limit(1);

  let adminId: string;
  if (existing[0]) {
    adminId = existing[0].id;
    console.log(`admin exists: ${employeeId} (${adminId})`);
  } else {
    const passwordHash = await hashPassword(password);
    const [admin] = await db
      .insert(users)
      .values({
        employeeId,
        displayName,
        role: "admin",
        status: "active",
        passwordHash,
      })
      .returning();
    if (!admin) throw new Error("failed to create admin");
    adminId = admin.id;
    console.log(`admin created: ${employeeId} (${adminId})`);
  }

  const code = generateEnrollmentCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(activationCodes)
    .values({
      codeHash: hashEnrollmentCode(code),
      codeDisplay: maskEnrollmentCode(code),
      userId: adminId,
      createdBy: adminId,
      expiresAt,
      maxUses: 1,
      flow: "admin",
    })
    .returning();

  if (!row) throw new Error("failed to create enrollment code");

  console.log("enrollment_code (shown once):", code);
  console.log("code_id:", row.id);
  console.log("code_display:", row.codeDisplay);
  console.log("expires_at:", expiresAt.toISOString());

  await db.$client.end({ timeout: 2 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
