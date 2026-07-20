# Staka image build

Fork of [omarchy-iso](https://github.com/omacom-io/omarchy-iso) (MIT) used to produce the Staka install ISO via Docker + mkarchiso.

## Attribution

Based on omarchy-iso by Anton Hvornum.  
Contains installer content from Omarchy by David Heinemeier Hansson (basecamp/omarchy).  
See `NOTICE` and upstream `LICENSE`.

## Layout

| Path | Role |
|---|---|
| `bin/staka-iso-make` | Host entrypoint (Docker) |
| `builder/build-iso.sh` | Runs inside the build container |
| `configs/` | ISO overlay (profile, pacman, airootfs) |
| `archiso/` | Arch releng profile checkout (not stored in git; clone at build time) |

## STAKA_MEDIA paths

When `/mnt/staka-media` is mounted:

| Host path | Use |
|---|---|
| `/mnt/staka-media/build/image` | Working copy of this tree + `archiso/` |
| `/mnt/staka-media/build/container-cache` | Docker `/var/cache` (mkarchiso work + airootfs) |
| `/mnt/staka-media/build/offline-cache` | Offline package mirror (reused across builds) |
| `/mnt/staka-media/build/pacman-pkg` | Pacman pkg cache bind |
| `/mnt/staka-media/build/dl-cache` | Omarchy git checkout + Node tarball |
| `/mnt/staka-media/images` | ISO + `.sha256` output |

## Build

```bash
cd /mnt/staka-media/build/image
# first time only:
# git clone --depth 1 -b master https://gitlab.archlinux.org/archlinux/archiso.git archiso

./bin/staka-iso-make
```

ISO lands in `/mnt/staka-media/images/`.

Caches stay on the SATA volume so repeat builds avoid re-downloading packages, Node, and the installer tree when the network is slow.

## Test

```bash
# from staka-os repo root
./test/qemu/boot-iso.sh /mnt/staka-media/images/staka-*.iso
```
