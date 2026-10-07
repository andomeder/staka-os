#!/usr/bin/env bash
set -euo pipefail

# Staka agent + shell post-install setup.
# Runs inside the target chroot as the install user after the base system
# and Omarchy desktop are in place. Expects ISO artifacts staged at
# /opt/staka/ (copied there by .automated_script.sh before chroot).

AGENT_BIN_SRC="/opt/staka/agent/staka-agent"
AGENT_UNIT_SRC="/opt/staka/agent/staka-agent.service"
COMPOSITOR_BIN_SRC="/opt/staka/agent/staka-compositor"
COMPOSITOR_UNIT_SRC="/opt/staka/agent/staka-compositor.service"
CAGE_BIN_SRC="/opt/staka/agent/cage"
SHELL_SRC="/opt/staka/shell"
SKILLS_SRC="/opt/staka/skills" 

# Support running as root (no user sudo required in the chroot) or as the
# install user. STAKA_SETUP_USER must name the desktop user either way.
TARGET_USER="${STAKA_SETUP_USER:-${SUDO_USER:-}}"
if [[ -z $TARGET_USER ]]; then
  echo "STAKA_SETUP_USER not set; cannot determine target user" >&2
  exit 1
fi
TARGET_UID=$(id -u "$TARGET_USER")
if [[ $(id -u) == "0" ]]; then
  SUDO=""
  INSTALL_USER_FLAGS=(-o "$TARGET_UID" -g "$(id -g "$TARGET_USER")")
else
  SUDO="sudo"
  INSTALL_USER_FLAGS=()
fi

install_agent_binary() {
  if [[ ! -f "$AGENT_BIN_SRC" ]]; then
    echo "staka-agent binary not found at $AGENT_BIN_SRC; skipping" >&2
    return 0
  fi
  $SUDO install "${INSTALL_USER_FLAGS[@]}" -m 755 "$AGENT_BIN_SRC" /usr/local/bin/staka-agent
  echo "installed staka-agent binary"
}

install_compositor_binary() {
  if [[ -f "$COMPOSITOR_BIN_SRC" ]]; then
    $SUDO install "${INSTALL_USER_FLAGS[@]}" -m 755 "$COMPOSITOR_BIN_SRC" /usr/local/bin/staka-compositor
    echo "installed staka-compositor binary"
  fi
  if [[ -f "$CAGE_BIN_SRC" ]]; then
    $SUDO install "${INSTALL_USER_FLAGS[@]}" -m 755 "$CAGE_BIN_SRC" /usr/local/bin/cage
    echo "installed cage binary"
  fi
}

install_compositor_unit() {
  if [[ ! -f "$COMPOSITOR_UNIT_SRC" ]]; then
    return 0
  fi
  $SUDO install -Dm 644 "$COMPOSITOR_UNIT_SRC" /usr/lib/systemd/user/staka-compositor.service
  echo "installed staka-compositor systemd user unit"
}

install_agent_unit() {
  if [[ ! -f "$AGENT_UNIT_SRC" ]]; then
    echo "staka-agent.service not found at $AGENT_UNIT_SRC; skipping" >&2
    return 0
  fi
  $SUDO install -Dm 644 "$AGENT_UNIT_SRC" /usr/lib/systemd/user/staka-agent.service
  echo "installed staka-agent systemd user unit"
}

install_shell() {
  if [[ ! -d "$SHELL_SRC" ]]; then
    echo "staka shell not found at $SHELL_SRC; skipping" >&2
    return 0
  fi
  mkdir -p "$HOME/.local/share/staka"
  rm -rf "$HOME/.local/share/staka/shell"
  cp -r "$SHELL_SRC" "$HOME/.local/share/staka/shell"

  mkdir -p "$HOME/.local/bin"
  for bin in staka-shell staka-toggle-panel; do
    if [[ -f "$SHELL_SRC/bin/$bin" ]]; then
      install -m 755 "$SHELL_SRC/bin/$bin" "$HOME/.local/bin/$bin"
    fi
  done

  if [[ -f "$SHELL_SRC/hyprland/staka-keybinds.conf.lua" ]]; then
    mkdir -p "$HOME/.config/hypr/staka"
    cp "$SHELL_SRC/hyprland/staka-keybinds.conf.lua" "$HOME/.config/hypr/staka/"
  fi

  # Shell configuration: band layout with the AI panel button.
  if [[ -d /opt/staka/config/staka ]]; then
    mkdir -p "$HOME/.local/share/staka/config"
    rm -rf "$HOME/.local/share/staka/config/staka"
    cp -r /opt/staka/config/staka "$HOME/.local/share/staka/config/"
    echo "installed staka shell config"
  fi

  # Wire the shell into the desktop: Super+A keybind and shell autostart.
  # Current Omarchy (Hyprland 0.56+) uses a Lua entrypoint and never reads
  # hyprland.conf, so the Lua file gets Lua syntax; plain conf stays for
  # older images.
  HYPRLAND_LUA="$HOME/.config/hypr/hyprland.lua"
  HYPRLAND_CONF="$HOME/.config/hypr/hyprland.conf"
  if [[ -f "$HYPRLAND_LUA" ]]; then
    if ! grep -q "staka-toggle-panel" "$HYPRLAND_LUA"; then
      cat >> "$HYPRLAND_LUA" <<EOF

-- Staka AI panel (Super+A) + shell autostart
hl.env("STAKA_PATH", "$HOME/.local/share/staka")
hl.env("STAKA_SHELL_PATH", "$HOME/.local/share/staka")
hl.on("hyprland.start", function()
  hl.exec_cmd("quickshell -p $HOME/.local/share/staka/shell")
  hl.exec_cmd("sleep 2 && $HOME/.local/bin/staka-band apply")
end)
hyprland.bind("SUPER", "A", "exec", "$HOME/.local/bin/staka-toggle-panel")

-- Staka launcher and menu replace the walker binds
hyprland.unbind("SUPER", "SPACE")
hyprland.unbind("SUPER ALT", "SPACE")
hyprland.bind("SUPER", "SPACE", "exec", "$HOME/.local/bin/staka-shell shell toggle staka.launcher")
hyprland.bind("SUPER ALT", "SPACE", "exec", "$HOME/.local/bin/staka-shell shell toggle staka.menu")
EOF
    fi
    echo "wired staka shell into hyprland lua config"
  elif [[ -f "$HYPRLAND_CONF" ]] && ! grep -q "staka-toggle-panel" "$HYPRLAND_CONF"; then
    {
      echo ""
      echo "# Staka AI panel (Super+A) + shell autostart"
      echo "env = STAKA_PATH,$HOME/.local/share/staka"
      echo "env = STAKA_SHELL_PATH,$HOME/.local/share/staka"
      echo "bind = SUPER, A, exec, env STAKA_SHELL_PATH=$HOME/.local/share/staka $HOME/.local/bin/staka-toggle-panel"
      echo "# Staka launcher and menu replace the walker binds"
      echo "unbind = SUPER, Space"
      echo "unbind = SUPER ALT, Space"
      echo "bind = SUPER, Space, exec, $HOME/.local/bin/staka-shell shell toggle staka.launcher"
      echo "bind = SUPER ALT, Space, exec, $HOME/.local/bin/staka-shell shell toggle staka.menu"
      echo "exec-once = quickshell -p $HOME/.local/share/staka/shell"
    } >> "$HYPRLAND_CONF"
    echo "wired staka shell into hyprland config"
  fi

  # Root-owned copies lock the user out of updating the tree; this script is
  # re-run in chroots where every write above happens as root.
  if [[ $(id -u) == "0" ]]; then
    USER_GID="$(id -g "$TARGET_USER")"
    chown -R "$TARGET_UID:$USER_GID" "$HOME/.local/share/staka"
    for f in "$HYPRLAND_LUA" "$HYPRLAND_CONF" "$HOME/.config/hypr/staka" "$HOME/.local/bin/staka-shell" "$HOME/.local/bin/staka-toggle-panel" "$HOME/.agents/skills/staka"; do
      [[ -e $f ]] && chown -R "$TARGET_UID:$USER_GID" "$f"
    done
  fi
  echo "installed staka shell"
}

install_skills() {
  if [[ ! -d "$SKILLS_SRC" ]]; then
    echo "org skill pack not found at $SKILLS_SRC; skipping" >&2
    return 0
  fi
  mkdir -p "$HOME/.agents/skills"
  ln -sfn "$SKILLS_SRC" "$HOME/.agents/skills/staka"
  echo "linked org skill pack"
}

enable_compositor() {
  if [[ ! -f /usr/lib/systemd/user/staka-compositor.service ]]; then
    return 0
  fi
  mkdir -p "$(getent passwd "$TARGET_USER" | cut -d: -f6)/.config/systemd/user/graphical-session.target.wants"
  ln -sf /usr/lib/systemd/user/staka-compositor.service \
    "$(getent passwd "$TARGET_USER" | cut -d: -f6)/.config/systemd/user/graphical-session.target.wants/staka-compositor.service"
  echo "enabled staka-compositor for graphical session"
}

enable_agent() {
  if [[ ! -f /etc/staka/machine.token ]]; then
    echo "no machine token; agent unit not enabled" >&2
    return 0
  fi
  mkdir -p "$(getent passwd "$TARGET_USER" | cut -d: -f6)/.config/systemd/user/default.target.wants"
  ln -sf /usr/lib/systemd/user/staka-agent.service \
    "$(getent passwd "$TARGET_USER" | cut -d: -f6)/.config/systemd/user/default.target.wants/staka-agent.service"
  echo "enabled staka-agent for next login"
}

fix_token_permissions() {
  if [[ ! -f /etc/staka/machine.token ]]; then
    return 0
  fi
  $SUDO chown "$TARGET_UID:$(id -g "$TARGET_USER")" /etc/staka/machine.token
  if [[ -f /etc/staka/activation.json ]]; then
    $SUDO chown "$TARGET_UID:$(id -g "$TARGET_USER")" /etc/staka/activation.json
  fi
  if [[ -f /etc/staka/org-url ]]; then
    $SUDO chown "$TARGET_UID:$(id -g "$TARGET_USER")" /etc/staka/org-url
  fi
  echo "fixed token ownership for agent access"
}

# $HOME differs between root and user contexts; pin it to the target user.
HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
install_model_env() {
  # Demo mode: /opt/staka/demo.env carries the model environment for the
  # agent (STAKA_MODEL_* lines). Present only in demo ISO builds.
  if [[ ! -f /opt/staka/demo.env ]]; then
    return 0
  fi
  local dropin_dir="$HOME/.config/systemd/user/staka-agent.service.d"
  mkdir -p "$dropin_dir"
  # Lines before any section header are rejected as "assignment outside of
  # section", so the [Service] header must lead the drop-in.
  {
    echo "[Service]"
    # Skip empty lines: a bare Environment= would clear the accumulated list.
    grep -v '^[[:space:]]*$' /opt/staka/demo.env | sed 's/^/Environment=/'
  } > "$dropin_dir/staka-model.conf"
  if [[ $(id -u) == "0" ]]; then
    chown -R "$(id -u "$TARGET_USER"):$(id -g "$TARGET_USER")" "$HOME/.config/systemd"
  fi
  echo "installed model environment from demo.env"
}

mask_idle_lock() {
  # Demo mode: keep the session awake (hypridle would lock mid-presentation).
  if [[ ! -f /opt/staka/demo.env ]]; then
    return 0
  fi
  ln -sf /dev/null "$HOME/.config/systemd/user/hypridle.service"
  echo "masked hypridle for demo"
}

apply_demo_org_url() {
  # Demo builds reach the host org server through the QEMU user-net gateway.
  # An org URL recorded on another network silently degrades the agent to a
  # state where /chat answers 404, so demo mode pins it explicitly.
  if [[ ! -f /opt/staka/demo.env ]]; then
    return 0
  fi
  local url
  url=$(grep -E '^STAKA_DEMO_ORG_URL=' /opt/staka/demo.env | head -1 | cut -d= -f2-)
  if [[ -z $url ]]; then
    url="http://10.0.2.2:8080"
  fi
  if [[ -f /etc/staka/org-url ]] && grep -qxF "$url" /etc/staka/org-url; then
    return 0
  fi
  printf '%s' "$url" | $SUDO tee /etc/staka/org-url >/dev/null
  $SUDO chown "$TARGET_UID:$(id -g "$TARGET_USER")" /etc/staka/org-url
  echo "wrote demo org url $url"
}

install_agent_binary
install_compositor_binary
install_agent_unit
install_compositor_unit
install_shell
install_skills
enable_agent
enable_compositor
fix_token_permissions
apply_demo_org_url
install_model_env
mask_idle_lock
