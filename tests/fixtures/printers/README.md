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

Fixture rules:

- Keep relative event order and relative timestamps.
- Redact IP addresses, MAC addresses, serial numbers, tokens, SSIDs, and credentials.
- Treat wired and wireless MAC addresses as endpoint aliases, not as the physical printer identity.
- Preserve unknown raw fields after redaction.
- Do not include commands that move hardware unless the scenario explicitly requires a hardware smoke capture.
