# ADR-0017 Printer Core Gate 7.5 Contract Hardening

## Context

Gate 1 through Gate 7 established identity dry-run evidence, K1 normalized
shadowing, K2 Pro Combo read-only CFS observation, live validation helpers, and
scenario markers. Reviews left several non-blocking concerns that would become
expensive or ambiguous once Printer Core v3 starts acting as authority.

The risky areas were cross-gate contracts rather than one isolated feature:

- identity conflict resolution could close the singleton record while leaving
  plural evidence open.
- `materialDetect` and `materialStatus` were too broad to mean an external
  material source.
- K2 `boxsInfo` topology did not explicitly carry ledger-safety metadata,
  raw/normalized remaining evidence, or topology diagnostics.
- `PrinterInstance.observeFrame()` and `PrinterFacade.observeFrame()` still used
  a legacy-compatible union return shape.
- K2 print status is currently K1-compatible normalization, not a certified K2
  print-lifecycle contract.

## Decision

- Keep existing `observeFrame()` behavior for compatibility, and add
  `observeFrameResult()` as the forward contract:

```text
{ accepted: true, state }
{ accepted: false, reason, ... }
```

- Add stable `PrinterFacadeSessionError.code` values and make live shadow prefer
  codes over error-message text when deciding whether a missing session is
  recoverable.
- Resolve identity conflicts in both:

```text
printerCoreV3IdentityConflict
printerCoreV3IdentityConflicts[]
```

- Split material capability vocabulary:

```text
material.filamentSensor
material.externalSource
```

`materialDetect` and `materialStatus` now imply a filament sensor only.
`material.externalSource` requires an observed external source in `boxsInfo`.

- Add a read-only MaterialProvider boundary for K2 CFS `boxsInfo`.
- Mark material topology as read-only observation with:

```text
authority.mode = "read-only-observation"
authority.canDriveLedger = false
```

- Preserve reported filament remaining evidence as:

```text
rawPercent
normalizedPercent
valid
provenance
confidence
authority
```

- Keep malformed or ambiguous CFS topology visible through `diagnostics[]`
  instead of silently selecting a single interpretation.
- Mark K2 print state normalization as provisional:

```text
print.semantics.mapping = "k1-compatible-provisional"
print.semantics.certified = false
```

## Consequences

Gate 7.5 does not promote K2 or CFS data to UI, command, or filament-ledger
authority. It makes the next gates safer by ensuring provisional observations
are distinguishable from certified state and by giving callers an explicit
accepted/rejected result contract.

The compatibility APIs remain in place, so existing Gate 1 through Gate 7 tests
and live shadow wiring do not need a broad rewrite.
