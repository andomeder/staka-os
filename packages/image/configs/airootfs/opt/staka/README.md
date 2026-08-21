# Staka ISO agent artifacts

The ISO build stages these files into the live environment at `/opt/staka/`.
`staka-agent-setup.sh` (run post-install in the target chroot) installs them
onto the installed system.

Expected layout:

    /opt/staka/
      agent/
        staka-agent           compiled agent binary (bun build --compile)
        staka-agent.service   systemd user unit
      shell/                  QuickShell fork (packages/shell/ tree)
        bin/staka-shell
        bin/staka-toggle-panel
        hyprland/staka-keybinds.conf.lua
        shell/                QML sources
      skills/                 org skill pack (symlinked to ~/.agents/skills/staka)

The build script populates this directory before running mkarchiso.
If artifacts are missing, `staka-agent-setup.sh` skips each step gracefully.
