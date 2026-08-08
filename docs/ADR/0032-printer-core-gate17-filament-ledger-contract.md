# ADR-0032: Printer Core v3 Gate 17 Filament Ledger Contract

## Status

Accepted for dry-run contract implementation.

## Context

Printer Core v3 now has explicit single-color and multicolor/CFS PrintPlans.
The next boundary is filament consumption attribution. The legacy application
still owns the current mount-history ledger, so Gate 17 must not mutate
`monitorData`, `mountHistory`, spool remaining length, or existing print
history.

K2 Pro Combo live tests also showed a failure mode where a multicolor print can
run without a selected CFS source and consume no filament. That makes blind
usage attribution dangerous.

## Decision

Add a pure Printer Core v3 ledger contract module:

```text
PrintPlan
  + completion/material usage observation
      -> JobMaterialSegment candidates
      -> filamentLedger event candidates
```

Segment confidence is explicit:

```text
exact
high
estimated
unknown
```

Rules:

- single-color plans may bind total observed usage to the single material source
- multicolor/CFS plans require per-tool/per-source usage to produce exact or high
  segment usage
- multicolor total-only usage is not split across tools
- unknown segments remain auditable but cannot debit spool remaining length
- candidate ledger events are append-only shaped, but `canAppend = false` in this
  gate
- `canDebitRemaining = true` is only possible when a segment has `spoolId`,
  positive numeric usage, and non-unknown confidence

## Non-Goals

- No writes to legacy filament ledger or Data Schema v3 stores.
- No remaining length mutation.
- No UI cutover.
- No command send authority.
- No automatic mapping from CFS material source to spool identity.

## Consequences

Gate 17 gives command/print authority a safe accounting boundary without
promoting read-only CFS observations into confirmed spool usage. It also makes
the dry-run style print failure observable: a job can produce unknown or zero
segments instead of silently subtracting filament from the wrong spool.

Future gates can connect these candidates to Data Schema v3 repositories and to
operator-confirmed spool mounts, but only after spool identity and material
source mapping are authoritative.
