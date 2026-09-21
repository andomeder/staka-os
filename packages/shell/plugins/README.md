# First-party plugins

These plugins ship with Staka and are discovered by the shell at startup.
They use the same `manifest.json` contract as third-party plugins; the
only difference is that the shell flags them with `__isFirstParty: true`.
First-party non-bar plugins are always enabled; `staka.bar` is the default
bar option and becomes inactive only while a third-party `kind: "bar"` plugin is
selected. Services and keep-loaded panels are mounted at startup; other panels,
overlays, and menus are loaded on demand.

User-installed plugins live alongside these conceptually but on disk under
`~/.config/staka/plugins/<plugin-id>/` rather than in this directory.

| Plugin        | id                        | kinds                   | entry point                           |
|---------------|---------------------------|-------------------------|---------------------------------------|
| Bar           | `staka.bar`             | `bar`                   | `bar/Bar.qml`                         |
| Launcher      | `staka.launcher`        | `overlay`               | `launcher/Launcher.qml`               |
| Image picker  | `staka.image-picker`    | `overlay`               | `image-picker/ImagePicker.qml`        |
| Emojis        | `staka.emojis`          | `overlay`               | `emojis/Emojis.qml`                   |
| Clipboard mgr | `staka.clipboard`       | `overlay`               | `clipboard/Clipboard.qml`             |
| Reminders     | `staka.reminders`       | `overlay`               | `reminders/ReminderFlow.qml`          |
| Staka menu  | `staka.menu`            | `menu`, `bar-widget`    | `menu/Menu.qml`, `menu/BarWidget.qml` |
| Notifications | `staka.notifications`   | `service`, `bar-widget` | `notifications/Service.qml`, `notifications/BarWidget.qml` |
| Audio         | `staka.audio`           | `bar-widget`            | `panels/audio/Panel.qml`              |
| Bluetooth     | `staka.bluetooth`       | `bar-widget`            | `panels/bluetooth/Panel.qml`          |
| Monitor       | `staka.monitor`         | `bar-widget`            | `panels/monitor/Panel.qml`            |
| Network       | `staka.network`         | `bar-widget`            | `panels/network/Panel.qml`            |
| Power         | `staka.power`           | `bar-widget`            | `panels/power/Panel.qml`              |
| Tailscale     | `staka.tailscale`       | `bar-widget`            | `panels/tailscale/Panel.qml`          |
| Model usage   | `staka.model-usage`     | `bar-widget`            | `model-usage/Widget.qml`              |
| Weather       | `staka.weather`         | `bar-widget`            | `panels/weather/BarWidget.qml`        |
| Media         | `staka.media`           | `service`, `bar-widget` | `services/media/Service.qml`, `services/media/BarWidget.qml` |
| Battery       | `staka.battery`         | `service`               | `services/battery/Service.qml`        |
| Idle          | `staka.idle`            | `service`               | `services/idle/Service.qml`           |
| Lock screen   | `staka.lock`            | `service`               | `lock/Service.qml`                    |
| Guide overlay | `staka.guide`           | `service`               | `services/guide/Service.qml`          |
| OSD           | `staka.osd`             | `panel`                 | `osd/Osd.qml`                         |
| Polkit agent  | `staka.polkit`          | `service`               | `polkit/PolkitAgent.qml`              |

First-party bar-only widgets also carry manifests next to their QML files,
e.g. `bar/widgets/Clock.manifest.json`. Rich popup widgets live in their
own plugin directories, each with its own `manifest.json`.

## Bar

The built-in status bar and default full-bar option. Layout lives in the
top-level `bar:` subtree of `~/.config/staka/shell.json` (with the shell
providing [`config/staka/shell.json`](../../config/staka/shell.json) when
the user has no file). See [`bar/README.md`](bar/README.md) for the widget catalogue
and customization schema.

## Launcher

Quickshell-powered launcher. It uses Quickshell's native
`DesktopEntries` model for discovery/activation and renders inside the
long-running shell with the legacy launcher card dimensions, colors, row
spacing, icon sizing, and keyboard behavior. Summoned directly over shell IPC
by the `SUPER + SPACE` binding and the Staka menu Apps row.

## Image picker

Fullscreen image-grid selector overlay. Used by `staka-menu-images`
(wallpaper picker) and `staka-theme-switcher` (theme picker) and any
other caller that wants to present a directory of images with previews.

Two ways to drive it:

- Shell-level summon: `staka-shell shell summon staka.image-picker '<jsonPayload>'`.
  The payload can carry `imageDirs`, `imageRows`, `selectedImage`,
  `selectionFile`, `doneFile`, `showLabels`, `filterable`. Best for
  in-shell callers that already speak JSON.
- Direct IPC target: `staka-shell image-selector open <imageDirs> <imageRowsB64> <selectedImage> <selectionFile> <doneFile> <showLabels> <filterable>`.
  Positional args; `imageRowsB64` is base64-encoded so embedded newlines /
  tabs survive the bash argv handoff. This is what `staka-menu-images`
  uses. Colors come from the central shell theme singleton; there is no
  per-call override surface.

The selection round-trip remains file-based: callers create a
`selection_file` and `done_file` (both `mktemp`), pass the paths, and
poll `done_file` for existence. The plugin writes the chosen path into
`selection_file` and touches `done_file` when it's done. `cancel` IPC
clears it without writing a selection.

The plugin has `keepLoaded: true` so the layer-shell window survives
between summons within a single shell session.

## Lock screen

Session-lock surface using Quickshell's native `WlSessionLock` and two
separate PAM services: `staka-lock-password` for password auth and,
only when fingerprints are enrolled, `staka-lock-fingerprint` for
fingerprint auth. It mirrors the previous lock screen field dimensions,
colors, blurred wallpaper, placeholder, and Hyprland-driven corners.

## Guide overlay

The agent pointing at things on the user's own display: a transparent,
full-screen layer-shell surface per output at the overlay layer rendering a
highlight box, a fake accent-colored agent cursor, and an optional label at
compositor-native global coordinates. The surface carries an empty input
region so the compositor routes every pointer event to the windows beneath -
the user's real input is never intercepted. That property is proven on a
live session by
[`tests/guide-overlay-clickthrough/`](../tests/guide-overlay-clickthrough/).

Driven over shell IPC, target `guide` (see `bin/staka-shell`):

```bash
staka-shell guide highlight '{"x": 900, "y": 540, "w": 240, "h": 48, "label": "File > Export"}'
staka-shell guide sequence '{"steps": [{"x": 100, "y": 200, "label": "View", "durationMs": 3000}, {"x": 300, "y": 400, "label": "Sidebar"}]}'
staka-shell guide clear
```

Single highlights auto-dismiss after 10 seconds; sequence steps after 4
seconds each (per-step `durationMs` overrides). The agent's
`guide_highlight` / `guide_sequence` tools call this IPC target directly.

## Polkit agent

Theme-aware authentication dialog for privileged actions. It uses
Quickshell's native `Quickshell.Services.Polkit.PolkitAgent` backend and
runs inside the long-lived `staka-shell` process, replacing the old
`polkit-gnome-authentication-agent-1` autostart.

## Staka menu

Quickshell-powered Staka command menu.
The menu UI lives in `menu/Menu.qml` as a first-party `menu` plugin and is
summoned through the shell (`staka-shell shell summon staka.menu ...`),
so it shares the long-running `staka-shell` process instead of starting a
second Quickshell instance.

The menu definition lives outside the shell host code:

- defaults: `default/staka/staka-menu.jsonc`
- user extensions: `~/.config/staka/extensions/staka-menu.jsonc`

The shell parses both JSONC files at startup (with `watchChanges: true`
so edits take effect without a restart), evaluates `when:` / `checked:`
bash expressions in a single batched subprocess, and executes the
selected `action:` string directly via `Quickshell.execDetached`. The
long-running shell process keeps the parsed menu in memory, so the
keybind → IPC → visible path costs ~30ms cold.

## Coming soon

- `staka.theme-switcher` — folds theme switching into the shell.
