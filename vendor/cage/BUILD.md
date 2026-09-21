# Vendored cage fork

Vendored copy of https://github.com/waydroid-helper/cage (MIT), a fork of
cage-kiosk/cage that wires up the virtual-input protocols upstream lacks
(cage-kiosk/cage#133):

- `zwlr_virtual_pointer_manager_v1` - the agent drives the pointer
- `zwp_virtual_keyboard_manager_v1` - the agent types
- headless-backend knobs: `-S <socket name>`, `-W <width>`, `-H <height>`

This fork is the only nested compositor that gives the agent its own seat:
input injected into cage's socket never reaches the user's physical seat.

The `subprojects/wlroots` and `subprojects/libliftoff` checkouts are not
vendored; meson fetches them from the `.wrap` files (wlroots 0.19 branch,
pinned revision) during setup.

## Build

```sh
cd vendor/cage
meson setup build --buildtype=release -Dwerror=false
meson compile -C build
# binary: build/cage
```

`-Dwerror=false` is required: wlroots 0.19 as of the pinned revision emits
a libinput version-skew warning (`LIBINPUT_SWITCH_KEYPAD_SLIDE` unhandled
in switch.c) with libinput 1.31, which otherwise fails the build.

## Notes

- cage is a kiosk compositor: one maximized app, chosen via `-- <app...>`.
- The Wayland socket cage creates lives in `$XDG_RUNTIME_DIR/<socket name>`.
- License: MIT (see LICENSE). Upstream changes are limited to the
  virtual-input wiring described above; keep this copy in sync with the
  fork when the input protocols change.
