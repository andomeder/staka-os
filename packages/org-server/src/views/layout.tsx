import type { Child } from "hono/jsx";

const STYLES = `
  :root {
    color-scheme: light;
    --bg: #f4f6fb;
    --card: #ffffff;
    --ink: #0f172a;
    --muted: #64748b;
    --line: #dbe3f0;
    --accent: #1E5EFF;
    --accent-ink: #ffffff;
    --danger: #b91c1c;
    --ok: #047857;
    --warn: #b45309;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
    background: var(--bg);
    color: var(--ink);
    line-height: 1.45;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  header.appbar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; margin-bottom: 24px;
  }
  .brand { font-weight: 700; letter-spacing: 0.02em; }
  .brand span { color: var(--accent); }
  nav { display: flex; gap: 14px; flex-wrap: wrap; }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 18px;
    margin-bottom: 16px;
  }
  h1, h2 { margin: 0 0 12px; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.1rem; }
  .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line);
    vertical-align: top; font-size: 0.95rem;
  }
  th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 0.78rem; font-weight: 600; background: #e2e8f0; color: #334155;
  }
  .badge.pending { background: #fef3c7; color: var(--warn); }
  .badge.approved { background: #dbeafe; color: #1d4ed8; }
  .badge.active { background: #d1fae5; color: var(--ok); }
  .badge.suspended { background: #fee2e2; color: var(--danger); }
  .badge.revoked { background: #e2e8f0; color: #475569; }
  .badge.invited { background: #ede9fe; color: #6d28d9; }
  form.inline { display: inline; }
  form.stack { display: grid; gap: 12px; max-width: 420px; }
  label { display: grid; gap: 4px; font-size: 0.9rem; }
  input, select, button, textarea {
    font: inherit;
  }
  input, select, textarea {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 10px;
    background: #fff;
  }
  button, .btn {
    border: 0;
    border-radius: 8px;
    padding: 8px 12px;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
    cursor: pointer;
  }
  button.secondary, .btn.secondary { background: #e2e8f0; color: var(--ink); }
  button.danger { background: var(--danger); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .flash {
    padding: 10px 12px; border-radius: 8px; margin-bottom: 12px;
    background: #dbeafe; color: #1e3a8a;
  }
  .flash.error { background: #fee2e2; color: #7f1d1d; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; }
  .copy-btn { padding: 2px 8px; font-size: 0.78rem; margin-left: 6px; }
  .timeline { list-style: none; margin: 0; padding: 0 0 0 18px; border-left: 2px solid var(--line); }
  .timeline li { position: relative; padding: 0 0 14px 14px; font-size: 0.92rem; }
  .timeline li::before {
    content: ''; position: absolute; left: -23px; top: 5px;
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent); border: 2px solid var(--card);
  }
  .timeline li.muted-dot::before { background: var(--muted); }
  .timeline .tl-time { color: var(--muted); font-size: 0.82rem; }
  pre.box {
    background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px;
    overflow: auto; font-size: 0.85rem;
  }
`;

export function Layout(props: {
  title: string;
  employeeId?: string;
  csrf?: string;
  children: Child;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · Staka Admin</title>
        <style>{STYLES}</style>
      </head>
      <body>
        <div class="wrap">
          <header class="appbar">
            <div class="brand">
              Staka <span>Admin</span>
            </div>
            {props.employeeId ? (
              <nav>
                <a href="/admin">Machines</a>
                <a href="/admin/users">Users</a>
                <a href="/admin/codes">Codes</a>
                <a href="/admin/deliveries">Deliveries</a>
                <a href="/admin/reports/stale">Reports</a>
                <span class="muted">{props.employeeId}</span>
                <form class="inline" method="post" action="/admin/logout">
                  {props.csrf ? (
                    <input type="hidden" name="csrf" value={props.csrf} />
                  ) : null}
                  <button class="secondary" type="submit">
                    Log out
                  </button>
                </form>
              </nav>
            ) : null}
          </header>
          {props.children}
        </div>
      </body>
    </html>
  );
}
