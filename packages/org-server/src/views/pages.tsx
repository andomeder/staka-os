import { Layout } from "./layout.tsx";

function Badge(props: { status: string }) {
  return <span class={`badge ${props.status}`}>{props.status}</span>;
}

function Csrf(props: { token: string }) {
  return <input type="hidden" name="csrf" value={props.token} />;
}

export function LoginPage(props: {
  csrf: string;
  error?: string;
}) {
  return (
    <Layout title="Login">
      <div class="card" style="max-width:420px;margin:48px auto;">
        <h1>Admin login</h1>
        <p class="muted">Sign in with an active admin account.</p>
        {props.error ? <div class="flash error">{props.error}</div> : null}
        <form class="stack" method="post" action="/admin/login">
          <Csrf token={props.csrf} />
          <label>
            Employee ID
            <input name="employee_id" required autocomplete="username" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              autocomplete="current-password"
            />
          </label>
          <button type="submit">Sign in</button>
        </form>
      </div>
    </Layout>
  );
}

export function MachinesPage(props: {
  employeeId: string;
  csrf: string;
  machines: Array<{
    id: string;
    hostname: string;
    status: string;
    userLabel: string;
    hwidDisplay: string;
    lastHeartbeatAt: string | null;
  }>;
  flash?: string;
}) {
  return (
    <Layout title="Machines" employeeId={props.employeeId} csrf={props.csrf}>
      <div class="card">
        <h1>Machines</h1>
        {props.flash ? <div class="flash">{props.flash}</div> : null}
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
                <td colspan={6} class="muted">
                  No machines yet.
                </td>
              </tr>
            ) : (
              props.machines.map((m) => (
                <tr>
                  <td>
                    <a href={`/admin/machines/${m.id}`}>{m.hostname}</a>
                  </td>
                  <td>
                    <Badge status={m.status} />
                  </td>
                  <td>{m.userLabel}</td>
                  <td class="mono">{m.hwidDisplay}</td>
                  <td class="muted">{m.lastHeartbeatAt ?? "—"}</td>
                  <td>
                    <div class="row">
                      {m.status === "pending" ? (
                        <form
                          class="inline"
                          method="post"
                          action={`/admin/machines/${m.id}/approve`}
                        >
                          <Csrf token={props.csrf} />
                          <button type="submit">Approve</button>
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
                          <button class="secondary" type="submit">
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
                          <button class="danger" type="submit">
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
        : `${heartbeats.length} heartbeats (${first} → ${last})`;
    entries.push({ label: summary, time: first, muted: true });
  }
  entries.sort((a, b) => a.time.localeCompare(b.time));
  return entries;
}

export function MachineDetailPage(props: {
  employeeId: string;
  csrf: string;
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
    >
      <div class="card">
        <div class="row" style="justify-content:space-between;">
          <h1>{props.machine.hostname}</h1>
          <Badge status={props.machine.status} />
        </div>
        {props.flash ? <div class="flash">{props.flash}</div> : null}
        {props.nonce ? (
          <div class="flash">
            Enrollment nonce (shown once):{" "}
            <span class="mono">{props.nonce}</span>
          </div>
        ) : null}
        <p>
          <span class="muted">Bound user:</span> {props.userLabel}
        </p>
        <p>
          <span class="muted">Hardware ID:</span>{" "}
          <span class="mono">{props.machine.hardwareId}</span>
        </p>
        <p>
          <span class="muted">HWID display:</span>{" "}
          <span class="mono">{props.machine.hwidDisplay}</span>
        </p>
        <p>
          <span class="muted">Flow:</span> {props.machine.provisionFlow}
        </p>
        <p>
          <span class="muted">First seen:</span> {props.machine.firstSeenAt}
        </p>
        <p>
          <span class="muted">Approved:</span>{" "}
          {props.machine.approvedAt ?? "—"}
        </p>
        <p>
          <span class="muted">Last heartbeat:</span>{" "}
          {props.machine.lastHeartbeatAt ?? "—"}
        </p>
        <div class="row">
          {props.machine.status === "pending" ? (
            <form
              method="post"
              action={`/admin/machines/${props.machine.id}/approve`}
            >
              <Csrf token={props.csrf} />
              <button type="submit">Approve</button>
            </form>
          ) : null}
          <form
            method="post"
            action={`/admin/machines/${props.machine.id}/hwid`}
          >
            <Csrf token={props.csrf} />
            <button class="secondary" type="submit">
              Show PII (hwid_components)
            </button>
          </form>
        </div>
        {props.hwidJson ? (
          <pre class="box">{props.hwidJson}</pre>
        ) : null}
      </div>
      <div class="card">
        <h2>Activation timeline</h2>
        {(() => {
          const tl = buildTimeline(props.logs);
          return tl.length === 0 ? (
            <p class="muted">No activity recorded yet.</p>
          ) : (
            <ul class="timeline">
              {tl.map((e) => (
                <li class={e.muted ? "muted-dot" : undefined}>
                  {e.label}
                  <div class="tl-time">{e.time}</div>
                </li>
              ))}
            </ul>
          );
        })()}
      </div>
    </Layout>
  );
}

export function UsersPage(props: {
  employeeId: string;
  csrf?: string;
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
    >
      <div class="card">
        <div class="row" style="justify-content:space-between;">
          <h1>Users</h1>
          <a class="btn" href="/admin/users/new">
            New user
          </a>
        </div>
        {props.flash ? <div class="flash">{props.flash}</div> : null}
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
                <td>{u.displayName}</td>
                <td>{u.role}</td>
                <td>
                  <Badge status={u.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

export function NewUserPage(props: {
  employeeId: string;
  csrf: string;
  error?: string;
}) {
  return (
    <Layout title="New user" employeeId={props.employeeId} csrf={props.csrf}>
      <div class="card">
        <h1>Create user</h1>
        {props.error ? <div class="flash error">{props.error}</div> : null}
        <form class="stack" method="post" action="/admin/users">
          <Csrf token={props.csrf} />
          <label>
            Employee ID
            <input name="employee_id" required />
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
          <button type="submit">Create</button>
        </form>
      </div>
    </Layout>
  );
}

export function CodesPage(props: {
  employeeId: string;
  csrf: string;
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
    <Layout title="Codes" employeeId={props.employeeId} csrf={props.csrf}>
      <div class="card">
        <h1>Enrollment codes</h1>
        {props.flash ? <div class="flash">{props.flash}</div> : null}
        {props.createdCode ? (
          <div class="flash">
            New code (shown once):{" "}
            <span class="mono" id="new-code">{props.createdCode}</span>{" "}
            <button
              class="secondary copy-btn"
              type="button"
              onclick="navigator.clipboard.writeText(document.getElementById('new-code').textContent.trim());this.textContent='Copied'"
            >
              Copy
            </button>
          </div>
        ) : null}
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
            <input name="max_uses" type="number" min="1" max="1000" value="1" />
          </label>
          <button type="submit">Generate code</button>
        </form>
        )}
      </div>
      <div class="card">
        <h2>Existing</h2>
        {props.codes.length === 0 ? (
          <p class="muted">No enrollment codes yet.</p>
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
                <td>{code.userLabel}</td>
                <td>{code.flow}</td>
                <td>
                  <span class={code.uses >= code.maxUses ? "badge revoked" : code.uses > 0 ? "badge approved" : "badge"}>
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
                      <button class="danger" type="submit" onclick="return confirm('Revoke this code? Machines already activated are not affected.')">
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
    </Layout>
  );
}

export function StaleMachinesPage(props: {
  employeeId: string;
  csrf: string;
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
    <Layout title="Stale machines" employeeId={props.employeeId} csrf={props.csrf}>
      <div class="card">
        <h1>Stale machines</h1>
        <p class="muted">
          Active machines with no heartbeat in the last 24 hours.
        </p>
        {props.flash ? <div class="flash">{props.flash}</div> : null}
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
                <td colspan={5} class="muted">
                  No stale machines. All active machines have recent heartbeats.
                </td>
              </tr>
            ) : (
              props.machines.map((m) => (
                <tr>
                  <td>
                    <a href={`/admin/machines/${m.id}`}>{m.hostname}</a>
                  </td>
                  <td>{m.userLabel}</td>
                  <td class="mono">{m.hwidDisplay}</td>
                  <td class="muted">{m.lastHeartbeatAt ?? "never"}</td>
                  <td class="muted">{m.firstSeenAt}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

export function DeliveriesPage(props: {
  employeeId: string;
  csrf: string;
  deliveries: Array<{
    id: string;
    summary: string;
    artifactRef: string | null;
    fromHostname: string | null;
    toUserLabel: string;
    createdAt: string;
  }>;
  flash?: string;
}) {
  return (
    <Layout title="Deliveries" employeeId={props.employeeId} csrf={props.csrf}>
      <div class="card">
        <h1>Deliveries</h1>
        <p class="muted">
          Artifacts and summaries agents have delivered to org members on
          behalf of their machines.
        </p>
        {props.flash ? <div class="flash">{props.flash}</div> : null}
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>To</th>
              <th>From machine</th>
              <th>Summary</th>
              <th>Artifact</th>
            </tr>
          </thead>
          <tbody>
            {props.deliveries.length === 0 ? (
              <tr>
                <td colspan={5} class="muted">
                  No deliveries recorded yet.
                </td>
              </tr>
            ) : (
              props.deliveries.map((d) => (
                <tr>
                  <td class="muted">{d.createdAt}</td>
                  <td>{d.toUserLabel}</td>
                  <td>{d.fromHostname ?? "unknown"}</td>
                  <td>{d.summary}</td>
                  <td class="mono">{d.artifactRef ?? "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}
