# Printer Protocol Fixtures

This directory stores sanitized real-device captures for Printer Core v3.

Each device fixture directory should contain:

- `metadata.json`: model, firmware, attachment, capture source, and redaction notes.
- `*.ndjson`: ordered protocol events exported by `ProtocolRecorder`.
- Optional `notes.md`: operator notes that explain the physical scenario.

Required Gate 0 baseline devices:

- `k1-max/device-a`
- `k1-max/device-b`
- `k2-pro-cfs`
- `ir3v2`

Pending external Gate 0 baseline:

- `k1c-cfs-c`: capture requires the separate K1C test environment because that printer is not reachable from the current development network.

Supported but not live-tested in this fixture set:

- K2 Plus: supported model family, but no local hardware is available for live-device fixture capture.
- K2 Pro without CFS: supported model family variant, but no local hardware is available for live-device fixture capture.

Live K2-family test target:

- K2 Pro Combo with CFS: represented by `k2-pro-cfs`; reported model `F012`.
- The `k2-pro-cfs` fixture was refreshed during Gate 6 with a read-only idle capture
  that observed HTTP `/info`, WebSocket 9999 status, and `boxsInfo` topology.

Fixture rules:

- Keep relative event order and relative timestamps.
- Redact IP addresses, MAC addresses, serial numbers, tokens, SSIDs, credentials, hostnames, print IDs, RFID values, and G-code file names.
- Treat wired and wireless MAC addresses as endpoint aliases, not as the physical printer identity.
- Preserve unknown raw fields after redaction.
- Do not include commands that move hardware unless the scenario explicitly requires a hardware smoke capture.
