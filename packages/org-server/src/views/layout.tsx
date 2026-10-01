import { raw } from "hono/html";
import type { Child } from "hono/jsx";
/**
 * Shared presentation tokens for the admin dashboard.
 *
 * Light is the primary theme (Design A "Ledger"); dark ("Midnight") is the
 * dark-mode variant. Values mirror the approved canvas mocks, tuned up for
 * projector visibility: stronger borders, larger type, defined surfaces.
 */
const TOKENS = {
  light: {
    bg: "#F2F4F8",
    panel: "#FFFFFF",
    panelAlt: "#F7F8FA",
    inset: "#EDF0F5",
    ink: "#101828",
    inkSoft: "#2B3648",
    muted: "#5A6474",
    faint: "#7D8798",
    line: "#C6CEdb",
    lineSoft: "#D8DEE8",
    accent: "#0062FF",
    accentDeep: "#1849A9",
    accentSoft: "#E9F0FF",
    ok: "#067647",
    okBg: "#E8F6EE",
    okBorder: "#9ED8B9",
    warn: "#9A4A08",
    warnBg: "#FDF2E0",
    warnBorder: "#EBC68F",
    danger: "#B42318",
    dangerBg: "#FDEEED",
    dangerBorder: "#EFC1BD",
    ghost: "#EDF0F5",
    ghostInk: "#3D4759",
  },
  dark: {
    bg: "#0B1220",
    panel: "#101724",
    panelAlt: "#131C2C",
    inset: "#18233A",
    ink: "#E8EEF9",
    inkSoft: "#C7D1E0",
    muted: "#9AA8C0",
    faint: "#6B7C99",
    line: "#2B3852",
    lineSoft: "#1F2A40",
    accent: "#1E5EFF",
    accentDeep: "#7EA6FF",
    accentSoft: "#16233E",
    ok: "#4ADE80",
    okBg: "#0F2C1E",
    okBorder: "#1F5B3B",
    warn: "#FBBF24",
    warnBg: "#2A2010",
    warnBorder: "#6B5318",
    danger: "#F87171",
    dangerBg: "#2E181B",
    dangerBorder: "#54282C",
    ghost: "#18233A",
    ghostInk: "#C7D1E0",
  },
} as const;

type ThemeName = keyof typeof TOKENS;

function cssVars(t: (typeof TOKENS)[ThemeName]): string {
  return [
    `--bg:${t.bg}`,
    `--panel:${t.panel}`,
    `--panel-alt:${t.panelAlt}`,
    `--inset:${t.inset}`,
    `--ink:${t.ink}`,
    `--ink-soft:${t.inkSoft}`,
    `--muted:${t.muted}`,
    `--faint:${t.faint}`,
    `--line:${t.line}`,
    `--line-soft:${t.lineSoft}`,
    `--accent:${t.accent}`,
    `--accent-deep:${t.accentDeep}`,
    `--accent-soft:${t.accentSoft}`,
    `--ok:${t.ok}`,
    `--ok-bg:${t.okBg}`,
    `--ok-border:${t.okBorder}`,
    `--warn:${t.warn}`,
    `--warn-bg:${t.warnBg}`,
    `--warn-border:${t.warnBorder}`,
    `--danger:${t.danger}`,
    `--danger-bg:${t.dangerBg}`,
    `--danger-border:${t.dangerBorder}`,
    `--ghost:${t.ghost}`,
    `--ghost-ink:${t.ghostInk}`,
  ].join(";");
}

/**
 * The current theme's variables go on the unprefixed selector so SSR paints
 * correctly before JS runs. The OPPOSITE theme is emitted under its
 * `data-theme` attribute selector, so the client-side toggle (which flips
 * the attribute) has a real palette to switch to. Wrapped in raw() because
 * hono escapes double quotes inside style children, which breaks selectors.
 */
function themeStylesheet(current: "light" | "dark"): string {
  const opposite = current === "light" ? "dark" : "light";
  return [
    `:root{${cssVars(TOKENS[current])}}`,
    `html[data-theme="${opposite}"]{${cssVars(TOKENS[opposite])}}`,
  ].join("");
}

const STYLES = `
  :root {
    color-scheme: light dark;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--ink);
    line-height: 1.5;
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  svg { display: inline-block; vertical-align: middle; }

  .app { display: flex; min-height: 100vh; }

  /* Sidebar */
  .sidebar {
    width: 248px; flex-shrink: 0;
    display: flex; flex-direction: column; gap: 4px;
    padding: 22px 16px 18px;
    background: var(--panel);
    border-right: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 20px; }
  .brand svg { flex-shrink: 0; }
  .brand-name { font-weight: 700; letter-spacing: -0.02em; font-size: 17px; color: var(--ink); }
  .brand-admin { font-weight: 500; font-size: 17px; color: var(--faint); }
  .nav-item {
    display: flex; align-items: center; gap: 11px;
    height: 42px; padding: 0 12px;
    border-radius: 8px;
    color: var(--muted); font-size: 14.5px; font-weight: 500;
  }
  .nav-item svg { width: 17px; height: 17px; flex-shrink: 0; }
  .nav-item:hover { background: var(--inset); color: var(--ink); text-decoration: none; }
  .nav-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .sidebar-spacer { flex: 1; }
  .identity {
    padding: 11px 12px; border-radius: 8px;
    background: var(--inset);
    display: flex; flex-direction: column; gap: 2px;
  }
  .identity-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; font-weight: 600; color: var(--ink-soft); }
  .identity-role { font-size: 12px; color: var(--faint); }
  .logout-form { margin: 0; }
  .logout-btn {
    margin-top: 8px; width: 100%;
    border: 1px solid var(--line); border-radius: 8px;
    padding: 9px 12px; background: transparent; color: var(--muted);
    font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer;
  }
  .logout-btn:hover { color: var(--ink); border-color: var(--faint); }
  .theme-toggle {
    margin-top: 8px; width: 100%; height: 38px;
    background: transparent; border: 1px solid var(--line); border-radius: 8px;
    color: var(--muted); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    font: inherit; font-size: 13px; font-weight: 500;
  }
  .theme-toggle:hover { color: var(--ink); border-color: var(--faint); }
  .theme-toggle svg { width: 16px; height: 16px; }
  html[data-theme="light"] .theme-toggle .icon-sun { display: none; }
  html[data-theme="dark"] .theme-toggle .icon-sun { display: inline; }
  html[data-theme="dark"] .theme-toggle .icon-moon { display: none; }
  html[data-theme="light"] .theme-toggle .icon-moon { display: inline; }

  /* Main column */
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .page-head {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 28px 40px 16px;
    flex-wrap: wrap;
  }
  .page-title { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .page-sub { margin: 4px 0 0; font-size: 14.5px; color: var(--muted); }
  .page-head-row { display: flex; align-items: center; gap: 14px; }
  .head-actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .page-body { padding: 10px 40px 36px; flex: 1; min-width: 0; }

  /* Buttons */
  button, .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    font: inherit; font-size: 14px; font-weight: 600;
    border-radius: 8px; padding: 9px 16px; cursor: pointer;
    border: 1px solid transparent;
    text-decoration: none;
  }
  button.primary, .btn.primary { background: var(--accent); color: #fff; }
  button.primary:hover, .btn.primary:hover { filter: brightness(1.08); text-decoration: none; }
  button.secondary, .btn.secondary {
    background: var(--panel); color: var(--ink);
    border-color: var(--line);
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
  }
  button.secondary:hover, .btn.secondary:hover { border-color: var(--faint); text-decoration: none; }
  button.danger, .btn.danger { background: transparent; color: var(--danger); border-color: var(--danger-border); }
  button.danger:hover, .btn.danger:hover { background: var(--danger-bg); }
  button.danger-solid { background: var(--danger); color: #fff; }
  button.danger-solid:hover { filter: brightness(1.08); }
  button.small { padding: 6px 13px; font-size: 13px; border-radius: 7px; }
  button svg { width: 15px; height: 15px; flex-shrink: 0; }
  button:disabled { opacity: 0.6; cursor: default; }

  /* Stat row */
  .stat-row { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat {
    flex: 1; min-width: 150px;
    display: flex; align-items: center; gap: 13px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 15px 18px;
    box-shadow: 0 1px 3px rgba(16, 24, 40, 0.07);
  }
  .stat-icon {
    width: 40px; height: 40px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
    border-radius: 9px; color: var(--accent);
  }
  .stat-icon svg { width: 19px; height: 19px; }
  .stat-value { font-size: 23px; font-weight: 700; letter-spacing: -0.02em; }
  .stat-label { font-size: 13px; color: var(--muted); }

  /* Cards */
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 20px; margin-bottom: 18px;
    box-shadow: 0 1px 3px rgba(16, 24, 40, 0.07);
  }
  .card h1 { margin: 0 0 4px; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
  .card h2 { margin: 0 0 14px; font-size: 16.5px; font-weight: 700; }
  .card-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-bottom: 16px; flex-wrap: wrap;
  }

  /* Tables */
  .table-card { padding: 0; overflow: auto; }
  .table-card table { margin: 0; }
  .table-title { padding: 16px 20px 2px; }
  .table-title h2 { margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left; padding: 13px 20px; border-bottom: 1px solid var(--line-soft);
    vertical-align: middle; font-size: 14.5px;
  }
  tr:last-child td { border-bottom: 0; }
  th {
    color: var(--muted); font-weight: 700; font-size: 11.5px;
    text-transform: uppercase; letter-spacing: 0.09em;
    background: var(--panel-alt);
    border-bottom: 2px solid var(--line);
    white-space: nowrap;
  }
  td.wrap { white-space: normal; word-break: break-word; }
  .host-link { font-weight: 600; color: var(--ink); }
  .host-link:hover { color: var(--accent); }

  /* Badges */
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 11px; border-radius: 999px;
    font-size: 12.5px; font-weight: 700;
    border: 1px solid color-mix(in srgb, currentColor 32%, transparent);
  }
  .badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .badge.pending, .badge.suspended { background: var(--warn-bg); color: var(--warn); }
  .badge.active { background: var(--ok-bg); color: var(--ok); }
  .badge.approved { background: var(--accent-soft); color: var(--accent); }
  .badge.revoked { background: var(--inset); color: var(--faint); }
  .badge.invited { background: var(--accent-soft); color: var(--accent); }
  .badge.neutral { background: var(--inset); color: var(--ghost-ink); }
  .badge.warn-outline { background: transparent; border: 1px solid var(--warn); color: var(--warn); }

  /* Forms */
  form.inline { display: inline; margin: 0; }
  form.stack { display: grid; gap: 16px; max-width: 460px; }
  label { display: grid; gap: 6px; font-size: 13.5px; font-weight: 600; color: var(--muted); }
  input, select, textarea {
    font: inherit; font-size: 14.5px; font-weight: 400;
    border: 1px solid var(--line); border-radius: 8px;
    padding: 10px 13px;
    background: var(--panel); color: var(--ink);
  }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
  }
  .field-hint { font-size: 12.5px; color: var(--faint); font-weight: 400; }
  .checkbox-row { display: flex; align-items: flex-start; gap: 9px; }
  .checkbox-row input { width: 16px; height: 16px; margin-top: 2px; }
  .checkbox-row span { font-size: 13.5px; font-weight: 400; color: var(--muted); }

  /* Password reveal */
  .pw-wrap { position: relative; display: flex; }
  .pw-wrap input { width: 100%; padding-right: 46px; }
  .pw-eye {
    position: absolute; right: 7px; top: 50%; transform: translateY(-50%);
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: 0; border-radius: 7px;
    color: var(--faint); cursor: pointer; padding: 0;
  }
  .pw-eye:hover { color: var(--ink); background: var(--inset); }
  .pw-eye svg { width: 18px; height: 18px; }
  .pw-eye .icon-eye-off { display: none; }
  .pw-wrap.revealed .icon-eye { display: none; }
  .pw-wrap.revealed .icon-eye-off { display: block; }

  /* Login */
  .login-shell {
    min-height: 100vh;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 24px; padding: 40px 16px;
  }
  .login-card {
    width: 100%; max-width: 470px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 36px 36px 28px;
    display: flex; flex-direction: column; gap: 20px;
    box-shadow: 0 4px 24px rgba(16, 24, 40, 0.10);
  }
  .login-brand { display: flex; align-items: center; gap: 10px; }
  .login-title { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
  .login-accent {
    width: 46px; height: 4px; border-radius: 2px;
    background: var(--accent);
    margin-bottom: 14px;
  }
  .login-sub { margin: 0; font-size: 14.5px; color: var(--muted); }
  .login-foot { display: flex; flex-direction: column; gap: 4px; }
  .login-foot p { margin: 0; font-size: 13px; color: var(--faint); }
  .login-version { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: var(--faint); }

  /* Flash banners */
  .flash {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 13px 16px; border-radius: 9px; margin-bottom: 16px;
    font-size: 14.5px; font-weight: 600;
    border: 1px solid var(--line);
    border-left-width: 4px;
    background: var(--panel-alt); color: var(--ink-soft);
  }
  .flash svg { width: 18px; height: 18px; flex-shrink: 0; margin-top: 1px; }
  .flash.ok { background: var(--ok-bg); color: var(--ok); border-color: var(--ok-border); border-left-color: var(--ok); }
  .flash.warn { background: var(--warn-bg); color: var(--warn); border-color: var(--warn-border); border-left-color: var(--warn); }
  .flash.error { background: var(--danger-bg); color: var(--danger); border-color: var(--danger-border); border-left-color: var(--danger); }
  .flash .mono { font-weight: 700; }
  .flash .flash-body { flex: 1; }
  .flash button { margin-left: 8px; }

  /* Misc */
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .row.spread { justify-content: space-between; }
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92rem; }
  .copy-btn { padding: 3px 10px; font-size: 12.5px; margin-left: 8px; }
  .empty { padding: 36px 18px; text-align: center; color: var(--muted); font-size: 14.5px; }

  /* Detail pages */
  .detail-grid { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; }
  .detail-grid > .col { flex: 1 1 400px; min-width: 0; }
  .detail-grid > .col.side { flex: 0 1 460px; }
  .prop-list { display: flex; flex-direction: column; gap: 0; }
  .prop-row {
    display: flex; justify-content: space-between; gap: 16px; align-items: center;
    padding: 10px 0; border-bottom: 1px solid var(--line-soft);
  }
  .prop-row:last-child { border-bottom: 0; }
  .prop-key { color: var(--muted); font-size: 14px; }
  .prop-val { font-size: 14px; font-weight: 600; text-align: right; word-break: break-all; }
  .pii-row {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    margin-top: 16px; padding: 12px 14px;
    background: var(--inset); border: 1px solid var(--line-soft); border-radius: 9px;
  }
  .pii-note { font-size: 13px; color: var(--faint); }
  .nonce-panel {
    margin-top: 0; padding: 15px 18px;
    background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: 10px; margin-bottom: 18px;
    display: flex; flex-direction: column; gap: 7px;
  }
  .nonce-label { display: flex; align-items: center; gap: 9px; font-size: 13.5px; font-weight: 700; color: var(--accent-deep); }
  .nonce-label svg { width: 17px; height: 17px; }
  .nonce-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 18px; font-weight: 700; }

  /* Timeline */
  .timeline { list-style: none; margin: 0; padding: 0; }
  .timeline li {
    position: relative; padding: 0 0 18px 24px; font-size: 14px; font-weight: 500;
  }
  .timeline li::before {
    content: ''; position: absolute; left: 0; top: 4px;
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--line); border: 2px solid var(--panel);
    box-shadow: 0 0 0 1px var(--line);
  }
  .timeline li.accent::before { background: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .timeline li:not(:last-child)::after {
    content: ''; position: absolute; left: 4.5px; top: 17px; bottom: -2px;
    width: 1px; background: var(--line-soft);
  }
  .timeline .tl-time { color: var(--faint); font-size: 12px; font-weight: 400; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  pre.box {
    background: var(--panel-alt); border: 1px solid var(--line);
    color: var(--ink); padding: 14px; border-radius: 9px;
    overflow: auto; font-size: 0.88rem;
  }

  /* Confirm modal (replaces native window.confirm) */
  .confirm-overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(8, 12, 20, 0.58);
    backdrop-filter: blur(2px);
    display: none; align-items: center; justify-content: center;
    padding: 16px;
  }
  .confirm-overlay.open { display: flex; }
  .confirm-card {
    width: 100%; max-width: 440px;
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 14px; padding: 26px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
  }
  .confirm-icon {
    width: 44px; height: 44px; border-radius: 11px;
    background: var(--danger-bg); border: 1px solid var(--danger-border);
    color: var(--danger);
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 14px;
  }
  .confirm-icon svg { width: 21px; height: 21px; }
  .confirm-card h2 { margin: 0 0 8px; font-size: 18px; font-weight: 700; }
  .confirm-card p { margin: 0 0 22px; font-size: 14.5px; color: var(--muted); line-height: 1.55; }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }

  @media (max-width: 800px) {
    .app { flex-direction: column; }
    .sidebar { width: 100%; flex-direction: row; flex-wrap: wrap; align-items: center; }
    .brand { padding: 0 10px 0 0; }
    .sidebar-spacer { display: none; }
    .theme-toggle { width: 38px; height: 38px; }
    .theme-toggle .toggle-label { display: none; }
    .page-head, .page-body { padding-left: 18px; padding-right: 18px; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
`;

/** Inline SVG icon set (lucide-style paths, stroke-based). */
const ICONS = {
  monitor:
    '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  users:
    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  key: '<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  library:
    '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  alert:
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
} as const;

export type IconName = keyof typeof ICONS;

function Html(props: { children: string }) {
  return raw(props.children);
}

export function Icon(props: { name: IconName; size?: number }) {
  const size = props.size ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Html>{ICONS[props.name]}</Html>
    </svg>
  );
}

/** Inline SVG glyph selected by CSS class (eye/theme swap uses CSS display). */
export function CssIcon(props: { kind: "eye" | "eyeOff" | "moon" | "sun" }) {
  const cls =
    props.kind === "eye"
      ? "icon-eye"
      : props.kind === "eyeOff"
        ? "icon-eye-off"
        : props.kind === "moon"
          ? "icon-moon"
          : "icon-sun";
  const path = ICONS[props.kind === "eye" ? "eye" : props.kind === "eyeOff" ? "eyeOff" : props.kind];
  return (
    <svg
      class={cls}
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Html>{path}</Html>
    </svg>
  );
}

export function StakaMark(props: { height?: number }) {
  const h = props.height ?? 20;
  return (
    <svg
      width={(h * 44) / 36}
      height={h}
      viewBox="0 0 44 36"
      aria-hidden="true"
    >
      <rect x="0" y="0" width="36" height="9" rx="2" fill="#1E5EFF" />
      <rect x="8" y="13.5" width="36" height="9" rx="2" fill="#3B7BFF" />
      <rect x="0" y="27" width="36" height="9" rx="2" fill="#0B2F8A" />
    </svg>
  );
}

const THEME_COOKIE = "staka_admin_theme";

export function isDarkTheme(cookieValue: string | undefined): boolean {
  return cookieValue === "dark";
}

export { THEME_COOKIE };

function clientScript(): string {
  // Runs at the END of <body>, so every element it binds exists.
  // 1) theme: apply stored/system theme, wire the toggle (cookie persists it
  //    so SSR picks it up on the next full page load)
  // 2) password eye toggle on the login page
  // 3) in-page confirm modal for forms marked with data-confirm
  return `(function(){
  try {
    var m = document.cookie.match(/(?:^|; )${THEME_COOKIE}=(dark|light)/);
    var t = m ? m[1] : null;
    if (!t) {
      t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', function(){
        var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        var next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        document.cookie = '${THEME_COOKIE}=' + next + ';path=/;max-age=31536000;samesite=strict';
      });
    }
    var pw = document.getElementById('pw-field');
    if (pw) {
      var wrap = pw.closest('.pw-wrap');
      var eye = document.getElementById('pw-eye');
      if (eye) {
        eye.addEventListener('click', function(){
          var hidden = pw.getAttribute('type') === 'password';
          pw.setAttribute('type', hidden ? 'text' : 'password');
          wrap.classList.toggle('revealed', hidden);
          pw.focus();
        });
      }
    }
    var overlay = document.getElementById('confirm-overlay');
    if (overlay) {
      var msg = document.getElementById('confirm-message');
      var ok = document.getElementById('confirm-ok');
      var cancel = document.getElementById('confirm-cancel');
      var pending = null;
      var open = function(e, form){
        e.preventDefault();
        pending = form;
        msg.textContent = form.getAttribute('data-confirm') || 'Are you sure?';
        overlay.classList.add('open');
        ok.focus();
      };
      document.querySelectorAll('form[data-confirm]').forEach(function(form){
        form.addEventListener('submit', function(e){ open(e, form); });
      });
      ok.addEventListener('click', function(){
        overlay.classList.remove('open');
        if (pending) { var f = pending; pending = null; f.submit(); }
      });
      var close = function(){ overlay.classList.remove('open'); pending = null; };
      cancel.addEventListener('click', close);
      overlay.addEventListener('click', function(e){ if (e.target === overlay) close(); });
      document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
    }
  } catch (e) {}
})();`;
}

export function Layout(props: {
  title: string;
  employeeId?: string | undefined;
  csrf?: string | undefined;
  theme?: "light" | "dark" | undefined;
  activeNav?: "machines" | "users" | "codes" | "kb" | "reports" | undefined;
  children: Child;
}) {
  const theme = props.theme ?? "light";
  const navItems: Array<{
    href: string;
    label: string;
    icon: IconName;
    key: "machines" | "users" | "codes" | "kb" | "reports";
  }> = [
    { href: "/admin", label: "Machines", icon: "monitor", key: "machines" },
    { href: "/admin/users", label: "Users", icon: "users", key: "users" },
    { href: "/admin/codes", label: "Codes", icon: "key", key: "codes" },
    { href: "/admin/kb", label: "Knowledge base", icon: "library", key: "kb" },
    {
      href: "/admin/reports/stale",
      label: "Reports",
      icon: "chart",
      key: "reports",
    },
  ];

  return (
    <html lang="en" data-theme={theme}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · Staka Admin</title>
        <style>{raw(`${themeStylesheet(theme)}${STYLES}`)}</style>
      </head>
      <body>
        {props.employeeId ? (
          <div class="app">
            <aside class="sidebar">
              <div class="brand">
                <StakaMark height={22} />
                <span class="brand-name">staka</span>
                <span class="brand-admin">admin</span>
              </div>
              {navItems.map((item) => (
                <a
                  class={`nav-item${props.activeNav === item.key ? " active" : ""}`}
                  href={item.href}
                >
                  <Icon name={item.icon} />
                  {item.label}
                </a>
              ))}
              <div class="sidebar-spacer" />
              <div class="identity">
                <span class="identity-id">{props.employeeId}</span>
                <span class="identity-role">administrator</span>
              </div>
              <form class="logout-form" method="post" action="/admin/logout">
                {props.csrf ? (
                  <input type="hidden" name="csrf" value={props.csrf} />
                ) : null}
                <button class="logout-btn" type="submit">
                  Log out
                </button>
              </form>
              <button
                id="theme-toggle"
                class="theme-toggle"
                type="button"
                aria-label="Toggle color theme"
                title="Toggle color theme"
              >
                <CssIcon kind="moon" />
                <CssIcon kind="sun" />
                <span class="toggle-label">Theme</span>
              </button>
            </aside>
            <div class="main">
              {props.children}
            </div>
            <div
              class="confirm-overlay"
              id="confirm-overlay"
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
            >
              <div class="confirm-card">
                <div class="confirm-icon">
                  <Icon name="alert" />
                </div>
                <h2 id="confirm-title">Please confirm</h2>
                <p id="confirm-message"></p>
                <div class="confirm-actions">
                  <button id="confirm-cancel" class="secondary" type="button">
                    Cancel
                  </button>
                  <button id="confirm-ok" class="danger-solid" type="button">
                    Confirm
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div class="login-shell">
            <div class="login-brand">
              <StakaMark height={24} />
              <span class="brand-name">staka</span>
              <span class="brand-admin">admin</span>
            </div>
            {props.children}
          </div>
        )}
        <script>{raw(clientScript())}</script>
      </body>
    </html>
  );
}

/** Styled flash banner with an icon. */
export function Flash(props: {
  kind?: "ok" | "warn" | "error";
  children: Child;
}) {
  const kind = props.kind;
  const icon: IconName = kind === "ok" ? "check" : "alert";
  return (
    <div class={`flash${kind ? ` ${kind}` : ""}`}>
      <Icon name={icon} />
      <div class="flash-body">{props.children}</div>
    </div>
  );
}
