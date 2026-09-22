# VPN Setup Guide

Owner: IT Operations
Audience: all staff

## Connecting

1. Open the network settings and add a new WireGuard profile.
2. Import the config file issued during onboarding (`staka-vpn.conf`).
3. Toggle the VPN on before opening any internal service.

## Troubleshooting

- Handshake timeout: check that UDP port 51820 is not blocked by the
  local network.
- DNS not resolving: restart the tunnel; internal DNS only routes through
  the VPN.
- Lost config file: request a new one from IT Operations; configs are not
  reissued to the same device.

## Internal addresses

The file index, org dashboard, and package mirror resolve only inside the
tunnel.
