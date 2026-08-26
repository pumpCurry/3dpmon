# ADR-0028 Printer Core Gate 13 Data Schema v3 Dry-Run

## Status

Accepted for Gate 13 schema contract preparation.

## Context

Gate 13 introduces Data Schema v3 and migration, but activating new persistent
stores too early would make review harder and could put legacy data at risk.
The project already allows dual-route development, so the first safe step is to
freeze the v3 store contract and migration counts as pure data.

ADR-0007 defines the long-term v3 stores:

```text
meta
devices
deviceEndpoints
capabilitySnapshots
printJobs
gcodeAssets
printPlans
filamentUnits
materialSources
spools
spoolMounts
jobMaterialSegments
filamentLedger
settings
migrationJournal
protocolCaptures
```

## Decision

- Add `dashboard_data_schema_v3.js` under `3dp_lib/printer_core/`.
- Expose v3 store definitions as immutable contract data.
- Add deterministic migration helpers:

```text
stableStringifyPrinterCoreV3Value()
createPrinterCoreV3DeterministicId()
```

- Add `createPrinterCoreV3MigrationPlan()` as a dry-run only planner.
- Add `validatePrinterCoreV3MigrationPlan()` so CI can reject accidental
  authority activation in this gate.
- The dry-run plan includes:

```text
source checksum
legacy record counts
planned v3 write counts
store definitions
invariants
warnings
```

The dry-run plan explicitly keeps:

```text
activateV3Writes = false
preserveLegacyData = true
requiresJournalBeforeActivation = true
```

## Non-Goals

- No IndexedDB `DB_VERSION` upgrade.
- No object store creation in production storage.
- No migration journal write.
- No deletion or mutation of legacy v2 data.
- No v3 repository authority.
- No UI, command, print, or ledger cutover.

## Consequences

Gate 13 now has a concrete reviewable schema boundary before storage activation.
Future commits can wire this definition into `dashboard_storage_idb.js` upgrade
logic and then add v3 repositories, but any such change must preserve the dry-run
invariants until an explicit activation gate.

The dry-run count mapping is intentionally conservative:

```text
legacy connectionTargets -> deviceEndpoints
legacy machines          -> devices candidates
legacy print history     -> printJobs
legacy filamentSpools    -> spools
legacy mountHistory      -> spoolMounts
legacy usageHistory      -> filamentLedger
```

Counts are not yet proof that all v3 references can be resolved. Reference
validation belongs to the next Gate 13 slice, after this schema contract is
reviewed.
