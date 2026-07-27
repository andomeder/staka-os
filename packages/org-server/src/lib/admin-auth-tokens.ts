import type { Db } from "../db/client.ts";
import type { AdminSessionStore } from "./admin-session.ts";
import { signJwt, type JwtKeyring } from "./jwt.ts";
import { verifyPassword } from "./password.ts";
import { getActiveAdminByEmployeeId, getActiveAdminById } from "./users.ts";

export const ADMIN_JWT_TTL = "8h";
export const ADMIN_JWT_TTL_SEC = 8 * 60 * 60;

export async function mintAdminJwt(input: {
  keyring: JwtKeyring;
  sessions: AdminSessionStore;
  userId: string;
  employeeId: string;
}): Promise<{ token: string; expiresAt: Date; jti: string }> {
  const expiresAtSec = Math.floor(Date.now() / 1000) + ADMIN_JWT_TTL_SEC;
  const jti = input.sessions.create({
    userId: input.userId,
    employeeId: input.employeeId,
    expiresAt: expiresAtSec * 1000,
  });
  const { token, expiresAt } = await signJwt(
    input.keyring,
    {
      sub: input.userId,
      role: "admin",
      employee_id: input.employeeId,
      jti,
    },
    { expiresIn: ADMIN_JWT_TTL },
  );
  return { token, expiresAt, jti };
}

export async function loginAdmin(input: {
  db: Db;
  keyring: JwtKeyring;
  sessions: AdminSessionStore;
  employeeId: string;
  password: string;
}): Promise<{ token: string; expiresAt: Date; jti: string } | null> {
  const user = await getActiveAdminByEmployeeId(input.db, input.employeeId);
  if (!user?.passwordHash) return null;
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) return null;
  return mintAdminJwt({
    keyring: input.keyring,
    sessions: input.sessions,
    userId: user.id,
    employeeId: user.employeeId,
  });
}

export async function refreshAdminJwt(input: {
  db: Db;
  keyring: JwtKeyring;
  sessions: AdminSessionStore;
  userId: string;
  employeeId: string;
  oldJti: string;
}): Promise<{ token: string; expiresAt: Date; jti: string } | null> {
  const admin = await getActiveAdminById(input.db, input.userId);
  if (!admin || admin.employeeId !== input.employeeId) {
    input.sessions.revoke(input.oldJti);
    return null;
  }

  const expiresAtSec = Math.floor(Date.now() / 1000) + ADMIN_JWT_TTL_SEC;
  const newJti = input.sessions.rotate(input.oldJti, {
    userId: admin.id,
    employeeId: admin.employeeId,
    expiresAt: expiresAtSec * 1000,
  });
  if (!newJti) return null;

  const { token, expiresAt } = await signJwt(
    input.keyring,
    {
      sub: admin.id,
      role: "admin",
      employee_id: admin.employeeId,
      jti: newJti,
    },
    { expiresIn: ADMIN_JWT_TTL },
  );
  return { token, expiresAt, jti: newJti };
}
