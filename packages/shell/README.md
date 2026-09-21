# Staka shell

`staka-shell` is a single long-running [Quickshell](https://quickshell.org/)
instance that hosts the Staka desktop. Hyprland autostart launches one shell
per graphical session; everything else — the bar, background switcher, panels,
the AI assistant, and overlays — runs **inside** the shell as a plugin.

This shell is a fork of the [Omarchy](https://github.com/basecamp/omarchy)
Quickshell desktop (MIT). The plugin architecture, bar, launcher, panels, and
shared UI kit are upstream Omarchy work, rebranded to Staka paths and ids.
Staka-specific additions are the `staka.ai-panel` plugin, the
`services/AgentClient.qml` transport, and the `bin/staka-*` IPC wrappers.

Hosting everything inside one shell means:

- shared services and singletons live once, not once per process
- summoning a panel is an IPC call into a process that is already running,
  not a fresh `quickshell -p ...` cold start
- third-party plugins can be loaded from disk without changing any source
  code in Staka itself

The runtime layout:

```
shell/
  shell.qml               entry point (ShellRoot)
  services/
    PluginRegistry.qml    discovers, validates plugins, looks up enabled state in shell.json
    BarWidgetRegistry.qml unified registry for bar widgets (1p + 3p)
    AgentClient.qml       localhost HTTP/SSE client for the Staka agent daemon
  plugins/
    ai-panel/             Staka assistant panel + bar button
    bar/                  first-party plugins (see plugins/README.md)
    launcher/
    menu/
    notifications/
    panels/
      audio/
      bluetooth/
      monitor/
      network/
      power/
    services/
      battery/
      guide/
      idle/
      media/
    osd/
    lock/
    background/
  bin/
    staka-shell           IPC wrapper (forwards to the running shell)
    staka-toggle-panel    Super+A handler; toggles staka.ai-panel
```

The plugin discovery path is documented in [plugins/README.md](plugins/README.md).

## Running the shell

The shell root is resolved from `STAKA_SHELL_PATH`, the directory that contains
`shell/shell.qml`. From a checkout of this repo that is the `packages/` parent:

```bash
export STAKA_SHELL_PATH=/path/to/staka-os/packages
quickshell -p "$STAKA_SHELL_PATH/shell"
```

If `STAKA_SHELL_PATH` is unset the shell falls back to the parent of its own
directory, so a checkout launched in place works without the variable.

Hyprland autostart launches the shell directly with `quickshell -p
$STAKA_SHELL_PATH/shell`. Bind Super+A to the assistant panel (Hyprland 0.56+
Lua config):

```lua
-- see hyprland/staka-keybinds.conf.lua
hyprland.bind("SUPER", "A", "exec", "staka-toggle-panel")
```

Put `shell/bin` on `PATH` (or use the absolute path to `staka-toggle-panel`).

## The AI panel

`plugins/ai-panel/` is the system-wide assistant. It is a `panel` + `bar-widget`
plugin: the bar button shows agent health and toggles the panel; the panel
streams chat from the local Staka agent daemon.

The panel talks to the agent over localhost HTTP only (`127.0.0.1:7920`, no
auth — the local user owns the process). It carries **no credentials** and
never sees the machine token or org URLs; those stay inside the agent daemon.
See `services/AgentClient.qml` for the transport and
`packages/agent/src/api/routes.ts` for the endpoint contract:

| Endpoint     | Shape                                                        |
|--------------|--------------------------------------------------------------|
| `GET /health`| `{ status, machine_id, org_name, model, skills_count, memory_entries }` |
| `GET /skills`| `[ { name, description, source, path } ]`                    |
| `POST /chat` | SSE stream; event `message`, data = JSON `AgentEvent`        |

`AgentEvent` types: `text_delta`, `tool_call_start`, `tool_call_end`, `error`,
`done`. The panel renders text deltas live, tool calls as inline chips, and a
status bar with health, model, and org. A message beginning with `/name` is an
explicit skill invocation passed through to the agent.

The bar button health dot and the panel status bar poll `GET /health` every 10s:
green = `ok`, yellow = unreachable, red = suspended/error.

## Plugin manifest

Every plugin ships a `manifest.json` describing what it is and how the
shell should load it. Minimal example:

```json
{
  "schemaVersion": 1,
  "id": "my.org.cool-clock",
  "name": "Cool clock",
  "version": "1.0.0",
  "author": "You",
  "description": "A clock that does cool things",
  "kinds": ["bar-widget"],
  "entryPoints": { "barWidget": "Widget.qml" },
  "barWidget": {
    "displayName": "Cool clock",
    "category": "Time",
    "allowMultiple": false,
    "defaults": { "format": "HH:mm" },
    "schema": [
      { "key": "format", "type": "string", "label": "Format" }
    ]
  }
}
```

Supported `kinds`:

| Kind         | What it is                                                   |
|--------------|--------------------------------------------------------------|
| `bar-widget` | A component that the active bar can drop into a section      |
| `panel`      | A persistent or summoned floating window (e.g. the AI panel) |
| `overlay`    | A fullscreen overlay (e.g. background switcher)              |
| `menu`       | A summoned menu surface                                      |
| `service`    | A headless singleton, no UI                                  |
| `bar`        | A full bar option that can replace the built-in `staka.bar` |

Only one `bar` plugin is active at a time. Missing or invalid selections fall
back to the built-in `staka.bar`, so users always have a safe path home.
Panels, overlays, and menus are loaded when summoned. Plugins that need
to outlive a single summon can set `keepLoaded: true`. First-party
services are loaded at startup.

The full schema lives in `services/PluginRegistry.qml`.

## Installing a third-party plugin

A plugin is a directory with a `manifest.json` at its root plus the QML
referenced from its `entryPoints`. Drop it into
`~/.config/staka/plugins/<plugin-id>/`, then rescan and enable it:

```
staka-shell shell rescanPlugins
staka-shell shell setPluginEnabled <id> true
```

Bar widgets also need a layout entry in `~/.config/staka/shell.json`.

> ⚠️ **Plugins run as unsandboxed code inside `staka-shell`.** Only add
> plugin code you are willing to run.

Third-party ids must be namespaced and may not use the reserved `staka.*`
prefix; the registry rejects them.

## IPC contract

The shell exposes a single `shell` IPC target plus whatever extra targets
individual plugins register (e.g. the bar's `bar` target for refresh hooks).

| Method                                   | Returns | Effect                                                |
|------------------------------------------|---------|-------------------------------------------------------|
| `ping`                                   | `ok`    | health check                                          |
| `summon <id> <payloadJson>`              | `ok` / `unknown` | load + open a panel/overlay plugin           |
| `hide <id>`                              | —       | close a previously-summoned plugin                    |
| `toggle <id> <payloadJson>`              | —       | summon if closed, hide if open                        |
| `call <id> <method> <arg>`               | string  | call a method on an already-loaded plugin             |
| `rescanPlugins`                          | —       | re-walk plugin dirs and hot-reload plugin code        |
| `reloadConfig`                           | `ok`    | reload `~/.config/staka/shell.json`                   |
| `setPluginEnabled <id> <enabled>`        | `ok` / `unknown` | flip the persisted enabled bit (see note)    |
| `listPlugins`                            | JSON    | every discovered plugin (id, name, kinds, enabled)    |

Direct invocation:

```
quickshell ipc -p $STAKA_SHELL_PATH/shell call shell ping
```

A convenience wrapper, [`bin/staka-shell`](bin/staka-shell), forwards IPC
calls to the running shell. It does not start the shell.

```
staka-shell shell ping
staka-shell shell toggle staka.ai-panel
staka-shell shell listPlugins
staka-shell shell rescanPlugins
```

**Note on `setPluginEnabled`:** the `enabled` argument is a string. Only the
literal `"true"` enables the plugin; every other value (including `"True"`,
`"1"`, `"yes"`, or omitted) disables it. This keeps the IPC surface
type-stable across QML's `string`-only IPC arguments.

## Persisted state

There is one user config file. Everything that distinguishes your
customization from the shipped defaults lives in it.

| Path                              | Owner          | Purpose                                                |
|-----------------------------------|----------------|--------------------------------------------------------|
| `~/.config/staka/shell.json`      | the shell      | full layout + per-entry settings + enabled plugin list |
| `~/.config/staka/plugins/<id>/`   | user           | drop-in third-party plugin source files                |

When the user has no `shell.json`, the shell uses the built-in defaults
verbatim (see `builtinShellConfig` in `shell.qml`). Once the user customizes
anything, `shell.json` becomes the authoritative file — defaults are **not**
deep-merged back in.

### shell.json shape

```json
{
  "version": 1,
  "idle": {
    "screensaver": 150,
    "lock": 300
  },
  "bar": {
    "id": "staka.bar",
    "position": "top",
    "transparent": false,
    "centerAnchor": "staka.clock",
    "layout": {
      "left":   [ { "id": "staka.menu" }, { "id": "staka.workspaces" } ],
      "center": [ { "id": "staka.clock", "format": "dddd HH:mm" } ],
      "right":  [ { "id": "staka.audio" }, { "id": "staka.ai-panel" } ]
    }
  },
  "plugins": []
}
```

### Storage rules

1. **The active bar option is `bar.id`.** Omit it or set it to `staka.bar`
   to use the built-in bar. Set it to another plugin id whose manifest declares
   `kind: "bar"` to replace the full bar.
2. **Every plugin instance is one entry.** Either in `bar.layout.<section>`
   for bar widgets, or in `plugins[]` for panels, overlays, services,
   menus, and anything else non-bar.
3. **Settings are inline on the entry.** No `config:` sub-object, no
   separate per-plugin settings file, no merge layers. The fields on each
   entry are the values the plugin sees.
4. **Built-in widget ids are namespaced.** Use ids such as `staka.clock`,
   `staka.audio`, and `staka.network`.
5. **Third-party enabled ⇔ present.** A third-party plugin is enabled iff
   its id appears somewhere in shell.json. First-party non-bar plugins are
   always enabled.
6. **Multiple instances** are allowed when a manifest sets
   `allowMultiple: true`. Each instance is independent.
7. **Idle timings are top-level.** `idle.screensaver` and `idle.lock`
   are seconds since user idle began.
8. **`version: 1` is required** at the top level. The shell will fall back
   to defaults rather than load an unknown version.

## Status and known gaps

This is a working fork for the Staka AI panel. The panel and bar button are
self-contained and only need the agent daemon on `127.0.0.1:7920`.

Several inherited widgets call out to `staka-*` helper commands
(`staka-shell`, `staka-menu`, `staka-notification-send`, and similar) that are
not all shipped in this package yet. The AI panel does not depend on them; the
bar toggle and panel IPC use `bin/staka-shell`, which is included. Remaining
helper commands and a full desktop integration land in a later slice.
