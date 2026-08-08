# ADR-0023 Printer Core Gate 11 Device Fingerprint Prep

## Context

Gate 9.5 and Gate 10 preparation confirmed that K2 Pro Combo command and CFS
topology work must not rely on hostname, IP address, or one MAC address as a
physical printer identity. The local F012 machine also reports different wired
and wireless MAC addresses, so a single network interface identifier is only an
endpoint alias.

Before Data Schema v3 and command authority, Printer Core v3 needs a stable
shape for observed identity evidence:

```text
HTTP /info
WS9999 status
endpoint address
wired/wireless MAC aliases
reported model / hostname / firmware
```

This gate does not create the final `devices` or `deviceEndpoints` stores. It
keeps the existing `connectionTargets[].printerCoreV3Identity` dry-run storage
and makes the evidence shape explicit inside that candidate.

## Decision

- Add a `DeviceFingerprint` shape to `dashboard_device_identity.js`.
- Store the fingerprint under each identity candidate as:

```text
printerCoreV3Identity.deviceFingerprint
```

- Keep the existing `deviceIdSeed` selection unchanged:

```text
serial          -> serial:<value>
stableMachineId -> machine:<value>
fallback        -> provisional:<model>:<hostname|endpoint>
```

- Keep MAC addresses under endpoint aliases. They are never used as the
physical-device seed.
- Preserve source provenance in the fingerprint:

```text
sources: ["http-info"]
sources: ["ws9999"]
sources: ["http-info", "ws9999"]
```

- Preserve transport evidence when available:

```text
httpInfoObserved
ws9999Observed
wssPort
videoPort
```

- Merge fingerprints when two identity candidates are merged, so endpoint aliases
and observed sources survive DHCP transfer or wired/wireless transitions.

## Non-Goals

- No Data Schema v3 store is created.
- No migration writes are performed.
- No command authority is enabled.
- No hostname-as-stable-ID removal is attempted in this small prep slice.
- No PrinterSession multi-transport lifecycle is introduced yet.

## Consequences

Gate 11 can now move `/info` and WS9999 identity evidence toward a future
`DeviceFingerprint` / `DeviceEndpoint` schema without changing active UI,
connection, command, or ledger behavior.

The next Gate 11 slices can use this fingerprint as the bridge for:

```text
connectionTargets dry-run identity
        -> DeviceFingerprint
        -> devices / deviceEndpoints migration
        -> one physical device with multiple sessions/transports
```

Because this is still dry-run evidence, conflicts and pending candidates remain
visible in the existing plural evidence arrays.
