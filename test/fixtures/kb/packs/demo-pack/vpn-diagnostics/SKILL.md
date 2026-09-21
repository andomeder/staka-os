---
name: vpn-diagnostics
description: Diagnose common VPN connection problems on a Staka workstation. Use when the user reports tunnel handshake failures, missing internal DNS, or a lost VPN config.
---

# VPN Diagnostics

Quick diagnosis path for WireGuard tunnel problems.

## Steps

1. Confirm the tunnel interface exists and is up.
2. If handshake times out, check that UDP port 51820 is reachable.
3. If internal names do not resolve, restart the tunnel; internal DNS
   only routes through the VPN.
4. For a lost config file, request a reissue from IT Operations; configs
   are never reissued to the same device.
