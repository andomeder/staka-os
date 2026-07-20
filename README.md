<p align="left">
  <img src="brands/staka-mark.svg" alt="" height="40" />
</p>

# Staka

AI-native enterprise desktop environment on Hyprland.

Staka provisions org workstations, presents shell surfaces as compositor-native widgets, and runs one org-configured agent layer with shared memory and skills. The novel concurrency path is a dedicated headless Wayland output for agent work so the physical display stays with the user.

Status: early. Implementation is starting from measured compositor baselines.

## Repository layout

```text
brands/                 logo mark and wordmark
packages/image/         ISO build (omarchy-iso fork)
test/laptop-bench/      headless-output measurement harness
test/qemu/              QEMU boot helpers
test/artifacts/         dated bench snapshots
```

Application crates and packages will land here as work proceeds. This tree intentionally starts thin.

## Headless output bench

Harness: [`test/laptop-bench`](test/laptop-bench)

Snapshot (2026-07-20 laptop run): [`test/artifacts/2026-07-20-headless/SUMMARY.md`](test/artifacts/2026-07-20-headless/SUMMARY.md)

Both a loaded session and a reduced session created a 1920x1080@60 headless output beside eDP-1 for 60 seconds with stable `hyprctl` and clean teardown. Raw samples: `loaded.json`, `clean.json` in the same directory.

## Brand

| File | Use |
|---|---|
| `brands/staka-mark.svg` | stacked S, color |
| `brands/staka-mark-mono.svg` | stacked S, `currentColor` |
| `brands/staka-wordmark.svg` | mark + "staka" (theme-aware text) |

Accent blue: `#1E5EFF` / `#3B7BFF` / `#0B2F8A`. Ink `#0B1220`, light text `#E8EEF9`.

## License

Copyright (c) 2026 William Nyarangi Obino Kengere.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
