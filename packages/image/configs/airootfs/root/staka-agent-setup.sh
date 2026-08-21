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

install_agent_binary() {
  if [[ ! -f "$AGENT_BIN_SRC" ]]; then
    echo "staka-agent binary not found at $AGENT_BIN_SRC; skipping" >&2
    return 0
  fi
  sudo install -m 755 "$AGENT_BIN_SRC" /usr/local/bin/staka-agent
  echo "installed staka-agent binary"
}

install_agent_unit() {
  if [[ ! -f "$AGENT_UNIT_SRC" ]]; then
    echo "staka-agent.service not found at $AGENT_UNIT_SRC; skipping" >&2
    return 0
  fi
  sudo install -Dm 644 "$AGENT_UNIT_SRC" /usr/lib/systemd/user/staka-agent.service
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
  mkdir -p "$HOME/.config/systemd/user/default.target.wants"
  ln -sf /usr/lib/systemd/user/staka-agent.service \
    "$HOME/.config/systemd/user/default.target.wants/staka-agent.service"
  echo "enabled staka-agent for next login"
}

fix_token_permissions() {
  if [[ ! -f /etc/staka/machine.token ]]; then
    return 0
  fi
  sudo chown "$(id -u):$(id -g)" /etc/staka/machine.token
  if [[ -f /etc/staka/activation.json ]]; then
    sudo chown "$(id -u):$(id -g)" /etc/staka/activation.json
  fi
  echo "fixed token ownership for agent access"
}

install_agent_binary
install_agent_unit
install_shell
install_skills
enable_agent
fix_token_permissions
