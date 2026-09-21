# Staka shell - Hyprland keybind (Hyprland 0.56+, Lua config)
#
# Source this from your Hyprland Lua config (hyprland.lua / hyprland.conf.lua)
# to toggle the Staka AI panel with Super+A. The toggle script resolves the
# shell root from STAKA_SHELL_PATH (or its own location) and is a no-op when
# the shell is not running.
#
# Make sure packages/shell/bin is on PATH, or use the absolute exec line below.

hyprland.bind("SUPER", "A", "exec", "staka-toggle-panel")

# Absolute-path variant (no PATH requirement):
# hyprland.bind("SUPER", "A", "exec", "/path/to/staka-os/packages/shell/bin/staka-toggle-panel")

-- Staka perimeter band auto-coupler (optional standalone command):
-- exec_once("staka-band apply")
