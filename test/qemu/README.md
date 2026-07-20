# QEMU ISO boot

Boot a Staka ISO in QEMU with KVM. Host disk is not used for the install target unless you pass a block device on purpose.

## Prerequisites

```bash
sudo pacman -S --needed qemu-full edk2-ovmf
ls -l /dev/kvm
```

Firmware paths used by the scripts:

- `/usr/share/edk2/x64/OVMF_CODE.4m.fd`
- `/usr/share/edk2/x64/OVMF_VARS.4m.fd`

## Scripts

| Script | Purpose |
|---|---|
| `boot-iso.sh <iso>` | ISO + disposable qcow2 disk |
| `boot-iso-sata.sh <iso> <block-dev>` | Same, plus raw block device pass-through |

```bash
./boot-iso.sh /path/to/staka.iso
./boot-iso-sata.sh /path/to/staka.iso /dev/sdX
```

Defaults:

- RAM: 4G (`-m 4096`)
- SMP: host `nproc`
- Display: GTK
- SSH forward: host `2222` -> guest `22`
- Disposable disk: `/tmp/staka-test.qcow2`
- OVMF vars copy: `/tmp/staka-OVMF_VARS.4m.fd`

Reset disposable disk:

```bash
rm -f /tmp/staka-test.qcow2
```

SSH (if guest has sshd and network is up):

```bash
ssh -p 2222 root@localhost
```

## SATA pass-through

Confirm the device first. Do not pass the host system disk.

```bash
lsblk -o NAME,SIZE,MODEL,SERIAL,TRAN,MOUNTPOINTS
./boot-iso-sata.sh /path/to/staka.iso /dev/sdX
```

`boot-iso-sata.sh` requires an explicit `yes` confirmation before start.

## Headless / serial smoke

The live image GRUB path is graphical. For automated serial checks, boot the kernel and initrd from the ISO with archiso params from the ISO boot config, for example:

```text
archisobasedir=arch archisosearchuuid=<uuid-from-iso-grub> console=ttyS0,115200n8
```

Kernel/initrd paths on the ISO:

```text
/arch/boot/x86_64/vmlinuz-linux-t2
/arch/boot/x86_64/initramfs-linux-t2.img
```

`archisosearchuuid` is in the ISO `grub.cfg` / `archiso_sys-linux.cfg` (and matches `/boot/<uuid>.uuid` on the ISO).

## Checksums

```bash
sha256sum -c staka-*.iso.sha256
```
