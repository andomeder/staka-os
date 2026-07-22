# Install checklist

Manual end-to-end path for admin-provisioned activation (Flow A). Not CI.

## Preconditions

- [ ] `staka-configurator` and `staka-activate.sh` present under `packages/image`
- [ ] Contract check: `./test/qemu/activate-client-contract.sh` exits 0
- [ ] Org server reachable from the guest at `http://10.0.2.2:<port>` (QEMU user networking)
- [ ] Disposable install disk only (`/tmp/staka-test.qcow2`); do not pass host system disks

## 1. Build ISO

```bash
# optional: work copy on a large disk so package caches survive rebuilds
rsync -a --delete \
  --exclude archiso/ --exclude release/ --exclude '*.iso' --exclude '*.sha256' \
  packages/image/ /mnt/staka-media/build/image/

cd /mnt/staka-media/build/image
./bin/staka-iso-make
```

- [ ] Build finishes without error
- [ ] New ISO under the image output directory with `.sha256`
- [ ] Live image includes `/root/staka-configurator` and `/root/staka-activate.sh`

## 2. Org server (local, non-production)

```bash
cd packages/org-server
cp -n .env.example .env
# set STAKA_JWT_KEYS (Ed25519 JSON) and STAKA_SEED_ADMIN_PASSWORD
# optional lab only: STAKA_AUTO_APPROVE=1 and STAKA_AUTO_APPROVE_CONFIRM=1
docker compose up -d postgres
export DATABASE_URL="postgres://staka@127.0.0.1:$(docker compose port postgres 5432 | awk -F: '{print $NF}')/staka"
export DATABASE_APP_URL="postgres://staka_app@127.0.0.1:$(docker compose port postgres 5432 | awk -F: '{print $NF}')/staka"
export DATABASE_ADMIN_URL="postgres://staka_admin@127.0.0.1:$(docker compose port postgres 5432 | awk -F: '{print $NF}')/staka"
bun run db:migrate
bun run db:seed
HOST=0.0.0.0 PORT=8080 bun run start
```

- [ ] `curl -s http://127.0.0.1:8080/v1/health` ok
- [ ] Mint admin enrollment code: `bun run code:create -- --employee-id EMP-0001 --flow admin`
- [ ] Record plaintext code once

Guest org URL: `http://10.0.2.2:8080`.

## 3. QEMU boot

```bash
rm -f /tmp/staka-test.qcow2
./test/qemu/boot-iso.sh /path/to/staka-*.iso
```

- [ ] ISO boots (OVMF + GTK)
- [ ] Installer reaches the Staka configurator
- [ ] Configurator fields: org URL, enrollment code, hostname

## 4. Activation on the live ISO

In the configurator:

- Org URL: `http://10.0.2.2:8080`
- Code: minted admin enrollment code
- Hostname: `^[A-Za-z0-9-]{1,63}$` (example: `lab-install`)

Host checks while the guest activates:

- [ ] Enroll `POST /v1/activate/enroll` -> 202
- [ ] Status poll succeeds (auto-approve or admin approve)
- [ ] Token exchange 200; live root has `/root/machine.token` before install

If DMI is empty under QEMU, set explicit `STAKA_HWID_*` overrides rather than relying on synthetic fallback.

## 5. Install and token on target

Complete disk and user steps; let archinstall run.

- [ ] archinstall finishes without hard fail
- [ ] Target has `/etc/staka/machine.token` (mode 600)
- [ ] Optional: `/etc/staka/org-url`, `/etc/staka/activation.json`

After first boot of the installed system (if needed):

- [ ] Heartbeat accepted (`POST /v1/activate/heartbeat` with machine JWT)
- [ ] Admin dashboard or API shows the machine as `active`

## 6. Host-only client check

Protocol only (not full ISO packaging):

```bash
export STAKA_HWID_PRODUCT_UUID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
export STAKA_HWID_BOARD_SERIAL='QEMU-SN-1'
export STAKA_HWID_PRODUCT_NAME='QEMU Standard PC'
export STAKA_HWID_CPU_ID='QEMU Virtual CPU'
./packages/image/configs/airootfs/root/staka-activate.sh \
  --org-url http://127.0.0.1:8080 \
  --code "$CODE" \
  --hostname host-check \
  --flow admin \
  --token-out /tmp/machine.token
```

## Record

| Field | Value |
|---|---|
| Date | |
| ISO path + sha256 | |
| Org-server revision | |
| Enroll HTTP | |
| Token on target | yes/no |
| Heartbeat / dashboard | |
| Notes | |

## Pass bar

Pass when: rebuilt ISO boots, Flow A enroll reaches the org server, and `/etc/staka/machine.token` lands on the installed root (or a documented fallback with an explicit gap). Full install plus heartbeat preferred.
