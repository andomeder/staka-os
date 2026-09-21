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
  list, workspace dispatch
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
| `create_workspace` | `{ "app": null }` | creates a headless output; returns `{ "output": "HEADLESS-N" }` |
| `run_app` | `{ "app": "..." }` | nested compositor lifecycle pending |
| `screenshot` | `{ "format": "png" }` | pending; will return a binary frame |
| `click` | `{ "x": 320, "y": 240, "button": "left" }` | pending; virtual pointer |
| `move_pointer` | `{ "x": 320, "y": 240 }` | pending; virtual pointer |
| `type` | `{ "text": "hello" }` | pending; virtual keyboard |
| `key` | `{ "keys": ["ctrl", "s"] }` | pending; virtual keyboard |
| `teardown` | `{}` | removes headless outputs created by this driver |
| `health` | | checks Hyprland reachability |

Commands marked pending return an explicit "not implemented" error until the
nested compositor (cage), screencopy, and virtual input land.
