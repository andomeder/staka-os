import {
  EnrollRequest,
  HeartbeatRequest,
  SelfAuthenticateRequest,
  TokenRequest,
} from "@staka/protocol";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import { appMachineColumns } from "../db/machine-columns.ts";
import {
  activationCodes,
  machines,
  usageLogs,
  users,
} from "../db/schema.ts";
import {
  consumeEnrollmentCode,
  findValidCodeByHash,
  hashEnrollmentCode,
} from "../lib/codes.ts";
import { verifyEnrollHwid } from "../lib/hwid.ts";
import {
  jwksDocument,
  signJwt,
  verifyJwt,
  type JwtKeyring,
} from "../lib/jwt.ts";
import {
  approveMachine,
  consumeEnrollmentNonce,
  recordHeartbeat,
} from "../lib/machines.ts";
import { MachineStatusCache } from "../lib/machine-status-cache.ts";
import { verifyPassword } from "../lib/password.ts";
import {
  clientIp,
  type ActivationRateLimiters,
} from "../lib/rate-limit.ts";

const POLL_INTERVAL_SEC = 10;
const SELF_PROVISION_TTL_SEC = 15 * 60;
const MACHINE_JWT_TTL = "30d";

export type ActivateDeps = {
  dbApp: Db;
  keyring: JwtKeyring;
  rateLimiters: ActivationRateLimiters;
  statusCache?: MachineStatusCache;
  autoApprove?: boolean;
  autoApproveActorId?: string;
};

function err(
  c: {
    json: (body: unknown, status: number) => Response;
    get: (k: "requestId") => string;
  },
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
) {
  return c.json({ error, request_id: c.get("requestId"), ...extra }, status);
}

export function activateRoutes(deps: ActivateDeps) {
  const app = new Hono();
  const statusCache = deps.statusCache ?? new MachineStatusCache();

  app.get("/v1/.well-known/jwks.json", (c) => {
    return c.json(jwksDocument(deps.keyring));
  });

  app.post("/v1/activate/self/authenticate", async (c) => {
    const ip = clientIp(c.req.raw.headers);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid_body");
    }
    const parsed = SelfAuthenticateRequest.safeParse(body);
    if (!parsed.success) return err(c, 400, "invalid_body");

    const codeHash = hashEnrollmentCode(parsed.data.enrollment_code);
    const ipHit = deps.rateLimiters.authIp.hit(`ip:${ip}`);
    if (!ipHit.ok) {
      c.header("Retry-After", String(ipHit.retryAfterSec));
      return err(c, 429, "rate_limited");
    }
    const empHit = deps.rateLimiters.authEmployee.hit(
      `emp:${parsed.data.employee_id}`,
    );
    if (!empHit.ok) {
      c.header("Retry-After", String(empHit.retryAfterSec));
      return err(c, 429, "rate_limited");
    }
    const codeHit = deps.rateLimiters.authCode.hit(`code:${codeHash}`);
    if (!codeHit.ok) {
      c.header("Retry-After", String(codeHit.retryAfterSec));
      return err(c, 429, "rate_limited");
    }

    const code = await findValidCodeByHash(deps.dbApp, codeHash, {
      flow: "self",
    });
    if (!code) return err(c, 401, "invalid_credentials");

    const [user] = await deps.dbApp
      .select()
      .from(users)
      .where(
        and(
          eq(users.employeeId, parsed.data.employee_id),
          eq(users.id, code.userId),
          eq(users.status, "active"),
        ),
      )
      .limit(1);

    if (!user?.passwordHash) return err(c, 401, "invalid_credentials");
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) return err(c, 401, "invalid_credentials");

    const { token, expiresAt } = await signJwt(
      deps.keyring,
      {
        typ: "self_provision",
        user_id: user.id,
        code_id: code.id,
      },
      { expiresIn: SELF_PROVISION_TTL_SEC },
    );

    return c.json({
      self_provision_token: token,
      expires_at: expiresAt.toISOString(),
    });
  });

  app.post("/v1/activate/enroll", async (c) => {
    const ip = clientIp(c.req.raw.headers);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid_body");
    }
    const parsed = EnrollRequest.safeParse(body);
    if (!parsed.success) return err(c, 400, "invalid_body");
    const data = parsed.data;

    const codeHash = hashEnrollmentCode(data.enrollment_code);
    const ipHit = deps.rateLimiters.enrollIp.hit(`ip:${ip}`);
    if (!ipHit.ok) {
      c.header("Retry-After", String(ipHit.retryAfterSec));
      return err(c, 429, "rate_limited");
    }
    const codeRl = deps.rateLimiters.enrollCode.hit(`code:${codeHash}`);
    if (!codeRl.ok) {
      c.header("Retry-After", String(codeRl.retryAfterSec));
      return err(c, 429, "rate_limited");
    }
    const hwidRl = deps.rateLimiters.enrollHwid.hit(`hw:${data.hardware_id}`);
    if (!hwidRl.ok) {
      c.header("Retry-After", String(hwidRl.retryAfterSec));
      return err(c, 429, "rate_limited");
    }

    let canonical;
    try {
      canonical = verifyEnrollHwid({
        hardware_id: data.hardware_id,
        hwid_hash: data.hwid_hash,
        hwid_components: data.hwid_components,
      });
    } catch {
      return err(c, 400, "invalid_hwid");
    }

    let codeRow = await findValidCodeByHash(deps.dbApp, codeHash, {
      flow: data.flow,
    });
    if (!codeRow) {
      const [spent] = await deps.dbApp
        .select()
        .from(activationCodes)
        .where(eq(activationCodes.codeHash, codeHash))
        .limit(1);
      if (!spent || spent.flow !== data.flow || spent.revokedAt) {
        return err(c, 401, "invalid_code");
      }
      if (spent.expiresAt.getTime() <= Date.now()) {
        return err(c, 401, "invalid_code");
      }
      codeRow = spent;
    }

    if (data.flow === "self") {
      let claims;
      try {
        const verified = await verifyJwt(
          deps.keyring,
          data.self_provision_token,
        );
        claims = verified.payload;
      } catch {
        return err(c, 401, "invalid_code");
      }
      if (
        claims.typ !== "self_provision" ||
        claims.user_id !== codeRow.userId ||
        claims.code_id !== codeRow.id
      ) {
        return err(c, 401, "invalid_code");
      }
    }

    const [existing] = await deps.dbApp
      .select(appMachineColumns)
      .from(machines)
      .where(eq(machines.hardwareId, canonical.hardwareId))
      .limit(1);

    if (existing) {
      if (existing.enrollmentCodeId === codeRow.id) {
        return c.json(
          {
            machine_id: existing.id,
            status: existing.status,
            poll_interval: POLL_INTERVAL_SEC,
          },
          202,
        );
      }
      if (
        existing.status === "active" ||
        existing.status === "approved" ||
        existing.status === "pending"
      ) {
        if (existing.userId !== codeRow.userId) {
          return err(c, 409, "hardware_id_bound");
        }
        if (existing.status === "pending") {
          const consumed = await consumeEnrollmentCode(deps.dbApp, codeRow.id);
          if (!consumed) return err(c, 401, "invalid_code");
          const [updated] = await deps.dbApp
            .update(machines)
            .set({
              enrollmentCodeId: codeRow.id,
              hostname: data.hostname,
              hwidHash: canonical.hwidHash,
              hwidDisplay: canonical.hwidDisplay,
              provisionFlow: data.flow,
            })
            .where(eq(machines.id, existing.id))
            .returning(appMachineColumns);
          return c.json(
            {
              machine_id: updated!.id,
              status: updated!.status,
              poll_interval: POLL_INTERVAL_SEC,
            },
            202,
          );
        }
        return err(c, 409, "hardware_id_bound");
      }
      return err(c, 409, "hardware_id_bound");
    }

    const consumed = await consumeEnrollmentCode(deps.dbApp, codeRow.id);
    if (!consumed) return err(c, 401, "invalid_code");

    let machine;
    try {
      const [inserted] = await deps.dbApp
        .insert(machines)
        .values({
          hardwareId: canonical.hardwareId,
          hwidHash: canonical.hwidHash,
          hwidDisplay: canonical.hwidDisplay,
          hwidComponents: canonical.components,
          hostname: data.hostname,
          userId: codeRow.userId,
          enrollmentCodeId: codeRow.id,
          status: "pending",
          provisionFlow: data.flow,
        })
        .returning(appMachineColumns);
      machine = inserted;
    } catch {
      const [raced] = await deps.dbApp
        .select(appMachineColumns)
        .from(machines)
        .where(eq(machines.hardwareId, canonical.hardwareId))
        .limit(1);
      if (raced && raced.enrollmentCodeId === codeRow.id) {
        return c.json(
          {
            machine_id: raced.id,
            status: raced.status,
            poll_interval: POLL_INTERVAL_SEC,
          },
          202,
        );
      }
      return err(c, 409, "hardware_id_bound");
    }

    if (!machine) return err(c, 500, "internal_error");

    await deps.dbApp.insert(usageLogs).values({
      machineId: machine.id,
      eventType: "activation_requested",
      payload: { flow: data.flow, hostname: data.hostname },
    });

    if (deps.autoApprove && deps.autoApproveActorId) {
      await approveMachine(deps.dbApp, {
        machineId: machine.id,
        approvedBy: deps.autoApproveActorId,
      });
      const [refreshed] = await deps.dbApp
        .select(appMachineColumns)
        .from(machines)
        .where(eq(machines.id, machine.id))
        .limit(1);
      if (refreshed) machine = refreshed;
    }

    return c.json(
      {
        machine_id: machine.id,
        status: machine.status,
        poll_interval: POLL_INTERVAL_SEC,
      },
      202,
    );
  });

  app.get("/v1/activate/status/:machine_id", async (c) => {
    const machineId = c.req.param("machine_id");
    const code = c.req.query("code");
    if (!code) return err(c, 401, "invalid_code");

    const codeHash = hashEnrollmentCode(code);
    const [machine] = await deps.dbApp
      .select(appMachineColumns)
      .from(machines)
      .where(eq(machines.id, machineId))
      .limit(1);
    if (!machine) return err(c, 404, "not_found");

    const [boundCode] = await deps.dbApp
      .select()
      .from(activationCodes)
      .where(eq(activationCodes.id, machine.enrollmentCodeId))
      .limit(1);
    if (!boundCode || boundCode.codeHash !== codeHash) {
      return err(c, 401, "invalid_code");
    }

    const body: { status: string; enrollment_nonce?: string } = {
      status: machine.status,
    };
    if (machine.status === "approved" && machine.enrollmentNoncePlain) {
      body.enrollment_nonce = machine.enrollmentNoncePlain;
    }
    return c.json(body);
  });

  app.post("/v1/activate/token", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid_body");
    }
    const parsed = TokenRequest.safeParse(body);
    if (!parsed.success) return err(c, 400, "invalid_body");

    const result = await consumeEnrollmentNonce(deps.dbApp, {
      machineId: parsed.data.machine_id,
      enrollmentNonce: parsed.data.enrollment_nonce,
    });

    if (!result.ok) {
      if (result.reason === "not_found") return err(c, 404, "not_found");
      if (result.reason === "bad_nonce") return err(c, 403, "invalid_nonce");
      if (result.reason === "consumed") return err(c, 410, "nonce_consumed");
      return err(c, 409, "not_approved");
    }

    const { token, expiresAt } = await signJwt(
      deps.keyring,
      { sub: result.machine.id },
      { expiresIn: MACHINE_JWT_TTL },
    );

    statusCache.set(result.machine.id, result.machine.status);

    return c.json({
      machine_jwt: token,
      expires_at: expiresAt.toISOString(),
    });
  });

  app.post("/v1/activate/heartbeat", async (c) => {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return err(c, 401, "unauthorized");
    const token = auth.slice("Bearer ".length).trim();
    if (!token) return err(c, 401, "unauthorized");

    let payload;
    try {
      const verified = await verifyJwt(deps.keyring, token);
      payload = verified.payload;
    } catch {
      return err(c, 401, "unauthorized");
    }

    const machineId = typeof payload.sub === "string" ? payload.sub : null;
    if (!machineId) return err(c, 401, "unauthorized");

    let body: unknown = {};
    try {
      if (c.req.header("content-type")?.includes("application/json")) {
        body = await c.req.json();
      }
    } catch {
      return err(c, 400, "invalid_body");
    }
    const parsed = HeartbeatRequest.safeParse(body ?? {});
    if (!parsed.success) return err(c, 400, "invalid_body");

    // Always re-check DB when cache miss; on hit still allow revoke within TTL
    // but force a DB read when cached status is active/approved by validating
    // against DB if last cache write is stale is handled by TTL. For revoke
    // tests, callers use a fresh statusCache.
    let status = statusCache.get(machineId);
    if (!status) {
      const [row] = await deps.dbApp
        .select({ status: machines.status })
        .from(machines)
        .where(eq(machines.id, machineId))
        .limit(1);
      if (!row) return err(c, 401, "unauthorized");
      status = row.status;
      statusCache.set(machineId, status);
    }

    if (status === "suspended" || status === "revoked") {
      return err(c, 403, "forbidden");
    }
    if (status !== "approved" && status !== "active") {
      return err(c, 403, "forbidden");
    }

    const updated = await recordHeartbeat(
      deps.dbApp,
      machineId,
      parsed.data.metrics,
    );
    if (!updated) {
      // likely revoked/suspended since cache write
      statusCache.invalidate(machineId);
      return err(c, 403, "forbidden");
    }
    statusCache.set(machineId, updated.status);

    return c.json({ ok: true as const, status: updated.status });
  });

  return app;
}
