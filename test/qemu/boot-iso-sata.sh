#!/bin/bash
# Boot Staka ISO in QEMU with SATA SSD passed through as a block device.
# The VM sees the SATA drive as a raw disk and can read/write directly.
# Usage: ./boot-iso-sata.sh [path-to-staka.iso] [sata-device]
# Example: ./boot-iso-sata.sh staka-0.0.1.iso /dev/sdb
set -e

ISO="${1:-staka-0.0.1.iso}"
SATA_DEVICE="${2:-/dev/sdb}"
DISK="/tmp/staka-test.qcow2"
OVMF_VARS="/tmp/staka-OVMF_VARS.4m.fd"

if [ ! -f "$ISO" ]; then
  echo "Usage: $0 <path-to-staka.iso> [sata-device]"
  echo "ISO not found at: $ISO"
  exit 1
fi

if [ ! -b "$SATA_DEVICE" ]; then
  echo "Error: SATA device $SATA_DEVICE not found."
  echo "Available block devices:"
  lsblk -o NAME,SIZE,MODEL,TRAN
  exit 1
fi

echo "Using SATA device: $SATA_DEVICE"
echo "Contents will be readable and writable by the VM."
read -p "Continue? (yes/no): " confirm
[ "$confirm" = "yes" ] || exit 0

if [ ! -f "$DISK" ]; then
  echo "Creating disposable test disk..."
  qemu-img create -f qcow2 "$DISK" 40G
fi

cp /usr/share/edk2/x64/OVMF_VARS.4m.fd "$OVMF_VARS"

qemu-system-x86_64 \
  -cpu host -enable-kvm -machine q35,accel=kvm \
  -smp "$(nproc)" \
  -m 4096 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/edk2/x64/OVMF_CODE.4m.fd \
  -drive if=pflash,format=raw,file="$OVMF_VARS" \
  -drive file="$DISK",format=qcow2,if=none,id=drive0 \
  -device virtio-blk-pci,drive=drive0,bootindex=1 \
  -drive file="$ISO",media=cdrom,if=none,format=raw,id=cdrom0 \
  -device ide-cd,drive=cdrom0,bootindex=2 \
  -drive file="$SATA_DEVICE",format=raw,if=none,id=sata0,media=disk \
  -device virtio-blk-pci,drive=sata0,bootindex=3 \
  -device virtio-vga \
  -display gtk \
  -usb -device usb-tablet \
  -netdev user,id=net0,hostfwd=tcp::2222-:22 \
  -device virtio-net-pci,netdev=net0
