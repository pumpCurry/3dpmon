# ADR-0008 Printer Core v3 Gate 0 Baseline

## Status

Accepted as the Gate 0 cutoff.

## Context

Gate 0 exists to freeze the first safe boundary before adapter and schema code starts changing application behavior. The project needs real protocol evidence for current K1 behavior, K2 Pro Combo behavior, and unavailable-device gaps, while keeping the production UI on the v2 route.

The development rule for this phase is dual-route friendly: v2 remains authoritative, and v3 modules may be added side by side as dry-run or fixture-backed code.

## Decision

Gate 0 includes these artifacts:

- `dashboard_protocol_recorder.js` records ordered, redacted protocol events without depending on Node-only APIs.
- `scripts/capture_protocol_fixture.mjs` captures read-only `/info` and WebSocket observations into `metadata.json`, `capture.json`, and `events.ndjson`.
- `dashboard_device_identity.js` defines the first device identity boundary. Serial number and stable machine-reported IDs are strong identity evidence; wired and wireless MAC addresses are endpoint aliases.
- Sanitized fixture sets exist for K1 Max device A, K1 Max device B, K2 Pro Combo with CFS, and the currently unreachable IR3V2 endpoint.
- K1C+CFS-C is recorded as a pending external capture because that printer is not reachable from the current development network.
- K2 Plus and K2 Pro without CFS remain supported model-family targets, but they are not live fixture requirements until hardware becomes available.

## Captured Devices

| Fixture | Gate 0 status | Notes |
| --- | --- | --- |
| `k1-max/device-a` | Captured | Read-only `/info` and WebSocket baseline. |
| `k1-max/device-b` | Captured | Read-only `/info` and WebSocket baseline. |
| `k2-pro-cfs` | Captured | K2 Pro Combo, reported model `F012`, read-only `boxsInfo` request included. |
| `ir3v2` | Captured as connectivity evidence | HTTP `/info` timed out during Gate 0 capture. |
| `k1c-cfs-c` | Pending external capture | Requires a separate K1C test environment. |
| K2 Plus | Supported, no live fixture | No local hardware is available. |
| K2 Pro without CFS | Supported, no live fixture | No local hardware is available. |

## Invariants Confirmed

- Fixture exports must preserve event order and non-decreasing relative timestamps.
- Public fixture files must not contain raw local IP addresses, IPv6 addresses, raw MAC addresses, serial numbers, credentials, SSIDs, hostnames, print IDs, RFID values, or G-code file names.
- A MAC address must not become the physical device ID. It is stored only as endpoint evidence.
- The K2 Pro Combo fixture remains `k2-pro-cfs`; it must not be relabeled as another K2-family product.

## Consequences

Gate 1 can start by wiring the identity and recorder boundaries into connection discovery without replacing the existing K1 path. K1C+CFS-C work remains blocked on access to the separate test environment, but the missing fixture is explicit and testable as a pending baseline item.
