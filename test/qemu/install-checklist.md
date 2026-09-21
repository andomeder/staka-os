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

## 7. Agent and shell (installed system)

After first boot of the installed system, log in to the desktop.

- [ ] `systemctl --user status staka-agent` shows active (running)
- [ ] `curl -s http://127.0.0.1:7920/health` returns JSON with `machine_id` and `org_name`
- [ ] `ls ~/.agents/skills/staka/` shows org skill pack symlink
- [ ] Super+A opens the AI panel
- [ ] Type "who am I" in the panel; agent responds with employee identity
- [ ] Close and reopen the panel; previous session is visible

If the agent binary was not staged in the ISO (`/opt/staka/agent/staka-agent`
missing), these checks are skipped and the gap is noted in the record.

## 8. AI walkthrough (browser + delivery)

After section 7 passes, verify the full agent walkthrough on the installed
system. Script and fixtures: `test/demo/walkthrough.md`, `test/demo/`.

- [ ] `browser_open` on `test/demo/demo-dashboard.html` (served or `file://`) opens the Staka-managed Chromium with a dedicated profile under `$XDG_DATA_HOME/staka/browser`
- [ ] Selecting the headline figure and asking via the panel captures it (`browser_get_selection`), no screenshot reading involved
- [ ] `compositor_start_app { app: "spreadsheet" }` opens Calc on the headless output; the user's display is untouched; `compositor_type` enters the figure
- [ ] `fs_read_file` reads the demo report only from a `STAKA_FS_ALLOWLIST` dir; a path outside the allowlist returns `path_denied` and is audited in the org usage log
- [ ] `org_users_search` resolves the colleague; `org_deliver` records the delivery and the admin dashboard shows it under Deliveries
- [ ] `memory` saved; reopening the panel shows the interaction in context
- [ ] Failure drills (browser closed, no selection, disallowed path, compositor down) each produce an honest report in the panel, per `test/demo/walkthrough.md`
- [ ] Rehearsal recorded; note the run in the walkthrough Record table

## Record

| Field | Value |
|---|---|
| Date | |
| ISO path + sha256 | |
| Org-server revision | |
| Enroll HTTP | |
| Token on target | yes/no |
| Heartbeat / dashboard | |
| Agent service | active/skipped |
| Panel (Super+A) | yes/no/skipped |
| Notes | |

## Pass bar

Pass when: rebuilt ISO boots, Flow A enroll reaches the org server, and `/etc/staka/machine.token` lands on the installed root (or a documented fallback with an explicit gap). Full install plus heartbeat preferred. Agent section passes when the service is active and the panel opens, or the gap is documented.
