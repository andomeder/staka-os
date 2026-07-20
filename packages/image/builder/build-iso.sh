#!/bin/bash
# Core ISO assembly inside Docker. Based on omarchy-iso builder/build-iso.sh (MIT).
# Optional /cache mount (host STAKA_MEDIA dl-cache) stores omarchy git + Node tarball.
set -euo pipefail

pacman-key --init
pacman --noconfirm -Sy archlinux-keyring
pacman --noconfirm -Sy archiso git sudo base-devel jq grub

pacman-key --add /builder/omarchy.gpg
pacman-key --lsign-key 40DFB630FF42BCFFB047046CF0134EE680CAC571

pacman --config /configs/pacman-online-${OMARCHY_MIRROR}.conf --noconfirm -Sy omarchy-keyring
pacman-key --populate omarchy

build_cache_dir="/var/cache"
offline_mirror_dir="$build_cache_dir/airootfs/var/cache/omarchy/mirror/offline"
mkdir -p "$build_cache_dir/"
mkdir -p "$offline_mirror_dir/"

# Persistent download cache (optional host bind at /cache)
CACHE_ROOT=""
if [[ -d /cache ]]; then
  CACHE_ROOT=/cache
  mkdir -p "$CACHE_ROOT/node" "$CACHE_ROOT/omarchy" "$CACHE_ROOT/git"
fi

cp -r /archiso/configs/releng/* "$build_cache_dir/"
rm -f "$build_cache_dir/airootfs/etc/motd"

rm -rf "$build_cache_dir/airootfs/etc/systemd/system/multi-user.target.wants/reflector.service"
rm -rf "$build_cache_dir/airootfs/etc/systemd/system/reflector.service.d"
rm -rf "$build_cache_dir/airootfs/etc/xdg/reflector"

cp -r /configs/* "$build_cache_dir/"

echo "$OMARCHY_MIRROR" > "$build_cache_dir/airootfs/root/omarchy_mirror"

# --- Omarchy installer tree (prefer bind / local cache over fresh clone) ---
OMARCHY_DST="$build_cache_dir/airootfs/root/omarchy"
if [[ -d /omarchy ]]; then
  echo "Using bind-mounted /omarchy"
  cp -rp /omarchy "$OMARCHY_DST"
elif [[ -n "$CACHE_ROOT" && -d "$CACHE_ROOT/omarchy/.git" ]]; then
  echo "Using cached omarchy at $CACHE_ROOT/omarchy"
  # Refresh refs when online; keep going offline if fetch fails
  git -C "$CACHE_ROOT/omarchy" fetch --depth 1 origin "$OMARCHY_INSTALLER_REF" 2>/dev/null || true
  git -C "$CACHE_ROOT/omarchy" checkout -f "$OMARCHY_INSTALLER_REF" 2>/dev/null \
    || git -C "$CACHE_ROOT/omarchy" checkout -f "origin/$OMARCHY_INSTALLER_REF" 2>/dev/null \
    || true
  cp -rp "$CACHE_ROOT/omarchy" "$OMARCHY_DST"
else
  echo "Cloning omarchy $OMARCHY_INSTALLER_REPO@$OMARCHY_INSTALLER_REF"
  if [[ -n "$CACHE_ROOT" ]]; then
    rm -rf "$CACHE_ROOT/omarchy"
    git clone --depth 1 -b "$OMARCHY_INSTALLER_REF" \
      "https://github.com/$OMARCHY_INSTALLER_REPO.git" "$CACHE_ROOT/omarchy"
    cp -rp "$CACHE_ROOT/omarchy" "$OMARCHY_DST"
  else
    git clone --depth 1 -b "$OMARCHY_INSTALLER_REF" \
      "https://github.com/$OMARCHY_INSTALLER_REPO.git" "$OMARCHY_DST"
  fi
fi

mkdir -p "$build_cache_dir/airootfs/usr/local/bin/"
if [[ -f "$OMARCHY_DST/bin/omarchy-upload-log" ]]; then
  cp "$OMARCHY_DST/bin/omarchy-upload-log" "$build_cache_dir/airootfs/usr/local/bin/omarchy-upload-log"
fi

if [[ -d "$OMARCHY_DST/default/plymouth" ]]; then
  mkdir -p "$build_cache_dir/airootfs/usr/share/plymouth/themes/omarchy"
  cp -r "$OMARCHY_DST/default/plymouth/"* "$build_cache_dir/airootfs/usr/share/plymouth/themes/omarchy/"
fi

# --- Node.js offline payload (cache tarball on /cache/node) ---
NODE_DIST_URL="https://nodejs.org/dist/latest"
NODE_SHASUMS=$(curl -fsSL "$NODE_DIST_URL/SHASUMS256.txt")
NODE_FILENAME=$(echo "$NODE_SHASUMS" | grep "linux-x64.tar.gz" | awk '{print $2}')
NODE_SHA=$(echo "$NODE_SHASUMS" | grep "linux-x64.tar.gz" | awk '{print $1}')

NODE_SRC=""
if [[ -n "$CACHE_ROOT" && -f "$CACHE_ROOT/node/$NODE_FILENAME" ]]; then
  echo "Using cached Node tarball $NODE_FILENAME"
  NODE_SRC="$CACHE_ROOT/node/$NODE_FILENAME"
else
  echo "Downloading Node $NODE_FILENAME"
  curl -fsSL "$NODE_DIST_URL/$NODE_FILENAME" -o "/tmp/$NODE_FILENAME"
  NODE_SRC="/tmp/$NODE_FILENAME"
  if [[ -n "$CACHE_ROOT" ]]; then
    cp "/tmp/$NODE_FILENAME" "$CACHE_ROOT/node/$NODE_FILENAME"
  fi
fi

echo "$NODE_SHA  $NODE_SRC" | sha256sum -c - || {
  echo "ERROR: Node.js checksum verification failed!"
  # stale cache: re-download once
  if [[ -n "$CACHE_ROOT" && "$NODE_SRC" == "$CACHE_ROOT/node/$NODE_FILENAME" ]]; then
    curl -fsSL "$NODE_DIST_URL/$NODE_FILENAME" -o "/tmp/$NODE_FILENAME"
    echo "$NODE_SHA  /tmp/$NODE_FILENAME" | sha256sum -c -
    cp "/tmp/$NODE_FILENAME" "$CACHE_ROOT/node/$NODE_FILENAME"
    NODE_SRC="/tmp/$NODE_FILENAME"
  else
    exit 1
  fi
}

mkdir -p "$build_cache_dir/airootfs/opt/packages/"
cp "$NODE_SRC" "$build_cache_dir/airootfs/opt/packages/$NODE_FILENAME"

arch_packages=(linux-t2 git gum jq openssl plymouth tzupdate omarchy-keyring lvm2 cryptsetup parted)
printf '%s\n' "${arch_packages[@]}" >>"$build_cache_dir/packages.x86_64"

mapfile -t all_packages < <(grep -v '^#' "$build_cache_dir/packages.x86_64" | grep -v '^$' || true)
mapfile -t base_pkgs < <(grep -v '^#' "$OMARCHY_DST/install/omarchy-base.packages" | grep -v '^$' || true)
mapfile -t other_pkgs < <(grep -v '^#' "$OMARCHY_DST/install/omarchy-other.packages" | grep -v '^$' || true)
mapfile -t archinstall_pkgs < <(grep -v '^#' /builder/archinstall.packages | grep -v '^$' || true)
all_packages+=("${base_pkgs[@]}" "${other_pkgs[@]}" "${archinstall_pkgs[@]}")

mkdir -p /tmp/offlinedb
# -Syw fills offline_mirror_dir; bind-mounted host offline-cache reuses *.pkg.tar.zst next time
pacman --config "/configs/pacman-online-${OMARCHY_MIRROR}.conf" --noconfirm -Syw "${all_packages[@]}" \
  --cachedir "$offline_mirror_dir/" --dbpath /tmp/offlinedb
repo-add --new "$offline_mirror_dir/offline.db.tar.gz" "$offline_mirror_dir/"*.pkg.tar.zst

mkdir -p /var/cache/omarchy/mirror
ln -sfn "$offline_mirror_dir" "/var/cache/omarchy/mirror/offline"

cp "$build_cache_dir/pacman-offline.conf" "$build_cache_dir/airootfs/etc/pacman.conf"

mkarchiso -v -w "$build_cache_dir/work/" -o "/out/" "$build_cache_dir/"

if [[ -n "${HOST_UID:-}" && -n "${HOST_GID:-}" ]]; then
  chown -R "$HOST_UID:$HOST_GID" /out/ || true
  if [[ -n "$CACHE_ROOT" ]]; then
    chown -R "$HOST_UID:$HOST_GID" "$CACHE_ROOT" || true
  fi
fi
