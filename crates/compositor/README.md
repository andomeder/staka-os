# staka-compositor

Headless workspace compositor driver for the Staka desktop. It gives the
agent an isolated Wayland workspace: an invisible Hyprland headless output
hosting a nested compositor, so agent input never reaches the user's
physical seat.

This crate is the one Rust component in Staka. It talks Wayland protocols
directly and shells out to `hyprctl` for compositor control; everything else
in Staka is TypeScript and communicates with this driver over a local Unix
socket.

## Layout

- `src/ipc.rs` - length-prefixed frame protocol and control message types
- `src/hyprctl.rs` - `hyprctl` wrapper: headless output create/remove, output
  and workspace listing, dispatchers (auto-detects the legacy and Lua IPC
  syntaxes of Hyprland 0.55+)
- `src/workspace.rs` - agent workspace selection, adoption, pinning, and
  layout restore on teardown
- `src/cage.rs` - nested cage compositor lifecycle: spawn, socket wait,
  clean termination
- `src/screencopy.rs` - PNG capture of the headless output via `grim`
- `src/server.rs` - Unix socket server dispatching commands
- `src/main.rs` - `staka-compositor` binary
- `tests/integration_hyprland.rs` - tests that need a live Hyprland session

## Build and test

```sh
cd crates
cargo build
cargo test
```

Integration tests (run from inside a Hyprland session, they create and
remove one invisible headless output):

```sh
cargo test --features integration --test integration_hyprland
```

## Socket protocol

Unix socket (default `$XDG_RUNTIME_DIR/staka/compositor.sock`). Frames in
both directions:

```
[1 byte type][4 bytes big-endian payload length][payload]
'J' (0x4A): UTF-8 JSON control message
'B' (0x42): raw bytes (e.g. a PNG screenshot)
```

Requests are `{"id": N, "cmd": "<name>", "args": {...}}`; responses echo the
id as `{"id": N, "ok": true, ...}` or `{"id": N, "ok": false, "error": "..."}`.
A response whose data contains `"binary": true` is followed by one `B` frame.

Commands:

| cmd | args | notes |
|---|---|---|
| `create_workspace` | `{ "app": "..." }` | headless output + dedicated agent workspace; with `app`, launches cage with that app inside. Returns `{ "output": "HEADLESS-N", "workspace": "staka-agent-N", "cage_pid": N, "socket": "staka-cage" }` |
| `run_app` | `{ "app": "..." }` | launches an extra app inside the running cage |
| `screenshot` | `{ "format": "png" }` | captures the headless output; returns a binary frame |
| `click` | `{ "x": 320, "y": 240, "button": "left" }` | pending; virtual pointer |
| `move_pointer` | `{ "x": 320, "y": 240 }` | pending; virtual pointer |
| `type` | `{ "text": "hello" }` | pending; virtual keyboard |
| `key` | `{ "keys": ["ctrl", "s"] }` | pending; virtual keyboard |
| `teardown` | `{}` | kills the cage and its apps, gives back any hijacked workspace, removes the headless output |
| `health` | | checks Hyprland reachability |

Commands marked pending return an explicit "not implemented" error until the
virtual input client lands (`crates/compositor/src/input.rs`).

The TypeScript agent speaks this protocol from
`packages/agent/src/tools/compositor.ts` (the `compositor_*` agent tools).
Its app launcher uses a fixed allowlist mapping `terminal` -> `foot`,
`calculator` -> `gnome-calculator`, `spreadsheet` -> `libreoffice --calc`,
and `writer` -> `libreoffice --writer`, so the ISO needs to provide those
apps for the agent to launch anything.

## ISO packaging

The ISO must ship both binaries or the agent's headless workspace has
nothing to talk to:

- `staka-compositor` - this crate, built with `cargo build --release` in
  `crates/`, installed on `PATH`.
- `cage` - the vendored fork under `vendor/cage/` (build steps in
  `vendor/cage/BUILD.md`), installed on `PATH`. The driver expects to find
  it by name when `create_workspace` is called with an app.
- The apps the agent allowlist launches: `foot`, `gnome-calculator`, and
  `libreoffice`.

Without the driver binary running inside the Hyprland session (socket
`$XDG_RUNTIME_DIR/staka/compositor.sock`) the agent tools degrade to a
"compositor driver not available" message rather than failing.

## Workspace safety

Agent workspaces are named workspaces prefixed with `staka-agent-`, so they
can never shadow a user keybind like `Super+2`. Creating a headless output
makes Hyprland grab a workspace for it; when that grab takes a fresh empty
workspace the driver adopts it (renames it to the agent name), and when it
takes one of the user's workspaces the driver pins its own workspace to the
invisible output first and then gives the user's workspace back. Teardown
kills the cage, restores the user's layout from a snapshot taken before
anything was touched, and removes the output.

## Cage fork

The nested compositor is the vendored waydroid-helper cage fork with virtual
input support - see `vendor/cage/BUILD.md` for provenance and build steps.
The binary is expected on `PATH` as `cage` when `create_workspace` is called
with an app.
