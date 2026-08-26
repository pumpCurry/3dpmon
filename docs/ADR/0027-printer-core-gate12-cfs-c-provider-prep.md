# ADR-0027 Printer Core Gate 12 CFS-C Provider Prep

## Status

Accepted for Gate 12 offline/provider-contract preparation.

## Context

Gate 12 validates K1C + CFS-C / K1+CFS provider behavior, but the K1C test
environment is not on the current printer network. The code can still prepare
the provider boundary without pretending that live K1C/CFS-C semantics are
certified.

The important pre-authority invariant is:

```text
printer identity
  != CFS/CFS-C attachment identity
  != spool identity
```

Attaching or detaching a CFS-C unit must not change the printer device identity,
and read-only material observations must not drive the filament ledger.

## Decision

- Keep `createCfsBoxsInfoMaterialProvider()` as the K2 WS9999 provider.
- Add `createCfsMoonrakerBoxMaterialProvider()` for K1C/CFS-C read-only provider
  preparation.
- Add `extractMoonrakerBoxsInfoPayload()` to unwrap common Moonraker envelopes:

```text
boxsInfo
boxs_info
result.boxsInfo
result.boxs_info
params.boxsInfo
params.boxs_info
data.boxsInfo
data.boxs_info
```

- Reuse the existing normalized material topology contract:

```text
units[]
sources[]
assignments[]
sameMaterialGroups[]
diagnostics[]
```

- Add provider metadata so downstream code can distinguish evidence sources
  without changing the topology shape:

```text
providerId
transportKind
sourceProtocol
readOnly
canDriveLedger=false
```

The Moonraker provider remains an observation provider. It does not send load,
unload, select, print, or assignment commands.

## Non-Goals

- No K1C/CFS-C live certification in this commit.
- No Moonraker command authority.
- No Data Schema v3 store activation.
- No filament ledger writes.
- No spool mount writes.
- No claim that `selected`, `percent`, or assignment fields prove physical
  extrusion.

## Consequences

Gate 12 can now plug K1C/CFS-C fixtures or live read-only probes into the same
Printer Core material topology surface used by K2 Pro Combo. If K1C/CFS-C
firmware returns a shape that differs from K2 `boxsInfo`, the adapter/provider
translation layer can change without altering the normalized topology contract.

This keeps the path toward Data Schema v3 clear:

```text
provider observation
  -> Normalized material topology
  -> future MaterialSource repository
  -> future spool mount / ledger authority
```

Only the last two steps are authority-bearing, and they remain outside this
Gate 12 preparation slice.
