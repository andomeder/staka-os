#!/bin/bash
# Boot Staka ISO in QEMU (no SATA, no host disk touched)
# Disposable 40GB qcow2 disk in /tmp receives the install.
# Usage: ./boot-iso.sh [path-to-staka.iso]
set -e

ISO="${1:-staka-0.0.1.iso}"
DISK="/tmp/staka-test.qcow2"
OVMF_VARS="/tmp/staka-OVMF_VARS.4m.fd"

if [ ! -f "$ISO" ]; then
  echo "Usage: $0 <path-to-staka.iso>"
  echo "ISO not found at: $ISO"
  exit 1
fi

if [ ! -f /dev/kvm ]; then
  echo "Warning: /dev/kvm not found. KVM acceleration will not work."
  echo "Install: sudo pacman -S qemu-full edk2-ovmf"
fi

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
  -device virtio-vga \
  -display gtk \
  -usb -device usb-tablet \
  -netdev user,id=net0,hostfwd=tcp::2222-:22 \
  -device virtio-net-pci,netdev=net0
