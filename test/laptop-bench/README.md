# Laptop headless output bench

Measures the cost of a second Hyprland **headless** output beside the physical display.

## Scope

- Uses `hyprctl output create headless` / sample / `output remove`
- Writes only under `./results/`
- Does not touch disks, mounts, packages, or Hyprland config files

## Prerequisites

- Live Hyprland session
- `hyprctl`, `jq`
- Optional: `bc`, a terminal (`kitty`, `foot`, `alacritty`, or `ghostty`)

From a non-graphical SSH session, export the compositor env first:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export HYPRLAND_INSTANCE_SIGNATURE=$(ls "$XDG_RUNTIME_DIR/hypr" | head -n1)
export WAYLAND_DISPLAY=wayland-1   # or wayland-0
```

## Run

```bash
chmod +x *.sh
./00-inventory.sh
./01-headless-bench.sh
```

Optional:

```bash
DURATION_SEC=60 SAMPLE_SEC=5 ./01-headless-bench.sh
```

During the sample window, use the physical display (move windows, type, scroll).

## Output

`results/` gets:

- `inventory-<ts>.md`
- `headless-bench-<ts>.{log,json,md}`
- `DECISION.md` template on first inventory run

Committed snapshot of a completed run (summary + JSON):  
`../artifacts/2026-07-20-headless/`.

## Teardown if stuck

```bash
hyprctl monitors
hyprctl output remove HEADLESS-2   # use the name shown
```
