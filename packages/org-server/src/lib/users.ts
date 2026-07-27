import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { users, type NewUser, type User } from "../db/schema.ts";
import { hashPassword } from "./password.ts";

export type CreateUserInput = {
  employeeId: string;
  displayName: string;
  role: "admin" | "staff";
  initialPassword?: string;
  email?: string;
};

/** Public user fields - never includes password_hash. */
export type PublicUser = {
  id: string;
  employeeId: string;
  email: string | null;
  displayName: string;
  role: User["role"];
  status: User["status"];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export const publicUserColumns = {
  id: users.id,
  employeeId: users.employeeId,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  status: users.status,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  deletedAt: users.deletedAt,
} as const;

export async function createUser(
  db: Db,
  input: CreateUserInput,
): Promise<PublicUser> {
  const passwordHash = input.initialPassword
    ? await hashPassword(input.initialPassword)
    : null;
  const status = input.initialPassword ? "active" : "invited";
  const values: NewUser = {
    employeeId: input.employeeId,
    displayName: input.displayName,
    role: input.role,
    status,
    passwordHash,
  };
  if (input.email !== undefined) values.email = input.email;
  const [row] = await db
    .insert(users)
    .values(values)
    .returning(publicUserColumns);
  if (!row) throw new Error("failed to create user");
  return row;
}

export async function listUsers(db: Db): Promise<PublicUser[]> {
  return db
    .select(publicUserColumns)
    .from(users)
    .where(isNull(users.deletedAt))
    .orderBy(asc(users.createdAt));
}

export async function getUserById(
  db: Db,
  id: string,
): Promise<PublicUser | null> {
  const [row] = await db
    .select(publicUserColumns)
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function getActiveAdminByEmployeeId(
  db: Db,
  employeeId: string,
): Promise<(PublicUser & { passwordHash: string | null }) | null> {
  const [row] = await db
    .select({
      ...publicUserColumns,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(
      and(
        eq(users.employeeId, employeeId),
        eq(users.role, "admin"),
        eq(users.status, "active"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getActiveAdminById(
  db: Db,
  id: string,
): Promise<PublicUser | null> {
  const [row] = await db
    .select(publicUserColumns)
    .from(users)
    .where(
      and(
        eq(users.id, id),
        eq(users.role, "admin"),
        eq(users.status, "active"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function deactivateUser(
  db: Db,
  id: string,
): Promise<PublicUser | null> {
  const now = new Date();
  const [row] = await db
    .update(users)
    .set({
      status: "suspended",
      deletedAt: now,
    })
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .returning(publicUserColumns);
  return row ?? null;
}

export async function setUserPassword(
  db: Db,
  id: string,
  password: string,
): Promise<PublicUser | null> {
  const passwordHash = await hashPassword(password);
  const [row] = await db
    .update(users)
    .set({
      passwordHash,
      status: "active",
    })
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .returning(publicUserColumns);
  return row ?? null;
}
