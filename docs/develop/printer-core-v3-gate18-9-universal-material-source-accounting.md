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

Each plan separates the full dry-run batch, each host-to-spool migration case,
and the exact evidence revision:

- `migrationBatchId`: stable batch identity for the full `hostSpoolMap`
- `migrationSubjectId`: compatibility alias for the plan batch ID
- `entries[].migrationSubjectId`: stable subject for one legacy host-to-spool
  migration case
- `entries[].confirmationEvidenceChecksum`: confirmation-before-decision
  evidence checksum for that one entry
- `entries[].confirmationRevisionId`: revision ID derived from the entry
  confirmation evidence checksum
- `planRevisionId`: evidence/checksum revision for the exact dry-run decision
- `migrationId`: compatibility revision ID derived from `planRevisionId`

The decision checksum includes `createdAt` because topology freshness is decided
against the plan creation time. A later re-plan with the same legacy assignment
but stale topology therefore creates a new revision instead of reusing an older
READY journal entry.

Single-spool operator confirmations are bound to
`entries[].migrationSubjectId` and to that entry's
`confirmationEvidenceChecksum`. The planner first computes the entry evidence
checksum without migration confirmations, accepts only confirmations whose
`migrationSubjectId` and `evidenceChecksum` match that projection, then computes
the final `source.checksum` with the accepted confirmation projection. This
avoids a checksum cycle while still forcing re-confirmation when freshness,
device identity, topology, spool, or repository evidence changes. A confirmation
for `K1Max-4A1B -> spool-031` therefore survives unrelated changes to
`K1Max-03FA -> spool-032`, while the plan-level batch ID still changes for the
full dry-run batch.

The dry-run planner classifies each legacy host spool assignment:

- `READY`: a known single source can be represented as one `FilamentUnit`, one
  `MaterialSource`, and one shadow-execution `mountCandidate`. The dry-run
  planner never creates a production `SpoolMount` or fixes `openedAt` /
  `mountOperationId`; those fields are minted only by the later shadow executor.
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

`READY` requires a valid legacy spool record, stable device identity, unique
host-to-device resolution, no open `printerCoreV3IdentityConflict` /
`printerCoreV3IdentityConflicts[]` evidence, no open Universal MaterialSource
conflict for that device, no open Universal SpoolMount conflict for the target
spool/source, and either migration-specific operator confirmation for
`single-spool` or a fresh `complete` material topology observation with exactly
one direct/external source. K1/K1 Max are not blindly assumed to be single-source
if the saved target does not state that topology. Saved `materialSystem.mode` and
old materialSystem boolean flags such as `accountingTopologyConfirmed` are not
migration authority. A partial,
stale, restored, disconnected, future-dated beyond the allowed clock skew,
locator-incomplete, tombstoned/unobserved, or provisional/unknown source
observation is evidence that migration needs a new read or operator decision,
not authority to create a migrated mount.

Migration blocker/reason strings are owned by
`MATERIAL_ACCOUNTING_MIGRATION_BLOCKER`; planner branches and UI copy must not
invent ad-hoc reason identifiers. The initial fixed reasons include multi-source
legacy ambiguity, source confirmation requirement, missing material topology,
open mount conflict, legacy interval conflict, source identity conflict, source
identity insufficiency, material source locator incompleteness, device identity
insufficiency, ambiguous legacy host/device evidence, and missing legacy spool
evidence.

The dry-run validator recomputes `migrationStatus`, `summary.ready`,
`summary.candidate`, `summary.blocked`, and all `summary.plannedWrites` counts
from `entries[]`. Non-`READY` entries must not contain planned
`filamentUnits`, `materialSources`, `spoolMounts`, or `mountCandidates`.
Each entry's `reasons[]` must use identifiers from
`MATERIAL_ACCOUNTING_MIGRATION_BLOCKER`; unknown ad-hoc blocker names are
rejected during validation instead of being preserved as migration authority.
READY entries must contain exactly one planned `FilamentUnit`, exactly one
planned `MaterialSource`, zero production `SpoolMount` writes, and exactly one
shadow-execution `mountCandidate`. The validator runs the shared
`FilamentUnit` and `MaterialSource` validators, requires each planned
MaterialSource to belong to the entry device and to a planned unit in that same
entry, and requires READY `mountCandidates` to carry `openedAtPolicy:
shadow-execution-time` and `operationIdPolicy: shadow-execution-time` without
execution fields. They must also reference the entry spool and a planned
MaterialSource from the same entry. The validator additionally checks plan-level
`migrationSubjectId`, `planRevisionId`, `migrationId`, and `source` bindings.
This keeps persisted dry-run journal entries self-checking when Gate 18.9B
introduces IndexedDB journaling.

The source checksum includes the planner policy revision, schema version,
`createdAt`, TTL / clock-skew policy, accepted migration confirmation evidence,
legacy spool map, connection targets, machines, filament spool records, material
observations, and existing Universal MaterialSource / SpoolMount repository
snapshots. The confirmation-before-decision checksum explicitly excludes raw
`migrationTopologyConfirmations`; only the final source checksum contains the
accepted confirmation projection. Any dependency that can change a
READY/CANDIDATE/BLOCKED decision must change the checksum.

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

Gate 18.9B persists the dry-run migration plan as evidence only:

- `materialAccountingMigrationJournal`
- localStorage round-trip for legacy/no-IDB environments
- IndexedDB shared-store durability
- import/export normalization
- invalid or conflicting journal entry quarantine
- self-checking dry-run plan validation before journal insertion

The journal is not a production repository. It must not write
`MaterialSource`, `SpoolMount`, `mountHistory`, `usageHistory`, or managed spool
remaining values. It records only reviewed migration evidence so that restart,
import, and later cutover planning can continue from the same dry-run facts.

Journal invariants are:

```text
activateUniversalWrites = false
materialSourceRepositoryWrites = false
spoolMountRepositoryWrites = false
migrationJournalIsEvidenceOnly = true
```

Because `migrationId` is revision-derived, a fresh re-plan for the same
`migrationSubjectId` records a separate revision instead of overwriting a prior
decision. A malformed plan that tampers with `migrationId`, `planRevisionId`, or
source checksum is rejected before journal conflict handling. The journal also
stores a separate `planDigest` for the full plan body, so an imported or
resubmitted plan with the same `migrationId` and source checksum but a different
body is treated as a conflict instead of a no-op.

Stored journal restoration validates cross-binding before an entry is accepted:
the outer entry `sourceChecksum`, `planDigest`, and `migrationStatus`, when
present, must match the inner plan. Stored events are retained only when their
`migrationId`, `sourceChecksum`, `planDigest`, `recordedAt`, and deterministic
`eventId` match an accepted entry. A restored journal therefore cannot stitch a
valid plan to a different checksum/status/body/event trail.

The journal also exposes `latestRevisionBySubject`, rebuilt only from valid
entries during normalization. Stored copies of this index are treated as cache
data, not authority, so a corrupted or stale subject index cannot point the next
migration step at a plan that failed validation.

Malformed imported entries are quarantined in `retainedUnsupportedEntries`
without throwing. This includes `null` entries, missing `plannedWrites`,
non-array planned write fields, and broken `mountCandidates` shapes.

## Gate 18.9C Scope

Gate 18.9C starts with a pure shadow preflight evaluator before any production
repository write is enabled.

The evaluator takes:

- a dry-run migration journal
- an entry-level `migrationSubjectId`
- an execution-time `currentPlan` generated from current legacy state
- optional read-only `MaterialSourceRegistry` and `SpoolMountRepository` APIs

It must not trust a stored `READY` journal entry by itself. It first resolves
the latest valid revision for the requested subject, then compares that journal
entry with the current dry-run plan. Because `createdAt` and freshness are part
of the plan revision evidence, `derivedFromPlanRevisionId` and
`evaluatedPlanRevisionId` are allowed to differ. The required continuity is:

- same entry-level `migrationSubjectId`
- latest journal revision unless a newer revision is explicitly handled by UI
- requested entry is `READY`
- current entry is still `READY`
- same resolved `deviceId`
- same `spoolId`
- same `FilamentUnit`
- same `MaterialSource`
- same mount intent source/spool mapping
- stable current source identity
- subject latest status matches the requested entry status, not the aggregate
  plan status
- `evaluatedAt` is required and the current plan `createdAt` must be within the
  preflight freshness window
- no current MaterialSource registry locator/identity conflict
- no current open mount conflict for the source or spool
- MaterialSourceRegistry and SpoolMountRepository facades are mandatory; omitted
  facades mean the conflict check was not performed and therefore block

The preflight result may return `mountIntents`, but it must not mint
`openedAt`, `mountOperationId`, production `SpoolMount`, or ledger events. Those
execution fields belong to the later persistent shadow transaction adapter.

After this pure preflight is accepted, Gate 18.9D-1 prepares a staged shadow
transaction:

- the preflight result is the only input authority and must be the exact
  in-process trusted result issued by the preflight module
- `shadowOperationId` and `executedAt` are required
- `openedAt` and `mountOperationId` are minted only in this layer
- the returned object uses `transactionStatus: "prepared"` and
  `proposedMigrationStatus: "shadow"`; it does not claim the migration lifecycle
  is already `SHADOW`
- existing MaterialSource and SpoolMount snapshots are mandatory inputs; missing
  snapshots are not treated as empty production state
- snapshots that already contain registry/repository conflict evidence are
  blocked before staging so conflict evidence is not dropped by reconstruction
- `executedAt` must not be earlier than the preflight `evaluatedAt`
- existing MaterialSource and SpoolMount snapshots are loaded into staged
  repositories only after these snapshot guards pass
- all source and mount records must stage successfully before a transaction is
  returned
- failed staging returns no partial transaction
- the transaction still has no production store authority and no ledger debit
  authority

Gate 18.9D-2 then connects the staged candidate to persistent atomic shadow
commit/recovery:

- base MaterialSource/SpoolMount snapshot digest is checked at commit time
- the commit boundary accepts only the exact in-process trusted prepared
  transaction issued by the transaction module
- commit uses the base repository digests embedded in the trusted prepared
  transaction and compares them with the current shadow commit store snapshots
- stale base revision requires re-preflight and re-stage
- durable writers must apply the same compare-and-swap inside their persistence
  transaction and return `casApplied:true`
- only successful durable commit may emit the `SHADOW` lifecycle transition
- durable write failure keeps the previous shadow store and emits no lifecycle
  transition
- `materialAccountingMigrationShadowStore` is persisted and restored as shadow
  evidence without projecting into legacy `hostSpoolMap` or ledger debit
- same `shadowOperationId` and same transaction payload is idempotent, while the
  same operation ID with a different transaction payload is blocked
- restart/recovery restores durable shadow records without ledger debit

After the staged and persistent shadow transaction boundaries are accepted,
Gate 18.9E connects
usage attribution as a shadow-only repository:

- print-start material binding snapshots with tool/source assignment metadata
- source-specific `JobMaterialSegment` shadow records
- read-only source-aware usage evidence; the public repository does not mint
  debit-capable trusted usage evidence
- append-only shadow `FilamentLedgerEvent` candidates
- pending/unattributed isolation for total-only multi-source usage and
  source-specific/total residuals
- stable semantic idempotency without legacy inventory mutation

Completion handling must use the print-start snapshot, not the current mount at
completion time. Completion-supplied `PrintPlan.toolAssignments` are not used as
assignment authority; the saved print-start binding is.

When a repository sees the same stable usage idempotency identity again, it must
treat an identical payload as duplicate/no-op. If the same idempotency identity
arrives with a different usage payload, the repository must not overwrite the
existing event; it must create conflict/correction evidence instead.

Gate 18.9E remains shadow/read-only. Automatic spool debit requires a later
trusted result-set registry and live certification. A caller-declared
`resultSetCompleteness:"complete"` is not enough to mark an unobserved source as
`confirmed-unused`; the source must have explicit 0mm source-specific usage, or
the source remains `unknown`.

## Gate 18.9F Scope

Gate 18.9F connects the source-aware read model to the existing read-only UI lane:

- `MaterialSourceAccountingView`
- legacy compatibility projection for `N=1`
- multi-source cards for `N>1`
- source-specific remaining and usage display
- saved print binding store projection into source rows
- device-reported remaining and 3DPmon-managed remaining displayed as separate values

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
- migration dry-run planner maps operator-confirmed K1 direct-only `hostSpoolMap` to one direct source and one shadow-execution mount candidate
- migration dry-run planner leaves K2/CFS multi-source `hostSpoolMap` as a candidate without spoolMount writes
- migration dry-run planner blocks K2 hosts without material topology observations instead of assuming direct-only
- migration dry-run planner rejects `shadow` / `failed` / `sealed` as direct planner decisions
- migration dry-run planner blocks provisional device identity even with explicit single-spool settings
- migration dry-run planner blocks provisional/unknown observed source identity instead of promoting it to stable
- migration dry-run planner blocks single source observations with incomplete locator evidence
- migration dry-run planner blocks hosts with open Universal MaterialSource registry conflicts
- migration dry-run planner blocks hosts with open Universal SpoolMount repository conflicts
- migration dry-run planner treats future-dated observations beyond clock skew as not fresh
- migration dry-run planner excludes tombstoned/unobserved sources from migration cardinality
- migration dry-run planner changes source checksum when createdAt, policy, spool inventory, observation, accepted confirmation evidence, or repository evidence changes
- migration dry-run planner requires single-spool confirmations to bind to the migration subject and confirmation evidence checksum
- migration dry-run planner blocks duplicate strong devices and open device identity conflicts for a legacy host
- migration dry-run validator rejects unknown entry reason identifiers
- migration dry-run validator recomputes summary/status/write counts, rejects non-READY planned writes, and checks plan revision/source/migration ID binding
- migration dry-run validator rebuilds and validates the READY entry artifact graph as one unit / one source / zero mounts / one candidate
- migration dry-run validator requires READY mountCandidates to reference the entry spool and a planned MaterialSource

Gate 18.9B tests:

- valid dry-run plan is recorded without enabling authority writes
- duplicate `migrationId` + same checksum is idempotent and does not duplicate events
- malformed `migrationId` / revision / checksum binding is rejected before journal conflict handling
- invalid stored journal entries are retained as unsupported evidence
- stored entry checksum/status/planDigest mismatches are retained as unsupported evidence
- duplicate `migrationId` + same checksum but different planDigest is a journal conflict
- stored events are restored only when checksum, planDigest, recordedAt, and eventId match an accepted entry
- subject latest-revision index is rebuilt from valid entries during journal restore
- malformed stored entries do not throw during restore and are retained as unsupported evidence
- localStorage round-trip keeps the journal without projecting it to spool/mount observations
- IndexedDB durable save queues the journal as a shared dry-run evidence key
- import/export restores the journal through normalization and keeps `hostSpoolMap` untouched

Gate 18.9C tests:

- latest READY journal and current READY plan with the same entry mapping return a pure shadow plan
- mixed aggregate plan with a READY target entry stays preflight READY for that
  target entry
- stale reused current plan is blocked by `evaluatedAt` / `createdAt`
  freshness
- preflight returns `derivedFromPlanRevisionId` and `evaluatedPlanRevisionId` without requiring them to be equal
- preflight never mints `openedAt` or `mountOperationId`
- a requested migration that is no longer the latest subject revision is blocked
- a stale/current non-READY re-plan blocks journal READY from advancing
- a same host/spool subject with a changed Device identity is blocked
- existing open mount conflicts block before repository write
- existing registry locator conflicts block before repository write
- missing repository facades block because conflicts were not checked

Gate 18.9D-1 tests:

- READY preflight prepares staged MaterialSource and SpoolMount snapshots
- plain or cloned preflight result is rejected as untrusted
- `openedAt` and `mountOperationId` are minted at shadow transaction time
- prepared transaction status is not the same thing as `SHADOW` lifecycle
  status
- same `shadowOperationId` and same payload produce the same transaction and mount operation IDs
- blocked preflight never becomes a transaction
- staged MaterialSource registry conflict blocks without creating a transaction
- staged SpoolMount repository conflict blocks without returning a partial transaction
- missing repository snapshots are blocked instead of becoming empty staged repositories
- repository snapshots with existing conflicts are blocked before reconstruction
- invalid repository snapshot records are returned as blocked results rather than thrown exceptions
- `executedAt` before preflight `evaluatedAt` is blocked
- invalid `executedAt` or missing operation ID blocks before staging

Gate 18.9D-2 tests:

- durable write success commits MaterialSource/SpoolMount shadow snapshots and
  advances subject lifecycle to `shadow`
- store current durable snapshot change blocks before persist even if a caller
  supplies a matching stale current snapshot
- durable writer without atomic CAS evidence blocks after persist response
- durable write failure keeps the previous store and does not advance lifecycle
- same transaction retry is idempotent and does not duplicate events
- plain or cloned prepared transaction is rejected as untrusted
- same `shadowOperationId` with different payload is blocked
- saved shadow commit store restores after restart without legacy mount or
  ledger projection

Gate 18.9E planned tests:

- `1A=3210mm`, `1B=6543mm`, `1D=1234mm` attribute to separate
  source/mount/spool bindings
- `1C=0mm` is confirmed only with explicit source-specific 0mm usage
- caller-declared complete result set alone leaves unobserved sources as unknown
- incomplete result set leaves unobserved sources as unknown
- total-only multi-source usage becomes pending/unattributed
- source-specific plus larger total usage keeps the residual as
  pending/unattributed
- single-source total-only usage becomes a read-only source segment
- print-start snapshot keeps attribution stable after current mount changes
- completion-time PrintPlan assignment changes do not change saved print-start
  attribution
- conflicting tool/alias/source identifiers block attribution
- duplicate semantic completion is idempotent even with a different operation ID
- saved print binding store restores after restart without legacy usage or
  remaining projection

Gate 18.9F tests:

- N=1 keeps familiar K1 spool card behavior
- N>1 renders source-aware cards
- stale observation is last-known, not current
- device remaining and ledger remaining are visually distinct
- CFS source rows show the latest 3DPmon-managed spool and source-specific usage
- source rows keep device observation and 3DPmon accounting as separate read-only facts

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
