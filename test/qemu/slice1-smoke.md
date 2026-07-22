# Slice 1 smoke checklist

Manual end-to-end path for Flow A. Not CI.

## Preconditions

- [ ] On M4 tip (or stacked M5): `staka-configurator` + `staka-activate.sh` in `packages/image`
- [ ] `/mnt/staka-media` mounted (fstab UUID); caches under `build/{container-cache,offline-cache,pacman-pkg,dl-cache}`
- [ ] Contract: `./test/qemu/activate-client-contract.sh` -> ok
- [ ] Host org-server reachable from guest at `http://10.0.2.2:<port>` (user netdev)
- [ ] Disposable install disk only (`/tmp/staka-test.qcow2`); do not pass host system disks

## 1. Rebuild ISO

```bash
# sync package tree into media working copy (keep archiso/)
rsync -a --delete \
  --exclude archiso/ --exclude release/ --exclude '*.iso' --exclude '*.sha256' \
  packages/image/ /mnt/staka-media/build/image/

cd /mnt/staka-media/build/image
./bin/staka-iso-make
```

- [ ] Build finishes without error
- [ ] New ISO under `/mnt/staka-media/images/` with `.sha256`
- [ ] Airootfs includes `/root/staka-configurator` and `/root/staka-activate.sh`

Optional offline check before QEMU:

```bash
mkdir -p /tmp/staka-iso-mnt
sudo mount -o loop,ro /mnt/staka-media/images/staka-*-master.iso /tmp/staka-iso-mnt
# inspect airootfs image or known paths as packaged
sudo umount /tmp/staka-iso-mnt
```

## 2. Host org-server (auto-approve, non-prod only)

```bash
cd packages/org-server
cp -n .env.example .env
# set STAKA_JWT_KEYS (Ed25519 JSON), STAKA_SEED_ADMIN_PASSWORD
# STAKA_AUTO_APPROVE=1 and STAKA_AUTO_APPROVE_CONFIRM=1 for smoke only
docker compose up -d postgres
export DATABASE_URL="postgres://staka@127.0.0.1:$(docker compose port postgres 5432 | awk -F: '{print $NF}')/staka"
export DATABASE_APP_URL="postgres://staka_app@127.0.0.1:$(docker compose port postgres 5432 | awk -F: '{print $NF}')/staka"
export DATABASE_ADMIN_URL="postgres://staka_admin@127.0.0.1:$(docker compose port postgres 5432 | awk -F: '{print $NF}')/staka"
bun run db:migrate
bun run db:seed
# bind 0.0.0.0 so QEMU guest can reach host
HOST=0.0.0.0 PORT=8080 bun run start
```

- [ ] `curl -s http://127.0.0.1:8080/v1/health` ok
- [ ] Mint Flow A code: `bun run code:create -- --employee-id EMP-0001 --flow admin`
- [ ] Record plaintext code once

Guest org URL: `http://10.0.2.2:8080` (default QEMU user networking).

## 3. QEMU boot

```bash
rm -f /tmp/staka-test.qcow2
./test/qemu/boot-iso.sh /mnt/staka-media/images/staka-<date>-x86_64-master.iso
```

- [ ] ISO boots (OVMF + GTK)
- [ ] Installer reaches Staka configurator (not legacy Omarchy-only form)
- [ ] Configurator fields: org URL, enrollment code, hostname

## 4. Flow A activation on live ISO

In configurator:

- Org URL: `http://10.0.2.2:8080`
- Code: minted Flow A code
- Hostname: valid `^[A-Za-z0-9-]{1,63}$` (e.g. `slice1-smoke`)

Host checks while guest activates:

- [ ] Enroll `POST /v1/activate/enroll` -> 202
- [ ] Status poll succeeds (auto-approve or admin approve)
- [ ] Token exchange 200; live root has activation material (`/root/machine.token` before install)

If DMI is empty in QEMU, client may use synthetic HWID; prefer real DMI when present.

## 5. Install + token on target

Complete configurator disk/user steps and let archinstall run.

- [ ] archinstall finishes without hard fail
- [ ] Target has `/etc/staka/machine.token` (mode 600)
- [ ] Optional: `/etc/staka/org-url`, `/etc/staka/activation.json`

After first boot of installed system (if time):

- [ ] Heartbeat accepted with machine JWT (`POST /v1/activate/heartbeat`)
- [ ] Admin dashboard / API shows machine `active`

## 6. Fallback paths (only if full install blocked)

Host-only client smoke (proves protocol, not ISO packaging):

```bash
export STAKA_HWID_PRODUCT_UUID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
export STAKA_HWID_BOARD_SERIAL='QEMU-SN-1'
export STAKA_HWID_PRODUCT_NAME='QEMU Standard PC'
export STAKA_HWID_CPU_ID='QEMU Virtual CPU'
./packages/image/configs/airootfs/root/staka-activate.sh \
  --org-url http://127.0.0.1:8080 \
  --code "$CODE" \
  --hostname host-smoke \
  --flow admin \
  --token-out /tmp/machine.token
```

Deep ISO/integration failure: demo falls back to admin dashboard + curl enroll; keep a recorded ISO path when possible.

## Record

| Field | Value |
|---|---|
| Date | |
| ISO path + sha256 | |
| Org-server commit / branch tip | |
| Enroll HTTP | |
| Token on target | yes/no |
| Heartbeat / dashboard | |
| Notes / blockers | |

## Pass bar

Pass when: rebuilt ISO boots, Flow A enroll reaches host org-server, token lands on target root as `/etc/staka/machine.token` (or documented fallback with explicit gap). Full install + heartbeat preferred; do not merge stack until William asks.
