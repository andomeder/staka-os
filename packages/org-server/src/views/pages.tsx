import type { Child } from "hono/jsx";
import {
  CssIcon,
  Flash,
  Icon,
  Layout,
  isDarkTheme,
  THEME_COOKIE,
  type IconName,
} from "./layout.tsx";

function Badge(props: { status: string }) {
  return <span class={`badge ${props.status}`}>{props.status}</span>;
}

function Csrf(props: { token: string }) {
  return <input type="hidden" name="csrf" value={props.token} />;
}

/**
 * Maps server flash codes to a severity and a real sentence. Unknown codes
 * fall back to a neutral banner so nothing silently disappears.
 */
const FLASH_COPY: Record<string, { kind: "ok" | "warn" | "error"; text: string }> = {
  approved: { kind: "ok", text: "Machine approved. Use the enrollment nonce below to activate it." },
  created: { kind: "ok", text: "Created." },
  conflict: { kind: "error", text: "That employee ID is already in use. Choose a different one." },
  csrf: { kind: "error", text: "Your session expired. Please try the action again." },
  invalid: { kind: "error", text: "The submitted values were not valid. Check the form and retry." },
  not_found: { kind: "error", text: "That record no longer exists." },
  not_pending: { kind: "warn", text: "This machine is not waiting for approval anymore." },
  rate_limited: { kind: "warn", text: "Too many attempts. Wait a few minutes and try again." },
  revoked: { kind: "ok", text: "Revoked. The affected machine or code can no longer be used." },
  suspended: { kind: "ok", text: "Machine suspended. It cannot activate until re-approved." },
  user_not_found: { kind: "error", text: "That user does not exist or is deactivated." },
  kb_uploaded: { kind: "ok", text: "Document uploaded to the knowledge base." },
  kb_deleted: { kind: "ok", text: "Document deleted from the knowledge base." },
  kb_missing: { kind: "warn", text: "That document was already removed." },
  kb_disabled: { kind: "warn", text: "The knowledge base engine is not configured on this deployment." },
  kb_profiles_synced: { kind: "ok", text: "Directory profiles synced into the knowledge base." },
  kb_unavailable: { kind: "error", text: "The knowledge base engine is unreachable right now. Try again shortly." },
  kb_400: { kind: "error", text: "The upload was rejected. Check the file and retry." },
  kb_413: { kind: "error", text: "That file is larger than the 10 MiB limit." },
  kb_error: { kind: "error", text: "Something went wrong talking to the knowledge base engine." },
};

function FlashMessage(props: { code: string }) {
  const copy = FLASH_COPY[props.code] ?? {
    kind: "warn" as const,
    text: props.code,
  };
  return (
    <Flash kind={copy.kind}>{copy.text}</Flash>
  );
}

function Stat(props: { value: string; label: string; icon: IconName }) {
  return (
    <div class="stat">
      <div class="stat-icon">
        <Icon name={props.icon} />
      </div>
      <div>
        <div class="stat-value">{props.value}</div>
        <div class="stat-label">{props.label}</div>
      </div>
    </div>
  );
}

function StatusCounts(props: {
  counts: Record<string, number>;
  active: "machines" | "reports";
}) {
  const active = props.active;
  return (
    <div class="stat-row">
      <Stat value={String(props.counts.active ?? 0)} label="active" icon="monitor" />
      <Stat
        value={String(props.counts.pending ?? 0)}
        label="pending approval"
        icon={active === "machines" ? "shield" : "alert"}
      />
      <Stat
        value={String(props.counts.suspended ?? 0)}
        label="suspended"
        icon="shield"
      />
      <Stat
        value={String(props.counts.revoked ?? 0)}
        label="revoked"
        icon="alert"
      />
    </div>
  );
}

function ExportButtons(props: { csvHref: string; pdfHref?: string; csvLabel?: string }) {
  return (
    <div class="head-actions">
      <a class="btn secondary" href={props.csvHref} download>
        <Icon name="download" />
        {props.csvLabel ?? "Export CSV"}
      </a>
      {props.pdfHref ? (
        <a class="btn primary" href={props.pdfHref}>
          <Icon name="file" />
          Export PDF
        </a>
      ) : null}
    </div>
  );
}

export function LoginPage(props: {
  csrf: string;
  error?: string;
  theme?: "light" | "dark" | undefined;
}) {
  const errorCopy: Record<string, string> = {
    invalid: "Invalid employee ID or password.",
    csrf: "Your session expired. Try again.",
    rate_limited:
      "Too many failed attempts. Wait a few minutes before retrying.",
  };
  const message = props.error ? (errorCopy[props.error] ?? props.error) : undefined;
  return (
    <Layout title="Login" theme={props.theme}>
      <div class="login-card">
        <div>
          <div class="login-accent" aria-hidden="true" />
          <h1 class="login-title">Admin sign in</h1>
          <p class="login-sub" style="margin-top:4px;">
            Use your Staka employee account.
          </p>
        </div>
        {message ? <Flash kind="error">{message}</Flash> : null}
        <form class="stack" method="post" action="/admin/login">
          <Csrf token={props.csrf} />
          <label>
            Employee ID
            <input
              name="employee_id"
              required
              autocomplete="username"
              autocapitalize="none"
              spellcheck={false}
              placeholder="e.g. 23-1670"
            />
            <span class="field-hint">
              Stored exactly as issued - case-sensitive, no added spaces.
            </span>
          </label>
          <label>
            Password
            <span class="pw-wrap">
              <input
                id="pw-field"
                name="password"
                type="password"
                required
                autocomplete="current-password"
              />
              <button
                id="pw-eye"
                class="pw-eye"
                type="button"
                aria-label="Show password"
              >
                <CssIcon kind="eye" />
                <CssIcon kind="eyeOff" />
              </button>
            </span>
          </label>
          <button class="primary" type="submit">
            Sign in
          </button>
        </form>
        <div class="login-foot">
          <p>Sessions expire 8 hours after sign-in.</p>
          <p>Repeated failures are rate-limited per network.</p>
        </div>
      </div>
      <p class="login-version">staka v0.1 - Apache-2.0</p>
    </Layout>
  );
}

export function MachinesPage(props: {
  employeeId: string;
  csrf: string;
  theme?: "light" | "dark" | undefined;
  machines: Array<{
    id: string;
    hostname: string;
    status: string;
    userLabel: string;
    hwidDisplay: string;
    lastHeartbeatAt: string | null;
  }>;
  summary: { machines_by_status: Record<string, number> };
  flash?: string;
}) {
  return (
    <Layout
      title="Machines"
      employeeId={props.employeeId}
      csrf={props.csrf}
      theme={props.theme}
      activeNav="machines"
    >
      <div class="page-head">
        <div>
          <h1 class="page-title">Machines</h1>
          <p class="page-sub">
            {props.machines.length} registered workstations
          </p>
        </div>
        <ExportButtons csvHref="/admin/machines.csv" />
      </div>
      <div class="page-body">
        <StatusCounts counts={props.summary.machines_by_status} active="machines" />
        {props.flash ? <FlashMessage code={props.flash} /> : null}
        <div class="card table-card">
          <table>
            <thead>
              <tr>
                <th>Hostname</th>
                <th>Status</th>
                <th>User</th>
                <th>HWID</th>
                <th>Last heartbeat</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {props.machines.length === 0 ? (
                <tr>
                  <td colspan={6} class="empty">
                    No machines yet.
                  </td>
                </tr>
              ) : (
                props.machines.map((m) => (
                  <tr>
                    <td>
                      <a class="host-link" href={`/admin/machines/${m.id}`}>
                        {m.hostname}
                      </a>
                    </td>
                    <td>
                      <Badge status={m.status} />
                    </td>
                    <td class="wrap">{m.userLabel}</td>
                    <td class="mono">{m.hwidDisplay}</td>
                    <td class="muted">{m.lastHeartbeatAt ?? "-"}</td>
                    <td>
                      <div class="row">
                        {m.status === "pending" ? (
                          <form
                            class="inline"
                            method="post"
                            action={`/admin/machines/${m.id}/approve`}
                          >
                            <Csrf token={props.csrf} />
                            <button class="primary small" type="submit">
                              Approve
                            </button>
                          </form>
                        ) : null}
                        {m.status === "pending" ||
                        m.status === "approved" ||
                        m.status === "active" ? (
                          <form
                            class="inline"
                            method="post"
                            action={`/admin/machines/${m.id}/suspend`}
                          >
                            <Csrf token={props.csrf} />
                            <button class="secondary small" type="submit">
                              Suspend
                            </button>
                          </form>
                        ) : null}
                        {m.status !== "revoked" ? (
                          <form
                            class="inline"
                            method="post"
                            action={`/admin/machines/${m.id}/revoke`}
                          >
                            <Csrf token={props.csrf} />
                            <button
                              class="danger small"
                              type="submit"
                              data-confirm={`Revoke ${m.hostname}? The machine will lose access until it is approved again.`}
                            >
                              Revoke
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

const EVENT_LABELS: Record<string, string> = {
  activation_requested: "Enrollment requested",
  activation_approved: "Approved",
  activation_denied: "Denied",
  nonce_issued: "Enrollment nonce issued",
  token_issued: "Machine token issued",
  admin_action: "Admin action",
  admin_read_pii: "PII viewed",
  user_authenticated_self_provision: "Self-provision auth",
  config_pull: "Config pulled",
};

type TimelineEntry = { label: string; time: string; muted?: boolean };

function buildTimeline(logs: Array<{ eventType: string; createdAt: string }>): TimelineEntry[] {
  const heartbeats = logs.filter((l) => l.eventType === "heartbeat");
  const others = logs.filter((l) => l.eventType !== "heartbeat");
  const entries: TimelineEntry[] = others.map((l) => ({
    label: EVENT_LABELS[l.eventType] ?? l.eventType,
    time: l.createdAt,
  }));
  if (heartbeats.length > 0) {
    const times = heartbeats.map((h) => h.createdAt).sort();
    const first = times[0]!;
    const last = times[times.length - 1]!;
    const summary =
      heartbeats.length === 1
        ? `First heartbeat`
        : `${heartbeats.length} heartbeats (${first} to ${last})`;
    entries.push({ label: summary, time: first, muted: true });
  }
  entries.sort((a, b) => a.time.localeCompare(b.time));
  return entries;
}

export function MachineDetailPage(props: {
  employeeId: string;
  csrf: string;
  theme?: "light" | "dark" | undefined;
  machine: {
    id: string;
    hostname: string;
    status: string;
    hardwareId: string;
    hwidDisplay: string;
    provisionFlow: string;
    firstSeenAt: string;
    approvedAt: string | null;
    lastHeartbeatAt: string | null;
  };
  userLabel: string;
  logs: Array<{ id: number; eventType: string; createdAt: string }>;
  hwidJson?: string;
  flash?: string;
  nonce?: string;
}) {
  return (
    <Layout
      title={props.machine.hostname}
      employeeId={props.employeeId}
      csrf={props.csrf}
      theme={props.theme}
      activeNav="machines"
    >
      <div class="page-head">
        <div class="page-head-row">
          <a class="btn secondary small" href="/admin" aria-label="Back to machines">
            <Icon name="back" />
          </a>
          <div>
            <h1 class="page-title">{props.machine.hostname}</h1>
            <p class="page-sub">
              <Badge status={props.machine.status} />
            </p>
          </div>
        </div>
        <ExportButtons csvHref="/admin/machines.csv" csvLabel="Fleet CSV" />
      </div>
      <div class="page-body">
        {props.flash ? <FlashMessage code={props.flash} /> : null}
        <div class="detail-grid">
          <div class="col">
            <div class="card">
              <h2>Machine properties</h2>
              <div class="prop-list">
                <div class="prop-row">
                  <span class="prop-key">Bound user</span>
                  <span class="prop-val">{props.userLabel}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-key">Provision flow</span>
                  <span class="prop-val">{props.machine.provisionFlow}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-key">Hardware ID</span>
                  <span class="prop-val mono">{props.machine.hardwareId}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-key">HWID display</span>
                  <span class="prop-val mono">{props.machine.hwidDisplay}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-key">First seen</span>
                  <span class="prop-val">{props.machine.firstSeenAt}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-key">Approved</span>
                  <span class="prop-val">{props.machine.approvedAt ?? "-"}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-key">Last heartbeat</span>
                  <span class="prop-val">
                    {props.machine.lastHeartbeatAt ?? "-"}
                  </span>
                </div>
              </div>
              <div class="pii-row">
                <form method="post" action={`/admin/machines/${props.machine.id}/hwid`}>
                  <Csrf token={props.csrf} />
                  <button class="secondary small" type="submit">
                    <Icon name="eye" />
                    Show PII (hwid_components)
                  </button>
                </form>
                <span class="pii-note">Every reveal is audit-logged</span>
              </div>
              {props.hwidJson ? <pre class="box">{props.hwidJson}</pre> : null}
              <div class="row" style="margin-top:14px;">
                {props.machine.status === "pending" ? (
                  <form
                    method="post"
                    action={`/admin/machines/${props.machine.id}/approve`}
                  >
                    <Csrf token={props.csrf} />
                    <button class="primary" type="submit">
                      Approve machine
                    </button>
                  </form>
                ) : null}
                {props.machine.status === "pending" ||
                props.machine.status === "approved" ||
                props.machine.status === "active" ? (
                  <form
                    method="post"
                    action={`/admin/machines/${props.machine.id}/suspend`}
                  >
                    <Csrf token={props.csrf} />
                    <button class="secondary" type="submit">
                      Suspend
                    </button>
                  </form>
                ) : null}
                {props.machine.status !== "revoked" ? (
                  <form
                    method="post"
                    action={`/admin/machines/${props.machine.id}/revoke`}
                  >
                    <Csrf token={props.csrf} />
                    <button
                      class="danger"
                      type="submit"
                      data-confirm={`Revoke ${props.machine.hostname}? The machine will lose access until it is approved again.`}
                    >
                      Revoke
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
            {props.nonce ? (
              <div class="nonce-panel">
                <span class="nonce-label">
                  <Icon name="key" />
                  Enrollment nonce (shown once)
                </span>
                <span class="nonce-value">{props.nonce}</span>
              </div>
            ) : null}
          </div>
          <div class="col side">
            <div class="card">
              <h2>Activation timeline</h2>
              {(() => {
                const tl = buildTimeline(props.logs);
                return tl.length === 0 ? (
                  <p class="muted">No activity recorded yet.</p>
                ) : (
                  <ul class="timeline">
                    {tl.map((e) => (
                      <li class={e.muted ? undefined : "accent"}>
                        {e.label}
                        <div class="tl-time">{e.time}</div>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

export function UsersPage(props: {
  employeeId: string;
  csrf?: string;
  theme?: "light" | "dark" | undefined;
  users: Array<{
    id: string;
    employeeId: string;
    displayName: string;
    role: string;
    status: string;
  }>;
  flash?: string;
}) {
  return (
    <Layout
      title="Users"
      employeeId={props.employeeId}
      {...(props.csrf ? { csrf: props.csrf } : {})}
      theme={props.theme}
      activeNav="users"
    >
      <div class="page-head">
        <div>
          <h1 class="page-title">Users</h1>
          <p class="page-sub">{props.users.length} accounts in the directory</p>
        </div>
        <div class="head-actions">
          <a class="btn primary" href="/admin/users/new">
            New user
          </a>
        </div>
      </div>
      <div class="page-body">
        {props.flash ? <FlashMessage code={props.flash} /> : null}
        <div class="card table-card">
          <table>
            <thead>
              <tr>
                <th>Employee ID</th>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {props.users.map((u) => (
                <tr>
                  <td class="mono">{u.employeeId}</td>
                  <td class="wrap">{u.displayName}</td>
                  <td>{u.role}</td>
                  <td>
                    <Badge status={u.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

export function NewUserPage(props: {
  employeeId: string;
  csrf: string;
  theme?: "light" | "dark" | undefined;
  error?: string;
}) {
  return (
    <Layout
      title="New user"
      employeeId={props.employeeId}
      csrf={props.csrf}
      theme={props.theme}
      activeNav="users"
    >
      <div class="page-head">
        <div>
          <h1 class="page-title">Create user</h1>
          <p class="page-sub">
            Directory accounts bind machines to people and grant console access
            for admins.
          </p>
        </div>
      </div>
      <div class="page-body">
        {props.error ? <Flash kind="error">{props.error}</Flash> : null}
        <div class="card">
          <form class="stack" method="post" action="/admin/users">
            <Csrf token={props.csrf} />
            <label>
              Employee ID
              <input name="employee_id" required />
              <span class="field-hint">
                Stored exactly as issued - case-sensitive, no added spaces.
              </span>
            </label>
            <label>
              Display name
              <input name="display_name" required />
            </label>
            <label>
              Role
              <select name="role">
                <option value="staff">staff</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <label>
              Email (optional)
              <input name="email" type="email" />
            </label>
            <label>
              Initial password (optional; sets active for Flow B)
              <input name="initial_password" type="password" minlength={8} />
            </label>
            <button class="primary" type="submit">
              Create
            </button>
          </form>
        </div>
      </div>
    </Layout>
  );
}

export function CodesPage(props: {
  employeeId: string;
  csrf: string;
  theme?: "light" | "dark" | undefined;
  users: Array<{ id: string; label: string }>;
  codes: Array<{
    id: string;
    codeDisplay: string;
    userLabel: string;
    flow: string;
    uses: number;
    maxUses: number;
    expiresAt: string;
    revokedAt: string | null;
  }>;
  flash?: string;
  createdCode?: string;
}) {
  return (
    <Layout
      title="Codes"
      employeeId={props.employeeId}
      csrf={props.csrf}
      theme={props.theme}
      activeNav="codes"
    >
      <div class="page-head">
        <div>
          <h1 class="page-title">Enrollment codes</h1>
          <p class="page-sub">
            One-time codes that pair a workstation with a user (Flow A) or let
            the user self-provision (Flow B)
          </p>
        </div>
      </div>
      <div class="page-body">
        {props.flash ? <FlashMessage code={props.flash} /> : null}
        {props.createdCode ? (
          <Flash kind="ok">
            <span class="flash-body">
              New code (shown once):{" "}
              <span class="mono" id="new-code">
                {props.createdCode}
              </span>{" "}
              - copy it now, it will not be shown again.
            </span>
            <button
              class="secondary small copy-btn"
              type="button"
              onclick="navigator.clipboard.writeText(document.getElementById('new-code').textContent.trim());this.textContent='Copied'"
            >
              Copy
            </button>
          </Flash>
        ) : null}
        <div class="detail-grid">
          <div class="col">
            <div class="card table-card">
              <h2 style="padding:14px 16px 0;">Existing</h2>
              {props.codes.length === 0 ? (
                <p class="empty">No enrollment codes yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Display</th>
                      <th>User</th>
                      <th>Flow</th>
                      <th>Uses</th>
                      <th>Expires</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.codes.map((code) => (
                      <tr>
                        <td class="mono">{code.codeDisplay}</td>
                        <td class="wrap">{code.userLabel}</td>
                        <td>{code.flow}</td>
                        <td>
                          <span
                            class={
                              code.uses >= code.maxUses
                                ? "badge revoked"
                                : code.uses > 0
                                  ? "badge approved"
                                  : "badge neutral"
                            }
                          >
                            {code.uses}/{code.maxUses}
                          </span>
                        </td>
                        <td class="muted">{code.expiresAt}</td>
                        <td>
                          {!code.revokedAt ? (
                            <form
                              class="inline"
                              method="post"
                              action={`/admin/codes/${code.id}/revoke`}
                            >
                              <Csrf token={props.csrf} />
                              <button
                                class="danger small"
                                type="submit"
                                data-confirm="Revoke this code? Machines already activated are not affected."
                              >
                                Revoke
                              </button>
                            </form>
                          ) : (
                            <span class="muted">revoked</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div class="col side">
            <div class="card">
              <h2>Generate</h2>
              {props.users.length === 0 ? (
                <p class="muted">Create a user first before generating codes.</p>
              ) : (
                <form class="stack" method="post" action="/admin/codes">
                  <Csrf token={props.csrf} />
                  <label>
                    User
                    <select name="user_id" required>
                      {props.users.map((u) => (
                        <option value={u.id}>{u.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Flow
                    <select name="flow">
                      <option value="admin">admin</option>
                      <option value="self">self</option>
                    </select>
                  </label>
                  <label>
                    Max uses
                    <input
                      name="max_uses"
                      type="number"
                      min="1"
                      max="1000"
                      value="1"
                    />
                  </label>
                  <button class="primary" type="submit">
                    Generate code
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

export function StaleMachinesPage(props: {
  employeeId: string;
  csrf: string;
  theme?: "light" | "dark" | undefined;
  machines: Array<{
    id: string;
    hostname: string;
    userLabel: string;
    hwidDisplay: string;
    lastHeartbeatAt: string | null;
    firstSeenAt: string;
  }>;
  flash?: string;
}) {
  return (
    <Layout
      title="Stale machines"
      employeeId={props.employeeId}
      csrf={props.csrf}
      theme={props.theme}
      activeNav="reports"
    >
      <div class="page-head">
        <div>
          <h1 class="page-title">Stale machines</h1>
          <p class="page-sub">
            Active machines with no heartbeat in the last 24 hours
          </p>
        </div>
        <ExportButtons
          csvHref="/admin/reports/stale.csv"
          pdfHref="/admin/reports/summary.pdf"
        />
      </div>
      <div class="page-body">
        {props.flash ? <FlashMessage code={props.flash} /> : null}
        <div class="card table-card">
          <table>
            <thead>
              <tr>
                <th>Hostname</th>
                <th>User</th>
                <th>HWID</th>
                <th>Last heartbeat</th>
                <th>First seen</th>
              </tr>
            </thead>
            <tbody>
              {props.machines.length === 0 ? (
                <tr>
                  <td colspan={5} class="empty">
                    No stale machines. All active machines have recent
                    heartbeats.
                  </td>
                </tr>
              ) : (
                props.machines.map((m) => (
                  <tr>
                    <td>
                      <a class="host-link" href={`/admin/machines/${m.id}`}>
                        {m.hostname}
                      </a>
                    </td>
                    <td class="wrap">{m.userLabel}</td>
                    <td class="mono">{m.hwidDisplay}</td>
                    <td class="muted">{m.lastHeartbeatAt ?? "never"}</td>
                    <td class="muted">{m.firstSeenAt}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

export function KbPage(props: {
  employeeId: string;
  csrf: string;
  theme?: "light" | "dark" | undefined;
  kbEnabled: boolean;
  stats: {
    documents: number;
    sensitive: number;
    totalBytes: number;
    bySource: Record<string, number>;
  };
  documents: Array<{
    customId: string;
    title: string;
    source: string;
    docType: string;
    sensitive: boolean;
    sizeBytes: number;
    createdAt: string;
  }>;
  flash?: string;
}) {
  return (
    <Layout
      title="Knowledge base"
      employeeId={props.employeeId}
      csrf={props.csrf}
      theme={props.theme}
      activeNav="kb"
    >
      <div class="page-head">
        <div>
          <h1 class="page-title">Knowledge base</h1>
          <p class="page-sub">Org documents the AI layer can search</p>
        </div>
        <form method="post" action="/admin/kb/profiles/sync">
          <Csrf token={props.csrf} />
          <button class="primary" type="submit">
            <Icon name="refresh" />
            Sync directory profiles
          </button>
        </form>
      </div>
      <div class="page-body">
        {props.flash ? <FlashMessage code={props.flash} /> : null}
        {!props.kbEnabled ? (
          <Flash kind="warn">
            Knowledge base engine is not configured on this deployment. Uploads
            are disabled; set STAKA_KB_ENGINE_URL, STAKA_KB_ENGINE_KEY and
            STAKA_KB_SPACE to enable it.
          </Flash>
        ) : null}
        <div class="stat-row">
          <Stat value={String(props.stats.documents)} label="documents" icon="library" />
          <Stat
            value={String(props.stats.sensitive)}
            label="sensitive (admin only)"
            icon="shield"
          />
          <Stat
            value={`${(props.stats.totalBytes / 1024).toFixed(1)} KiB`}
            label="total size"
            icon="file"
          />
        </div>
        <div class="detail-grid">
          <div class="col">
            <div class="card table-card">
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Source</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Uploaded</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {props.documents.length === 0 ? (
                    <tr>
                      <td colspan={6} class="empty">
                        No documents yet. Upload org docs so agents can search
                        them.
                      </td>
                    </tr>
                  ) : (
                    props.documents.map((d) => (
                      <tr>
                        <td class="wrap">
                          {d.title}
                          {d.sensitive ? (
                            <span class="badge warn-outline" style="margin-left:8px;">
                              sensitive
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <span
                            class={`badge ${d.source === "directory" ? "approved" : "neutral"}`}
                          >
                            {d.source}
                          </span>
                        </td>
                        <td class="mono">{d.docType}</td>
                        <td class="mono">
                          {(d.sizeBytes / 1024).toFixed(1)} KiB
                        </td>
                        <td class="muted">{d.createdAt}</td>
                        <td>
                          <form
                            method="post"
                            action={`/admin/kb/documents/${encodeURIComponent(d.customId)}/delete`}
                            style="display:inline;"
                          >
                            <Csrf token={props.csrf} />
                            <button
                              class="danger small"
                              type="submit"
                              data-confirm={`Delete "${d.title}" from the knowledge base? Agents will no longer find it.`}
                            >
                              Delete
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div class="col side">
            <div class="card">
              <h2>Upload document</h2>
              {props.kbEnabled ? (
                <form
                  class="stack"
                  method="post"
                  action="/admin/kb/documents"
                  enctype="multipart/form-data"
                >
                  <Csrf token={props.csrf} />
                  <label>
                    File (markdown, text, or PDF, max 10 MiB)
                    <input type="file" name="file" accept=".md,.txt,.pdf" />
                  </label>
                  <label>
                    Title (defaults to the file name)
                    <input name="title" placeholder="Q3 reporting procedure" />
                  </label>
                  <label class="checkbox-row">
                    <input type="checkbox" name="sensitive" value="1" />
                    <span>
                      Sensitive: exclude from agent retrieval (admin preview
                      only)
                    </span>
                  </label>
                  <button class="primary" type="submit">
                    <Icon name="upload" />
                    Upload
                  </button>
                </form>
              ) : (
                <p class="muted">
                  Enable the knowledge base engine to upload documents.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

/** Resolves the dashboard theme from the request's theme cookie. */
export function themeFromCookie(cookieHeader: string | undefined): "light" | "dark" {
  return isDarkTheme(parseThemeCookie(cookieHeader)) ? "dark" : "light";
}

function parseThemeCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() === THEME_COOKIE) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export type { Child };
