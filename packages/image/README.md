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

1. Prefer resume: keep `/root/machine.token` and `/root/staka-activation.json`.
   Re-run the installer with the same org URL and hostname; `staka-activate.sh`
   reuses local material after a successful heartbeat and does not re-enroll.
2. Do not reuse a spent code for a fresh enroll.
3. If the machine is still `pending` and you must re-enroll: admin reissues a
   new code for the same user (`bun run code:create` or `/admin`). Same HWID
   rebinds on enroll while `pending`.
4. If the machine is `approved` (nonce already issued/consumed), `active`,
   `suspended`, or `revoked`: enroll returns `409 hardware_id_bound`. Revoke
   does not free `hardware_id`. There is no admin reset API yet - clear or
   reopen the row in the DB (owner) before a clean enroll, or use a different
   machine/HWID.

Bare metal needs readable DMI (`/sys/class/dmi/id/*`). Missing product UUID
fails closed. For lab/QEMU without DMI, set `STAKA_HWID_*` overrides (preferred)
or `STAKA_ALLOW_SYNTHETIC_HWID=1` for a machine-id based synthetic id.

Host-side client check against a local org server (QEMU guest reaches host at
`10.0.2.2`):

```bash
# required when /sys/class/dmi/id/product_uuid is unreadable
export STAKA_HWID_PRODUCT_UUID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
export STAKA_HWID_BOARD_SERIAL='QEMU-SN-1'
export STAKA_HWID_PRODUCT_NAME='QEMU Standard PC'
export STAKA_HWID_CPU_ID='QEMU Virtual CPU'

# Flow B only:
# export STAKA_SELF_PASSWORD='...'

./packages/image/configs/airootfs/root/staka-activate.sh \
  --org-url http://127.0.0.1:8080 \
  --code "$CODE" \
  --hostname lab-box \
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
