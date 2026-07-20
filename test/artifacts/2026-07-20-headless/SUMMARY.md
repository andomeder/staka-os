# Headless output bench - 2026-07-20

## Machine

- Host: cloudsurfer
- CPU: Intel Core i7-6500U @ 2.50GHz (2 cores / 4 threads)
- Memory: 11 GiB
- Display: eDP-1 1366x768 @ 60.003 Hz
- Compositor: Hyprland 0.55.2
- Kernel: Linux 7.0.10-arch1-1
- Virtualization: VT-x

## Method

- Tool: `test/laptop-bench`
- Duration: 60 s, sample every 5 s
- Headless mode requested: 1920x1080@60
- Workspace id: 77

## Run A - loaded session

- Timestamp (UTC): 20260720T095557Z
- Headless: HEADLESS-2 1920x1080 @ 60 Hz
- Physical during run: eDP-1 1366x768 @ 60.003 Hz
- hyprctl healthy throughout: true
- load before: 3.09 2.84 1.85
- load after: 3.36 2.94 1.95
- peak load1: 3.04
- mem available (bytes): before 5802999808, min 5347753984, after 5357277184
- teardown: headless removed; eDP-1 only
- JSON: `loaded.json`

## Run B - reduced session

- Timestamp (UTC): 20260720T095917Z
- Headless: HEADLESS-3 1920x1080 @ 60 Hz
- Physical during run: eDP-1 1366x768 @ 60.003 Hz
- hyprctl healthy throughout: true
- load before: 1.89 2.62 1.98
- load after: 1.88 2.47 1.97
- peak load1: 1.78
- mem available (bytes): before 9272541184, min 7785017344, after 7794835456
- teardown: headless removed; eDP-1 only
- JSON: `clean.json`
