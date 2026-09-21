#!/usr/bin/env bash
set -euo pipefail

# Staka agent + shell post-install setup.
# Runs inside the target chroot as the install user after the base system
# and Omarchy desktop are in place. Expects ISO artifacts staged at
# /opt/staka/ (copied there by .automated_script.sh before chroot).

AGENT_BIN_SRC="/opt/staka/agent/staka-agent"
AGENT_UNIT_SRC="/opt/staka/agent/staka-agent.service"
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

  # Wire the shell into the desktop: Super+A keybind (plain Hyprland syntax,
  # works regardless of Lua config support) and shell autostart.
  HYPRLAND_CONF="$HOME/.config/hypr/hyprland.conf"
  if [[ -f "$HYPRLAND_CONF" ]] && ! grep -q "staka-toggle-panel" "$HYPRLAND_CONF"; then
    {
      echo ""
      echo "# Staka AI panel (Super+A) + shell autostart"
      echo "bind = SUPER, A, exec, $HOME/.local/bin/staka-toggle-panel"
      echo "exec-once = quickshell -p $HOME/.local/share/staka/shell"
    } >> "$HYPRLAND_CONF"
    echo "wired staka shell into hyprland config"
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
  { echo "[Service]"; sed 's/^/Environment=/' /opt/staka/demo.env; } > "$dropin_dir/staka-model.conf"
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

install_agent_binary
install_agent_unit
install_shell
install_skills
enable_agent
fix_token_permissions
install_model_env
mask_idle_lock
