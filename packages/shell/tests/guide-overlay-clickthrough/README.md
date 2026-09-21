# Guide overlay click-through gate

The guidance overlay renders a fake agent cursor and highlight rectangles on
the user's output. Its hard safety requirement is that it must never
intercept or block user input: the overlay surface is created with an empty
input region so the compositor routes every pointer event to the windows
beneath. This gate proves that property on a live Hyprland session before
any overlay feature is built on top of it.

## Method

Three runs against the same target window (a plain quickshell toplevel that
logs every click it receives) at a fixed position:

1. **Control** - no overlay. A synthetic click (`ydotool`, uinput virtual
   pointer) at the window's center must reach the target. This validates the
   click-injection path itself.
2. **Gate** - overlay mapped full-screen at the overlay layer (`Layer 3`),
   transparent, with an empty input mask (`mask: Region {}` in QuickShell).
   The same click, now at a highlighted coordinate, must still reach the
   target beneath.
3. **Negative** - overlay mapped without the input mask. The click must be
   intercepted. This proves the test can detect a grabbing overlay and that
   the empty mask is the operative click-through mechanism.

The run briefly floats a small test window on the focused workspace and
moves the pointer, then restores the previous focus and pointer position.

## Result (2026-09-22, Hyprland 0.56.2, QuickShell 0.3.1)

All three runs behaved as specified:

| Run | Click reached target | Note |
|-----|----------------------|------|
| Control | yes | injected click landed on the target (logged, focused) |
| Gate (empty mask) | **yes** | overlay mapped on `Layer 3 (overlay)`; click passed through to the target |
| Negative (no mask) | no | unmasked overlay intercepted the click |

`hyprctl layers` confirmed the surface at `Layer level 3 (overlay)`; a
screenshot taken during the gate run shows the highlight rendered above the
windows beneath. Conclusion: QuickShell layer-shell surfaces are viable for
the guidance overlay; no Rust fallback client is needed.

## Requirements

- Hyprland 0.55+ (the script uses the Lua dispatch syntax
  `hyprctl eval 'hl.dispatch(hl.dsp....)'`)
- quickshell, ydotool with a running `ydotoold`, jq, grim
- uinput access (`input` group or a uaccess ACL on `/dev/uinput`)

## Run

```bash
packages/shell/tests/guide-overlay-clickthrough/run.sh
```
