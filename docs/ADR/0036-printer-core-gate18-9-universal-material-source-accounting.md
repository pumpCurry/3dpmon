# ADR-0036: Printer Core Gate 18.9 Universal Material Source Accounting

## Status

Accepted for Gate 18.9 design and staged implementation.

## Context

3dpmon historically managed filament inventory for K1-class printers because
the printer did not provide complete, durable spool inventory state. The legacy
model effectively mapped one printer host to one managed spool through
`hostSpoolMap`, `mountHistory`, and print history usage.

K2/CFS, K1C/CFS-C, and future FDM devices break the assumption that one device
has exactly one material source. A single device may expose one direct/external
source, one or more CFS units, CFS-C sources, or no CFS unit at all. RFID
materials may report remaining evidence, while generic materials often only
report metadata and actual usage. Therefore device observations, physical CFS
commands, 3dpmon spool mounting, and ledger debit must remain separate.

ADR-0007 already defines the planned Data Schema v3 stores for
`filamentUnits`, `materialSources`, `spoolMounts`, `jobMaterialSegments`, and
`filamentLedger`. ADR-0035 adds read-only material source observations and
explicitly prevents observation evidence from writing ledger or mount
authority. Gate 18.9 turns that planned accounting model into the next
production boundary.

## Decision

Gate 18.9 adopts a universal material source model for all FDM printers:

```text
Device
  -> FilamentUnit
       -> MaterialSource
            -> SpoolMount
```

K1, K1 Max, and IR3 V2 direct-spool operation are not a separate accounting
domain. They are the `N=1` case:

```text
Device
  -> FilamentUnit(kind=printer-direct)
       -> MaterialSource(kind=direct-feed, index=0)
            -> SpoolMount
```

K2 with CFS is the `N>1` case:

```text
Device
  -> FilamentUnit(kind=printer-direct)
       -> MaterialSource(kind=external-spool)
  -> FilamentUnit(kind=cfs)
       -> MaterialSource(kind=cfs-slot, slot=A)
       -> MaterialSource(kind=cfs-slot, slot=B)
       -> MaterialSource(kind=cfs-slot, slot=C)
       -> MaterialSource(kind=cfs-slot, slot=D)
```

The accounting model separates three axes:

- Printer/protocol family: K1, K2, Moonraker, IR3 V2, and future protocols.
- Material topology: direct, external, CFS, CFS-C, and arbitrary source counts.
- Accounting backend: `legacy-single-source`, `universal-shadow`,
  `universal-authoritative`, or `blocked-source-attribution`.

Printer type selects connection and protocol adapters. Material topology
selects source layout. Accounting backend selects which ledger authority may
write. These axes must not be collapsed into each other.

## Domain Terms

- `FilamentUnit` is any unit that provides one or more material sources. It is
  not limited to CFS hardware. A direct printer feed is also a filament unit.
- `MaterialSource` is a stable or provisional accounting source inside a
  filament unit.
- `MaterialSourceObservation` is read-only device evidence. It may be fresh,
  stale, partial, or restored-last-known, but it is not mount or ledger
  authority.
- `SpoolMount` is a 3dpmon-managed interval saying that one managed spool is
  mounted to one material source.
- `ToolAssignment` maps a slicer/tool alias such as `T1A` to a material source
  for a print plan or observed protocol frame.
- `JobMaterialSegment` is an immutable print-start attribution snapshot plus
  usage result for one source/spool segment.
- `FilamentLedgerEvent` is append-only consumption, correction, reservation, or
  migration accounting evidence.

`SpoolMount` and `ToolAssignment` are intentionally different. Selecting a CFS
slot or observing `T1A` does not change which managed spool is mounted.

## Identity

Material source identity has two parts:

- `materialSourceId`: the accounting key used by 3dpmon.
- `locator`: the current physical/protocol location such as CFS unit index,
  box ID, slot index, or direct feed index.

Physical values such as `boxId=1` and `slotId=0` are locators. They are not
automatically stable identities. Each source records an `identityStrength`:

- `stable`: source identity is backed by durable device and unit evidence.
- `provisional`: source identity is based on current endpoint, unit locator, or
  observed topology and must be revalidated before debit.
- `unknown`: source identity cannot safely be used for mount or debit.

Display labels such as `1A`, `1B`, and `2D` are UI labels only. They must not be
used as durable database IDs.

## SpoolMount Continuity

SpoolMount continuity and debit eligibility are separate.

`SpoolMount` is operator-managed accounting state. It remains open unless
3dpmon records an accounting operation that closes it, or migration explicitly
seals a legacy interval. Device observation alone does not close or rewrite a
mount.

The following events do not automatically close a SpoolMount:

- app restart
- WebSocket, HTTP, or Moonraker disconnect
- provider stale
- temporary CFS/CFS-C detach
- selected source change
- tool assignment change
- RFID missing or unreadable
- remaining value missing
- source temporarily unobserved
- CFS load/unload/select/feed/retract command result
- explicit device observation that a source is empty or unloaded

Some events block future automatic debit until revalidated. A mount may remain
open while debit eligibility becomes pending.

`SpoolMount` status `BLOCKED` is reserved for repository-owned accounting
quarantine, such as detected corruption or an operator-forced hold on a mount
record. It must not be used as a synonym for provider stale, RFID unavailable,
unknown remaining, or a normal unloaded observation; those conditions affect
debit eligibility without rewriting mount continuity.

Hard blockers for automatic debit include:

- no fresh topology at print start for a provisional source
- source cannot be uniquely resolved
- identity conflict
- stable RFID mismatch
- CFS unit appears to be a different stable physical unit
- complete topology proves the source disappeared
- explicit empty/unloaded physical discontinuity after the mount was opened
- source-specific attribution is unavailable for a multi-source job

Time alone is not a reason to close a SpoolMount. A stale mount can remain open
for any duration, but a new job cannot automatically debit it until print-start
continuity is revalidated.

## Debit Eligibility

A job may debit a managed spool only when all of the following are true:

- a valid print job exists
- actual usage evidence exists
- usage evidence has a stable idempotency key
- the usage is attributed to exactly one material source, or a trusted
  repository-owned result set is complete enough to mark a source as confirmed
  unused
- print-start captured an immutable mount snapshot
- the usage evidence and print-start snapshot were issued by a trusted
  provider/repository boundary
- the snapshot references an open verified SpoolMount
- the source is not in a hard-blocked identity or discontinuity state
- the same job has not already been debited by legacy or universal accounting

For provisional CFS/CFS-C sources, manual SpoolMount assignment is allowed. Auto
debit is allowed only after print-start revalidation proves source continuity
and a trusted issuer has created source-specific usage and print-start binding
evidence. Restart or reconnect does not close the mount, but fresh source
observation is required before a new automatic debit.

Multi-source jobs with total-only usage are never split by color, material,
source count, elapsed time, or display order. They are recorded as pending or
unattributed usage until source-specific evidence exists.

`0mm` and `unknown` are different. In the current read-only repository, a source
may be stored as confirmed unused only when explicit source-specific 0mm usage
is observed. A caller-declared complete result set is not sufficient. Otherwise
its usage remains unknown until a later trusted result-set registry is added.

## Remaining Provenance

Device-reported remaining, 3dpmon ledger remaining, projected remaining, and
actual usage evidence are separate provenance streams.

Device-reported remaining is used for display, diagnostics, discrepancy
detection, and operator correction candidates. It must not directly overwrite
3dpmon managed spool remaining or append ledger corrections.

3dpmon ledger remaining is derived from anchors, mount snapshots, confirmed
ledger consumption, and explicit correction events.

Projected remaining is informational. It is not irreversible ledger authority.

If the operator chooses to accept a device-reported remaining value as a
correction, a separate ledger correction event must record that provenance and
confirmation. Gate 18.9 does not implicitly perform that correction.

## Legacy Compatibility And Cutover

`hostSpoolMap` remains a compatibility projection during migration. It is not
universal accounting authority.

For `N=1` devices, compatibility functions such as `getCurrentSpool(host)` may
continue to present the familiar single spool UX while the underlying universal
model contains one source.

For `N>1` devices, legacy host-based debit is forbidden. A multi-source device
must not fall back to `getCurrentSpool(host)` to choose a debit target.

Gate 18.9A includes legacy accounting cutover safety. When a device moves to
universal accounting, its legacy mount interval must be sealed at the last
legacy-completed print ID before cutover. Future jobs must not be included in
that legacy interval.

Starting `universal-shadow` observation is not an accounting authority cutover.
It must not seal the legacy interval. A sealed cutover is valid only when the
target backend is `universal-authoritative`.

Cutover records must explicitly state both `fromBackend` and `toBackend`. A
sealed cutover is valid only for
`legacy-single-source -> universal-authoritative`; all other sealed transitions
are invalid.

The cutover record carries:

- `deviceId`
- `cutoverAt`
- `cutoverPrintId`
- `fromBackend`
- `toBackend`
- `migrationStatus`
- `reason`

This prevents legacy derivation from later collecting universal jobs and
double-debiting or misattributing them.

Usage idempotency identifies the physical/job/source usage event, not the
reported quantity or observation time. Replaying the same completion with a
different `usedLengthMm` or `observedAt` must not append a second debit or
overwrite the existing event; it must become conflict or correction evidence.

## Migration Rules

Legacy data is evidence, not source identity.

Automatic migration is allowed only when:

- topology certainty is known
- exactly one material source exists
- a valid legacy `hostSpoolMap` spool exists
- no conflicting source-aware open mount exists
- the legacy interval can be sealed without including future universal jobs

K2/CFS or K1C/CFS-C targets with existing `hostSpoolMap` entries are migration
candidates, not automatic migrations. The UI must explain that the previous
single-spool record cannot identify which CFS/external source held the spool.
The operator must choose a source before source-aware accounting can become
authoritative.

Unknown topology is not equivalent to direct-only topology.

## Command Boundary

CFS physical commands and 3dpmon accounting commands are separate systems.

The following physical outcomes do not update SpoolMount:

- `load`
- `unload`
- `select`
- `feed`
- `retract`
- material provider reconnect
- command expected-state success

SpoolMount changes only through 3dpmon accounting operations such as assigning a
managed spool to a material source, closing that assignment, migration, or
operator-confirmed correction.

## P0/P1 Invariants

P0 incidents that Gate 18.9 must prevent:

- `hostSpoolMap` and `SpoolMount` both write accounting authority for one job.
- An `N>1` device debits through legacy `getCurrentSpool(host)`.
- Legacy ledger and universal ledger both debit the same job.
- A current mount change rewrites historical job attribution.
- Physical unload, detach, or stale observation automatically closes a mount.

P1 incidents that Gate 18.9 must prevent:

- A provisional source is rebound to a different physical unit and keeps debit
  eligibility.
- A K2/CFS legacy `hostSpoolMap` entry is blindly migrated to an observed slot.
- Multi-source total-only usage is guessed into per-source usage.
- Unknown usage is saved as `0mm`.
- Provisional sources auto-debit after restart without fresh source
  revalidation.

## Gate Breakdown

Gate 18.9A:

- Universal MaterialSource topology contracts
- SpoolMount authority contracts
- legacy accounting cutover safety
- no production storage, UI, or debit behavior change in the first contract
  commits

Gate 18.9B:

- dry-run migration planner
- evidence-only migration journal
- entry-level migration subject/revision binding
- plan digest and latest valid revision index
- no production storage, UI, or debit behavior change

Gate 18.9C:

- pure shadow preflight evaluator
- latest journal revision lookup by entry subject
- execution-time current plan revalidation
- latest subject status is compared to the requested entry status, not the plan
  aggregate status
- `evaluatedAt` is required and must be close to the current plan `createdAt`
- Device/source/spool/mount-intent continuity check
- read-only MaterialSource/SpoolMount repository conflict check is mandatory
- no production storage, UI, execution-field minting, or debit behavior change

Gate 18.9D-1:

- staged shadow transaction preparation
- trusted in-process preflight result attestation
- execution-time `openedAt` and `mountOperationId` minting
- prepared transaction status is separate from proposed `SHADOW` migration
  status
- explicit MaterialSource/SpoolMount repository snapshots are required
- repository snapshots with existing conflict evidence are blocked before staging
- `executedAt` must be at or after the preflight `evaluatedAt`
- staged MaterialSource/SpoolMount repository validation
- no partial transaction result on staged conflict
- no production storage or ledger debit behavior change

Gate 18.9D-2:

- persistent shadow commit store
- trusted in-process prepared transaction attestation
- base MaterialSource/SpoolMount snapshot digests embedded in the prepared
  transaction
- CAS compares those embedded base digests with the current shadow commit store
  snapshots, not caller supplied current snapshots
- durable write callback boundary requires `casApplied:true`; failed durable
  write or missing atomic CAS evidence returns the previous store
- restart/recovery from durable shadow commit records
- `SHADOW` lifecycle transition only after durable commit success
- same `shadowOperationId` and same transaction payload is idempotent
- same `shadowOperationId` with different transaction payload is blocked
- no ledger debit behavior change

Gate 18.9E:

- source-aware print-start binding snapshots with tool/source assignment
  metadata
- source-specific JobMaterialSegment shadow records
- append-only shadow FilamentLedger event candidates
- read-only usage evidence; the public print binding repository does not mint
  trusted debit-capable usage evidence
- pending/unattributed usage isolation for total-only and residual multi-source
  observations
- stable semantic idempotency independent from caller operation IDs
- restart recovery for shadow print binding records without legacy debit

Gate 18.9F:

- MaterialSourceAccountingView read model
- legacy compatibility projection
- N=1 familiar card and N>1 source card UI cutover
- read-only projection of saved print binding store into CFS/external source rows
- separate display for device-reported remaining, 3dpmon-managed remaining, and source-specific recent usage

Gate 20 extension:

- restart recovery
- unfinished attribution recovery
- provisional mount revalidation

## Test Requirements

Gate 18.9 must cover:

- K1 direct source as `N=1`
- K2 external-only as `N=1`
- K2 external plus CFS as `N=5`
- four CFS units plus external source as `N=17`
- stable and provisional source identity
- duplicate source IDs rejected
- one open mount per source
- one open mount per spool
- restart/stale/reconnect preserving mount state
- explicit empty/unloaded blocking debit but not closing mount
- RFID null preserving continuity
- RFID mismatch blocking debit
- source-specific usage debiting the correct mounts
- multi-source total-only usage becoming pending/unattributed
- confirmed unused sources remaining distinct from unknown sources
- print-start snapshot preserving historical attribution even if current mount
  changes later
- legacy cutover sealing future jobs out of legacy intervals

## Consequences

This decision preserves the K1-era operator-managed inventory model while
making it source-aware. It allows K2/CFS and K1C/CFS-C to manage multiple
mounted 3dpmon spools without treating device observations or physical CFS
commands as accounting authority.

The first implementation commits should be reviewable without production
behavior changes: document the ADR/spec, add pure contracts, and add pure tests.
Physical IndexedDB upgrades, migration activation, ledger debit, and UI cutover
come in later commits after the contract is reviewed.
