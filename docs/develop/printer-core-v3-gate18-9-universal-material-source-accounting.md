# Printer Core v3 Gate 18.9 Universal Material Source Accounting

Gate 18.9 introduces the source-aware accounting model that sits between the
Gate 18.7 read-only material source observation store and later production
ledger/UI authority.

The authoritative decision is ADR-0036. This document is the implementation
spec and review checklist.

## Goal

All FDM printers use the same accounting shape:

```text
Device -> FilamentUnit -> MaterialSource -> SpoolMount -> Ledger
```

K1 direct spool operation is `sources.length === 1`. K2/CFS and K1C/CFS-C are
multi-source topologies. The accounting code must not special-case printer type
as the reason a device has one or many sources.

## Non-Goals

Gate 18.9 does not certify unknown LAN commands for CFS standalone slot
operation. It does not make read-only device observations into ledger authority.
It does not auto-correct 3dpmon spool inventory from RFID or device remaining
values.

## Gate 18.9A Scope

Gate 18.9A defines the universal topology and SpoolMount authority contracts.

Initial review commits were intentionally narrow:

1. Documentation only: ADR-0036, this spec, and open-work updates.
2. Pure contract module and unit tests only.

The accepted Gate 18.9A contract baseline is `4ff7b06`. Follow-up pure
repository commits may add in-memory `MaterialSourceRegistry` and
`SpoolMountRepository` modules, but must still avoid production storage,
legacy debit, or UI behavior changes.

The first production-connected code must not change IndexedDB version, `hostSpoolMap`,
`mountHistory`, `usageHistory`, `dashboard_spool.js`, aggregator debit paths, or
UI behavior.

## Gate 18.9A Contract Surface

Create `3dp_lib/printer_core/dashboard_material_accounting_contract.js` with
pure functions and frozen enums only.

The contract module is allowed to import only pure helpers. It must not import:

- `dashboard_data.js`
- `dashboard_storage.js`
- `dashboard_storage_idb.js`
- `dashboard_spool.js`
- DOM/UI modules

Required enums:

- `FILAMENT_UNIT_KIND`
- `MATERIAL_SOURCE_KIND`
- `MATERIAL_IDENTITY_STRENGTH`
- `SPOOL_MOUNT_STATUS`
- `SPOOL_MOUNT_VERIFICATION`
- `MATERIAL_ACCOUNTING_BACKEND`
- `MATERIAL_ACCOUNTING_MIGRATION_STATUS`
- `DEBIT_ELIGIBILITY_STATUS`

Required factories:

- `createFilamentUnitRecord(input)`
- `createMaterialSourceRecord(input)`
- `createSpoolMountRecord(input)`
- `createMaterialAccountingCutoverRecord(input)`
- `createMaterialSourceAccountingView(input)`

Required validation:

- `validateFilamentUnit(record)`
- `validateMaterialSource(record)`
- `validateSpoolMount(record)`
- `validateMaterialAccountingCutover(record)`

Required identity helpers:

- `createDirectFeedUnitIdentity(input)`
- `createMaterialSourceIdentity(input)`
- `createMaterialSourceLocator(input)`

Required debit policy helper:

- `evaluateMaterialDebitEligibility(input)`

Optional shape helper:

- `createSourceSpecificMaterialUsageEvidence(input)`

This helper normalizes source-specific usage evidence fields only. It does not
issue debit authority. Gate 18.9A intentionally has no public trusted usage or
trusted print-start snapshot issuer.

## Gate 18.9A Migration Planner Dry-Run

Create `3dp_lib/printer_core/dashboard_material_accounting_migration_planner.js`
as a pure module after the repository baseline is hardened. The planner reads
legacy `hostSpoolMap` and read-only `materialSourceObservations`, but it must not
write IndexedDB, mutate `monitorData`, close legacy mount intervals, or activate
universal writes.

The dry-run planner classifies each legacy host spool assignment:

- `READY`: a known single source can be represented as one `FilamentUnit`, one
  `MaterialSource`, and one migrated `SpoolMount`.
- `CANDIDATE`: multiple material sources are observed, so the legacy host-level
  spool assignment needs an operator/source decision before it can become a
  source-aware mount.
- `BLOCKED`: the device is known to require topology evidence, but no material
  topology observation is available.

K2/CFS and K1C/CFS-C devices must not be treated as direct-only merely because a
legacy `hostSpoolMap` entry exists. For multi-source devices, `hostSpoolMap` is a
compatibility projection and never a source-aware debit authority.

The dry-run planner may recommend only `planned`, `candidate`, `ready`, or
`blocked`. It must not emit `shadow`, `failed`, or `sealed`, because those are
execution or cutover transaction results. The planner also must not use
`MaterialAccountingCutoverRecord` as its primary return shape; cutover records are
created later by the execution/readiness boundary.

`READY` requires a valid legacy spool record plus either explicit `single-spool`
configuration or a fresh `complete` material topology observation with exactly
one direct/external source. K1/K1 Max are not blindly assumed to be single-source
if the saved target does not state that topology. A partial, stale, restored, or
disconnected observation is evidence that migration needs a new read, not
authority to create a migrated mount.

Migration blocker/reason strings are owned by
`MATERIAL_ACCOUNTING_MIGRATION_BLOCKER`; planner branches and UI copy must not
invent ad-hoc reason identifiers. The initial fixed reasons include multi-source
legacy ambiguity, source confirmation requirement, missing material topology,
open mount conflict, legacy interval conflict, source identity conflict, device
identity insufficiency, and missing legacy spool evidence.

Migration lifecycle transitions are fixed by
`canTransitionMaterialAccountingMigrationStatus()`:

| From | Allowed next states |
| ---- | ------------------- |
| `planned` | `candidate`, `ready`, `blocked` |
| `candidate` | `ready`, `blocked` |
| `ready` | `shadow`, `blocked` |
| `shadow` | `sealed`, `failed`, `blocked` |
| `blocked` | `candidate`, `ready`, `failed` |
| `failed` | `planned`, `blocked` |
| `sealed` | none |

This table intentionally prevents `planned -> sealed` and `candidate -> shadow`
shortcuts. `shadow`, `failed`, and `sealed` are produced by execution or
cutover boundaries, not by dry-run analysis.

## Identity Rules

`materialSourceId` is an accounting identity. `locator` is where the source was
found. UI labels are labels only.

The contract must represent:

- K1/K1 Max/IR3 direct source
- K2 external-only source
- K2 external plus one to four CFS units
- CFS-C provider sources
- stable device/unit evidence
- provisional endpoint/location evidence

Provisional CFS sources may have manual SpoolMount records. They may debit only
after print-start continuity is revalidated and after a later repository-owned
issuer has created trusted usage and trusted print-start binding evidence.

## SpoolMount Continuity Rules

SpoolMount is operator-managed state. It is not automatically closed by device
observation.

These observations keep the mount open:

- restart
- reconnect
- provider stale
- temporary detach
- selected source change
- tool assignment change
- RFID unavailable
- source unobserved
- explicit empty/unloaded state

However, the following block auto debit until revalidation or operator
confirmation:

- no fresh topology for provisional source
- source ambiguity
- source identity conflict
- stable RFID mismatch
- different stable CFS unit
- complete topology source disappearance
- explicit physical empty/unloaded discontinuity

`SpoolMount` status `BLOCKED` is an accounting quarantine state owned by the
repository/operator. Provider stale, RFID unavailable, unknown remaining, or a
normal unloaded observation must not be converted into `BLOCKED`; those signals
only suspend debit eligibility until continuity is revalidated.

This is the key rule:

```text
SpoolMount continuity != Debit eligibility
```

## Remaining Provenance

The UI and ledger must keep these streams separate:

- device-reported remaining
- 3dpmon confirmed ledger remaining
- projected remaining
- actual usage evidence

Device remaining is display/diagnostic evidence. It cannot directly mutate
managed spool remaining. If the operator accepts it, a later gate must append a
correction ledger event with explicit provenance.

## Legacy Cutover Rules

Before a device becomes universal-authoritative, its legacy mount interval must
be sealed with the last legacy completed print ID.

Starting universal-shadow observation is not a cutover and must not seal the
legacy interval. Sealing legacy accounting is valid only as part of an
authority cutover to `universal-authoritative`.

`createMaterialAccountingCutoverRecord(input)` requires explicit `fromBackend`
and `toBackend`. A sealed cutover is valid only for
`legacy-single-source -> universal-authoritative`.

Future jobs after the cutover must not be included in legacy derivation.

`hostSpoolMap` remains a compatibility projection while migration is incomplete.
It is not a debit authority for multi-source devices.

## Gate 18.9B Scope

Gate 18.9B connects usage attribution:

- trusted print-start material binding snapshot issuer/repository
- `JobMaterialSegment`
- trusted source-aware usage evidence issuer/repository
- append-only `FilamentLedgerEvent`
- pending/unattributed isolation
- idempotent debit evaluation

Completion handling must use the print-start snapshot, not the current mount at
completion time.

When a repository sees the same stable usage idempotency identity again, it must
treat an identical payload as duplicate/no-op. If the same idempotency identity
arrives with a different usage payload, the repository must not overwrite the
existing event; it must create conflict/correction evidence instead.

## Gate 18.9C Scope

Gate 18.9C adds the read model and UI cutover:

- `MaterialSourceAccountingView`
- legacy compatibility projection for `N=1`
- multi-source cards for `N>1`
- source-specific remaining and usage display

The same domain model feeds both layouts.

## Test Matrix

Gate 18.9A tests:

- direct K1 source creates one `printer-direct` unit and one source
- K2 external-only creates one source
- K2 plus four CFS units and external source can represent 17 sources
- duplicate source IDs fail validation
- source locator and source ID are distinct
- MaterialSourceRegistry stores K1 direct `N=1` and K2/CFS `N>1` sources through the same API
- MaterialSourceRegistry keeps locator keys separate from stable identity keys
- MaterialSourceRegistry reports locator/stable identity conflicts without auto-overwriting records
- MaterialSourceRegistry rejects updates that reuse one `materialSourceId` for a different device or identity
- MaterialSourceRegistry rejects updates that reuse one `materialSourceId` for a different unit, kind, or identity strength
- MaterialSourceRegistry rejects provisional locator rebinding through generic `upsertSource()`
- MaterialSourceRegistry canonicalizes equivalent locator shapes before indexing
- MaterialSourceRegistry returns invalid results, not thrown exceptions, for stable sources without identity evidence
- MaterialSourceRegistry rejects identity evidence that disagrees with the source device, unit, or kind
- MaterialSourceRegistry rejects identity/locator slot or index mismatches
- SpoolMountRepository limits open mount per source to one
- SpoolMountRepository limits open mount per spool to one across devices
- SpoolMountRepository treats same `mountOperationId` + same payload as idempotent
- SpoolMountRepository treats same `mountOperationId` + different payload as conflict
- SpoolMountRepository closes an open interval only through a dedicated close API
- SpoolMountRepository keeps mount creation idempotency stable after the mount is later closed
- SpoolMountRepository keeps mount creation idempotency stable after repository snapshot restore
- SpoolMountRepository rejects `BLOCKED -> CLOSED` transitions through `closeMount()`
- SpoolMountRepository treats `closeOperationId` retries as idempotent only for the same semantic close payload
- SpoolMountRepository rejects overlapping historical intervals for the same source or spool
- physical empty/unloaded evidence does not close a mount but blocks debit
- RFID `null` does not block continuity
- RFID mismatch blocks debit
- provisional source after restart requires fresh revalidation before debit
- public usage evidence shape factory does not mint debit authority
- plain print-start snapshot does not mint debit authority
- migration lifecycle status is fixed by enum and unknown status is invalid
- sealed legacy-to-shadow cutover is invalid
- migration dry-run planner maps K1 direct-only `hostSpoolMap` to one direct source and one migrated mount
- migration dry-run planner leaves K2/CFS multi-source `hostSpoolMap` as a candidate without spoolMount writes
- migration dry-run planner blocks K2 hosts without material topology observations instead of assuming direct-only
- migration dry-run planner rejects `shadow` / `failed` / `sealed` as direct planner decisions

Gate 18.9B tests:

- `1A=3210mm`, `1B=6543mm`, `1D=1234mm` debit separate mounts
- `1C=0mm` is confirmed only with a complete source-specific result set
- incomplete result set leaves `1C` as unknown
- total-only multi-source usage becomes pending/unattributed
- print-start snapshot keeps attribution stable after current mount changes
- duplicate completion is idempotent

Gate 18.9C tests:

- N=1 keeps familiar K1 spool card behavior
- N>1 renders source-aware cards
- stale observation is last-known, not current
- device remaining and ledger remaining are visually distinct

## Review Boundaries

First review request:

```text
Base: main f6b8f6ce
Head: <contract commit>
Scope:
- ADR-0036
- Gate 18.9 implementation spec
- pure Universal MaterialSource accounting contracts
- no storage, UI, ledger, or legacy debit behavior changes
```

Expected outcome:

- current v2 behavior remains unchanged
- no IndexedDB schema change
- no hostSpoolMap write change
- no debit path change
- P0/P1 invariants are represented in contracts and tests
