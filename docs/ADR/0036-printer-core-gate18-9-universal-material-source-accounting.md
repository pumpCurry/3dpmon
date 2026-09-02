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

Source continuity for provisional sources is an interval fact, not just a final
freshness fact. The observation used for debit eligibility must be tied to the
same print interval: it must be observed no earlier than the trusted
print-start snapshot and no later than the trusted completion observation. A
MaterialSource observation received after completion must not be retroactively
used to prove that the source was fresh at completion time.

MaterialSource continuity uses the 3dpmon receipt-time domain, not printer clock
timestamps. `capturedAt` and `completedAt` remain device evidence for the print
job timeline, while `printStartObservedReceivedAt`, `completionObservedReceivedAt`,
and MaterialSource `lastObservedAt` form the causal observation interval used
for provisional debit eligibility. Source freshness must be calculated from the
source-specific observation timestamp, never from a fresher device-level
observation belonging to another source. The MaterialSource event log is
bounded, so absence of a source change event is trusted only when the retained
event coverage starts at or before the operator-confirmed mount open time.
Operator reconfirmation is not trusted until a typed durable reconfirm event is
introduced; imported/restored timestamp fields cannot move the continuity start
forward. If
device-level coverage is missing, source-specific coverage is missing, or
either coverage starts after that continuity start, the usage evidence remains
shadow evidence and does not become a managed remaining debit candidate. A
source first observed after the mount-open continuity start
cannot borrow an older device-level coverage start.
Device-level provider gaps also break provisional continuity:
`provider-disconnected`, `provider-reconnected`, and provider generation changes
observed during the print interval apply to every provisional source on that
device even when the same slot/material state is later observed again.

K2/CFS print-start binding must distinguish printer-reported job start time
from 3dpmon receipt time. `devicePrintStartTime` may be used as the immutable
print-start snapshot time, but causality against a just-submitted transport
command is decided by local `observedReceivedAt`. A device clock or firmware
start timestamp that predates the local submit instant must not by itself reject
a newly received job observation. Conversely, an observation received before the
command was submitted is treated as stale or pre-command evidence even if its
device timestamp looks newer.

K2/CFS print-completion binding also uses 3dpmon receipt time as interval
evidence. The first local receipt time for a completion observation is fixed on
the pending bridge record and reused for runtime/CAS retries. A later retry must
not move `completionObservedReceivedAt` forward, because MaterialSource
observations received after the first completion notification are not evidence
that the same source was continuous during the print interval.

MaterialBindingPlan is not sufficient unless it is digest-bound to the actual
transport command request. The command binding includes command ID, device ID,
session ID, connection generation, remote path, file hash, and the material
assignment digest. The live bridge recomputes that binding from the request at
pending registration time; mismatch blocks the binding before any runtime
snapshot is recorded.

MaterialSource aliases are convenience identifiers only. If a single alias maps
to multiple canonical MaterialSource IDs, print-start binding for that alias
must fail closed as `ambiguous-material-source-alias` instead of choosing the
first record in array order.

Manual SpoolMount assignment requires a confirmed 3dpmon managed spool. An
`inferred:true` spool or an `isPending:true` spool is not assignable to a
MaterialSource until the operator confirms it as a real managed spool. This
prevents provisional legacy lifecycle flows from deleting or rewriting a spool
that Universal SpoolMount already references.

Multi-source jobs with total-only usage are never split by color, material,
source count, elapsed time, or display order. They are recorded as pending or
unattributed usage until source-specific evidence exists.

`0mm` and `unknown` are different. In the current read-only repository, a source
may be stored as confirmed unused only when explicit source-specific 0mm usage
is observed. A caller-declared complete result set, or a forged trusted-complete
boolean flag, is not sufficient. Otherwise its usage remains unknown until a
later module-owned trusted result-set registry is added.

Gate 18.9G keeps the result-set completeness trust boundary fail-closed for
shadow attribution. The public registry can validate module-owned evidence, but
it does not mint trusted completeness evidence from caller-supplied source
coverage. A later issuer must bind provider/session/generation, result-set
revision, expected source/tool digest, observed result digest, and observation
time before absent sources can be classified as trusted `confirmed-unused`.
This still does not debit managed spool remaining or write legacy
`usageHistory`.

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

Completion attribution is scoped to the device captured by the print-start
snapshot. A later completion payload with the same `printPlanId` but a different
`deviceId` cannot re-home usage to another printer.

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
  trusted debit-capable usage evidence or trusted print-start snapshots
- pending/unattributed usage isolation for total-only and residual multi-source
  observations
- stable semantic idempotency independent from caller operation IDs
- restart recovery for shadow print binding records without legacy debit, with
  cross-record validation before restored snapshot/evidence/segment/ledger
  records return to authority arrays
- persisted operation caches are not restored; operation idempotency after
  restart is recovered from deterministic semantic record IDs, not saved result
  payloads
- duplicate semantic IDs with conflicting payloads quarantine the full conflict
  set instead of preserving whichever record appeared first

Gate 18.9F:

- MaterialSourceAccountingView read model
- legacy compatibility projection
- N=1 familiar card and N>1 source card UI cutover
- read-only projection of saved print binding store into CFS/external source rows
- separate display for device-reported remaining, 3dpmon-managed remaining, and source-specific recent usage
- source-aware accounting joins by canonical MaterialSource ID, aliases, and
  physical/protocol locator, not by raw observed `sourceId` equality alone

Gate 18.9G:

- public result-set completeness registry kept fail-closed for trusted issuance
- source-set scope validation preserved for future module-owned complete result evidence
- shadow attribution may mark absent sources as `confirmed-unused` only after a
  future provider/session-bound trusted issuer covers the same
  device/job/plan/source set
- no production spool debit, legacy usage write, or remaining mutation

Gate 18.9H:

- production Operator SpoolMount authority split into H-1a pure store/service
  contract and H-1b durable persistence
- dedicated `materialAccountingSpoolMountStore`, separate from migration shadow
  and print-binding shadow stores
- durable operation indexes are rebuilt from mount records and events after
  restart; generic `operationsById` is not stored as authority
- production writes require durable CAS evidence with `casApplied:true`
- legacy `hostSpoolMap` is read-only compatibility evidence and same-spool
  cross-backend occupancy blocks Universal mount until explicit migration
- transport-local source IDs remain aliases; durable MaterialSource IDs are
  device-scoped, and storage CAS preconditions re-resolve current observations
  by canonical ID, alias, or source binding digest
- import only treats current committed Universal `OPEN` mounts or in-flight
  reservations as reasons to skip legacy `hostSpoolMap`; incoming Universal
  conflicts are quarantined by the SpoolMount store reconciliation path
- operator mount / replace require fresh current MaterialSource observation at
  send time, while unmount can remove an existing 3DPmon-managed mount without
  requiring fresh provider data
- legacy spool deletion and other destructive lifecycle mutations, including
  `revertInferredSpool()` and `updateSpool()` patches that set deleted flags or
  change spool identity, are blocked while a Universal `OPEN` mount or in-flight
  reservation still references the managed spool
- inferred or pending managed spools are excluded from H-2 mount candidates and
  rejected by the SpoolMount service as `managed-spool-not-confirmed`
- device observations, RFID, selected state, empty/unloaded state, stale
  providers, and physical CFS commands do not close or rewrite SpoolMounts
- no production spool debit, legacy usage write, physical command enable, or
  ItemKeeper projection

Detailed H-1 implementation boundaries are defined in
`docs/develop/printer-core-v3-gate18-9h-spool-mount-authority.md`.

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
- print-start binding accepting a job ID only after it matches the current
  machine-observed job ID and the current Printer Core v3 device/session
  observation, requiring matching connection generation when the caller binds
  one, resolving print-start time from machine observation or an
  existing snapshot rather than caller authority, issuing runtime snapshots
  through the trusted print-start issuer, keeping duplicate print-start
  observations idempotent, then committing the snapshot through a durable CAS
  boundary before advancing runtime state. PrintBinding store import uses the
  same CAS boundary, normal shared flush cannot write this key, and restore
  quarantines same-ID payload conflicts instead of picking a silent winner.
- completion binding accepting source-specific usage only after the completed
  job is observed in machine history with matching Printer Core v3
  device/session evidence and any caller-bound connection generation. Caller
  supplied completion time, usage payload, total usage, or source continuity
  object alone is insufficient.
- K2/Creality `materialUsed` CSV is parsed in saved print-start snapshot order,
  not completion-time caller PrintPlan assignment order. CSV cardinality must
  match the saved source snapshot set; extra or missing values are blocked
  instead of being silently dropped.
- Runtime source continuity is resolved from module-owned MaterialSource
  observations and the official freshness TTL before debit-candidate
  evaluation. TTL-expired, provider-disconnected, or restored-last-known
  observations may still produce source-specific JobMaterialSegment / shadow
  ledger evidence, but they do not become managed remaining debit candidates.
  Freshness is evaluated with the source-specific observation timestamp. A fresh
  device-level topology observation for another source cannot refresh a stale
  provisional source. Runtime interval checks use 3dpmon receipt times
  (`printStartObservedReceivedAt`, `completionObservedReceivedAt`, and
  MaterialSource `lastObservedAt`) instead of mixing printer clock `capturedAt`
  / `completedAt` with local observation clocks. A fresh completion-time
  topology observation is not enough by itself: if the
  MaterialSource change log records `source-changed`, `source-disappeared`,
  `source-merge-conflict`, a device-level provider disconnect/reconnect, or a
  provider generation change after the operator-confirmed mount open and before
  completion, the runtime marks the segment as a
  physical discontinuity and keeps
  `sourceContinuity:false`. The same check also requires retained event
  coverage from at least the operator-confirmed mount open time at both the
  device-event-log level and the individual MaterialSource snapshot level.
  Plain `reconfirmedAt` / `operatorReconfirmedAt` fields are not authority; a
  future reconfirm flow must add typed durable operator evidence before it can
  reset this interval. Old restored records, sources first observed after the
  continuity start, or records whose event log has already trimmed past that
  point fail closed.
  Gate 18.9I-2 does not mutate managed spool remaining or legacy
  `usageHistory`.
- ItemKeeper payload generation may read same-device `observed-used` /
  `confirmed-unused` JobMaterialSegment records as a projection source when
  `job.filamentInfo[]` is absent only when the segment is debit eligible and
  the source-specific projection is live certified through the module-owned
  ItemKeeper projection registry and `usedLengthMm` is an explicit non-negative
  number. Plain imported/restored `itemKeeperProjection.status:"certified"`
  fields are not sufficient; the projection evidence must carry the registry
  authority and a digest that still matches the current segment. The current
  release intentionally has no production issuer for this registry, so public
  helper calls cannot enable source-aware ItemKeeper projection. This projection
  sends per-spool `filaments[]` evidence without mutating 3dpmon inventory
  state.
- K2/CFS UI print-start sends create a module-attested MaterialBindingPlan
  separate from the transport command request, register it as prepared pending
  state immediately before transport dispatch, mark it submitted only after
  transport send success, drop that pending record on dispatch failure, and
  only connect it to print binding runtime after a new machine-observed
  `printStartTime` / PrintJob ID and completed history are observed. The
  MaterialBindingPlan attests tool/source/asset/session/generation binding;
  `spoolId` is optional at this boundary so an unmounted 3dpmon spool does not
  block physical K2/CFS print transport. The accounting runtime must still find
  an active `OPEN` SpoolMount at print-start time before saving a managed spool
  snapshot. Transport-local source IDs are aliases; repositories re-resolve
  canonical MaterialSource IDs and aliases, then persist canonical
  `materialSourceId` in snapshots. The
  observed start must not match the pre-submit baseline job, must be observed at
  or after `submittedAt`, and must match the same session and connection
  generation. Completion success removes the pending record so the material
  binding cannot be re-bound to later manual jobs. Trusted print-start
  snapshots include durable issuance evidence for device ID, session ID,
  connection generation, PrintJob ID, and first observed time. The SpoolMount
  open time used as the source-continuity lower bound is saved as signed
  top-level `mountOpenedAt`; embedded `spoolMount.openedAt` remains diagnostic
  evidence and cannot move the debit continuity window after the snapshot is
  issued. Trusted snapshots also carry a signed canonical `bindingAuthority`
  containing tool ID, protocol tool alias, order, canonical MaterialSource
  semantics, and SpoolMount debit semantics. K2 `materialUsed` CSV values are
  mapped by this authority order, not by mutable diagnostic payload. Debit
  eligibility reconstructs its mount/source input from `bindingAuthority`;
  nested `spoolMount` and `materialSource` are diagnostic-only. Tampering with
  `bindingAuthority` invalidates the trusted snapshot, while changing
  diagnostic fields such as `spoolMount.verification` or
  `materialSource.displayLabel` does not change debit authority.
- Source-continuity lookup IDs are derived from `bindingAuthority.source` and
  the current completion-time MaterialSource observation only. Diagnostic
  `snapshot.materialSource` IDs and aliases are intentionally excluded so that
  imported/restored diagnostic payload edits cannot change continuity results.
  The mount source identity digest is copied from the canonical SpoolMount
  `sourceBindingAtOpen.sourceIdentityDigest` field into `bindingAuthority`.
- The trusted print binding repository factory is not re-exported from the
  public print binding barrel. Production print binding runtime does not accept
  caller-supplied `data` or `persist` dependency injection. Tests must use the
  dedicated `createMaterialAccountingPrintBindingRuntimeForTest()` helper,
  which is unavailable outside the test environment.
  ESLint enforces the trusted factory, issuer-injected repository, and test-only
  runtime helper import allowlist across all `3dp_lib/**/*.js` production
  modules, not only inside `printer_core`. The same production lint boundary
  also rejects dynamic imports of these restricted authority modules, so callers
  cannot bypass the static import allowlist by loading the whole module.
  Production dynamic imports must use string literals, preventing variable,
  concatenated, or template-computed specifiers from hiding restricted authority
  module paths from lint.
- trusted print-start snapshots restored from same-process CAS store may regain
  debit eligibility only through module-owned attestation validation. Restart
  or import loses that process-local trust and must revalidate before debit.
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
