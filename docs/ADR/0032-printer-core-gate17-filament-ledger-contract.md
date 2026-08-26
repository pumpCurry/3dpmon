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
- exact/high/estimated confidence must be explicit in observation evidence;
  omitted or unknown confidence stays `unknown`
- exact/high/estimated confidence requires internally issued confidence
  evidence; public callers cannot mint exact/high evidence by naming a trusted
  source, and a caller-provided confidence string alone is treated as `unknown`
- multicolor total-only usage is not split across tools
- unknown segments remain auditable but cannot debit spool remaining length
- candidate ledger events are append-only shaped, but `canAppend = false` in this
  gate
- `canDebitRemaining = true` is only possible when a segment has `spoolId`,
  positive numeric usage, and internally trusted exact/high confidence evidence;
  Gate 17/18 public APIs therefore stay fail-closed and produce non-debit
  candidates until the provider/repository owner issues that evidence
- consumption events carry a stable `consumptionIdentity` derived from the
  segment, so an estimated-to-exact update does not create a second independent
  positive consumption identity
- corrections use `material-consumption-correction`, `correctsLedgerEventId`,
  `supersedesLedgerEventId`, and signed `deltaUsedLengthMm`
- correction event IDs are unique per `consumptionIdentity` and `eventRevision`
  so two different payloads for the same revision collide as an idempotency
  conflict instead of appending twice
- correction creation must match the original event's `segmentId`, `printJobId`,
  `deviceId`, `materialSourceId`, and `spoolId`; changing source/spool identity
  is a different reallocation/reversal event type, not a usage correction
- `toolId` and used-length parsing is strict. Boolean, blank string, arrays, and
  other JavaScript-coercible values are not treated as `0`.
- A usage entry with an invalid `toolId` is ignored entirely, including alias or
  material-source fallback, so malformed observations cannot debit tool 0.

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

The contract is intentionally conservative about confidence. A per-material
usage amount without confidence remains useful evidence, but it cannot debit
remaining filament until a trusted observation source explicitly marks it
`exact`, `high`, or `estimated`. Current dry-run code derives confidence from a
fixed source/method policy before issuing module-private attestation, so callers
cannot request an arbitrary `exact` signature. Data Schema v3 should replace
this placeholder with a persistent confidence policy registry such as:

```text
firmware-reported-total -> high
slicer projection       -> estimated
trusted counter         -> exact
unknown caller          -> unknown
```

Later exact measurements should be appended as correction events rather than as
additional independent consumption events for the same segment.

If two corrected payloads are proposed for the same revision, the repository
must reject the second one as an idempotency conflict unless it is byte-for-byte
equivalent to the first.

Future gates can connect these candidates to Data Schema v3 repositories and to
operator-confirmed spool mounts, but only after spool identity and material
source mapping are authoritative.
