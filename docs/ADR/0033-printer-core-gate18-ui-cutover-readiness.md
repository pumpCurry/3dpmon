# ADR-0033: Printer Core v3 Gate 18 UI Cutover Readiness

## Status

Accepted as a fail-closed cutover readiness contract.

## Context

The long-term endpoint of Printer Core v3 is to let UI, commands, print
planning, material accounting, and legacy retirement depend on normalized Core
state instead of raw K1/K2 JSON paths.

However, the current branch intentionally keeps several authorities disabled:

- Data Schema v3 writes are dry-run only
- command requests are contract-only and cannot send
- PrintPlans cannot start jobs
- material providers cannot drive the filament ledger
- v3 filament ledger events are candidates only
- K2 print state semantics still require certification by lifecycle captures

Cutting over UI authority before those conditions are satisfied would turn
review evidence into production authority.

## Decision

Add a Printer Core v3 UI cutover readiness contract.

Required readiness checks:

- `schemaV3WritesActive`
- `normalizedStateCertified`
- `k2PrintSemanticsCertified`
- `commandAuthorityCanSend`
- `printPlanCanStart`
- `materialProviderCanDriveLedger`
- `filamentLedgerCanAppend`
- `liveShadowDiffsClean`
- `legacyFallbackAvailable`

If any check is false or missing, the readiness report is blocked and
`assertPrinterCoreV3UiCutoverAllowed()` throws. A cutover plan can still be
created, but it keeps legacy authority in place.

Except for live shadow diff cleanliness derived from runtime shadow records,
readiness evidence must be derived from trusted source snapshots:

```text
{
  source: "<expected-authority-source>",
  trusted: true,
  ...source-specific state
}
```

Plain caller-supplied booleans, or caller-assembled `{ value, source, trusted }`
objects, do not satisfy readiness for non-live-shadow checks. This prevents
tests, review helpers, or feature flags from making cutover ready without
state from the relevant repository/authority/certification source.

The cutover assertion also recomputes readiness from source snapshots. Passing a
report-like object with `ready: true` is insufficient.

Even when all checks pass, the generated plan requires explicit manual cutover
and still does not retire legacy paths automatically.

## Non-Goals

- No UI replacement in this gate.
- No removal of legacy `processData()` or raw JSON UI paths.
- No command authority activation.
- No Data Schema v3 write activation.
- No filament ledger write activation.

## Consequences

Gate 18 becomes a reviewable final safety boundary for this implementation
sequence. The project can continue shipping dry-run and shadow contracts without
the risk that a feature flag or accidental import promotes Printer Core v3 to
authority before all prerequisites are proven.

The next practical work after this contract is to satisfy the blocked checks one
by one with live K2 lifecycle/CFS captures, schema activation, command authority,
and UI migration slices.
