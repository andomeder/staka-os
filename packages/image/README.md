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
| `builder/archinstall.packages` | Offline mirror package list (pinned `archinstall`) |
| `configs/` | ISO overlay (profile, pacman, airootfs) |
| `configs/airootfs/root/staka-configurator` | First-boot org activation + install form |
| `configs/airootfs/root/staka-activate.sh` | HWID capture, enroll, poll, token write |
| `configs/airootfs/root/helpers/` | Vendored installer UI helpers |
| `branding/` | Installer ASCII logo + Plymouth theme assets |
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

## Activation client (live ISO)

On boot, `.automated_script.sh` requires `staka-configurator` (fail-closed; no
legacy Omarchy form). It collects org URL + enrollment code + hostname (Flow B
also asks for employee id + password via `STAKA_SELF_PASSWORD`, never argv),
then calls `staka-activate.sh` before archinstall. After install, the machine
JWT is written to `/etc/staka/machine.token` on the target root.

Hostname validation matches `@staka/protocol` (`^[A-Za-z0-9-]{1,63}$`).

### Recovery after failed install

Enrollment codes are consumed at `POST /v1/activate/enroll`. If activation
succeeds and archinstall later fails:

1. Do not reuse the spent code.
2. Admin reissues a new code for the same user (`bun run code:create` or `/admin`).
3. Retry install. Same HWID can re-enroll while the machine is still `pending`
   (server rebind path). If the machine is `approved` without a usable nonce,
   admin must reset/revoke that machine row before a clean enroll.

Bare metal needs readable DMI (`/sys/class/dmi/id/*`). Synthetic HWID from
`/etc/machine-id` is only for QEMU/host smoke when DMI is unavailable; prefer
`STAKA_HWID_*` overrides in that case.

Host-side smoke against a local org server (QEMU guest reaches host at
`10.0.2.2`):

```bash
# optional HWID overrides when /sys/class/dmi/id is unreadable
export STAKA_HWID_PRODUCT_UUID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
export STAKA_HWID_BOARD_SERIAL='QEMU-SN-1'
export STAKA_HWID_PRODUCT_NAME='QEMU Standard PC'
export STAKA_HWID_CPU_ID='QEMU Virtual CPU'

# Flow B only:
# export STAKA_SELF_PASSWORD='...'

./packages/image/configs/airootfs/root/staka-activate.sh \
  --org-url http://127.0.0.1:8080 \
  --code "$CODE" \
  --hostname demo-box \
  --flow admin \
  --token-out /tmp/machine.token
```

Contract fixture check (no server):

```bash
./test/qemu/activate-client-contract.sh
```

## Test

```bash
# from staka-os repo root
./test/qemu/boot-iso.sh /mnt/staka-media/images/staka-*.iso
./test/qemu/activate-client-contract.sh
```
