# Printer Core v3 Live Certification Runbook

Last updated: 2026-09-02

This runbook defines the operator-controlled steps for the remaining physical
evidence gates. It intentionally separates dry-run evidence, live command
submission, protocol observation, physical observation, restart recovery, and
release certification.

## Gate 20: Restart Recovery

Goal: prove that saved material settings survive restart, but production CFS
control stays fail-closed until the app re-probes the current printer and
re-observes material topology in the new runtime session.

Required sequence:

- Configure filament supply mode, CFS/CFS-C unit count, external spool setting,
  and optional provider endpoint.
- Save settings and quit the app.
- Start the built app again.
- Confirm the connection target restores the same material settings.
- Confirm old saved `/info` evidence is displayed only as saved evidence and
  does not enable CFS command control before re-probe.
- Confirm `/info` re-probe records a new current probe session ID for K2.
- Confirm K2 `boxsInfo` or CFS-C provider re-observes material topology.
- Confirm stale state is shown until material topology is actually observed.
- Confirm operation buttons remain disabled unless matching production
  certification, current model/firmware scope, active session, fresh topology,
  and send-time loaded source validation are all present.

## K2/CFS Print-Start Live Certification

Goal: prove that the K2/CFS `colorMatch` -> `multiColorPrint` transport can
start a CFS-backed print only when the selected material assignment is explicit
and physically valid.

Operator prerequisites:

- Build plate is clear.
- Target host is the K2 Pro Combo under test.
- G-code path is the exact printer-local path intended for the run.
- CFS slot, material type, and color have been observed immediately before
  dry-run review.

Dry-run first:

```powershell
node scripts/capture_k2_cfs_print_start.mjs `
  --host 192.168.54.21 `
  --file-path /mnt/UDISK/printer_data/gcodes/<file>.gcode `
  --assignment T1C,cfs:1:slot:2,PLA,<color> `
  --pretty
```

Review dry-run JSON before any live send:

- `plan.ok` is `true`.
- `plan.frames[0].params.colorMatch.path` matches the target G-code path.
- `plan.frames[0].params.colorMatch.list[]` matches the observed CFS source.
- `plan.frames[1].params.multiColorPrint.gcode` matches the same path.
- `plan.details.materialSupply` is `cfs`.
- `plan.details.assignmentEvidence[]` matches the observed slot, type, and color.
- No frame contains `opGcodeFile`.

Live send requires an explicit operator action:

```powershell
node scripts/capture_k2_cfs_print_start.mjs `
  --host 192.168.54.21 `
  --confirm-live `
  --confirm-host 192.168.54.21 `
  --file-path /mnt/UDISK/printer_data/gcodes/<file>.gcode `
  --assignment T1C,cfs:1:slot:2,PLA,<color> `
  --send `
  --pretty
```

Interpretation:

- `ok:true`, `sent:true`, `response.status:"submitted"` means the two frames
  were locally submitted to WebSocket without local transport error.
- It does not prove print start, printer acknowledgement, CFS feed, extrusion, or
  job completion.
- Physical success requires the observation checklist below.

Observation checklist:

- Existing protocol capture is running before live send.
- `colorMatch` is observed before `multiColorPrint` in the captured stream or
  command log.
- Post-start K2 print state changes away from idle.
- `boxsInfo` shows the intended CFS source selected.
- Filament physically feeds from the intended slot.
- Extrusion is visible at the toolhead/nozzle.
- Material remaining or usage evidence changes in the expected direction.
- Job completion is observed and captured.
- Fixture stores markers for operator action, observed printing, observed feed,
  observed extrusion, and completion.

Restart recovery can be code/tooling closed before this live run, but production
print-start authority remains blocked until this physical evidence is attached.

## Gate 18.9I: K2/CFS Shadow Accounting Certification

Goal: prove that a K2/CFS print can be linked to the 3DPmon-managed spool
mounted on each MaterialSource, without writing managed remaining, legacy
`usageHistory`, or ItemKeeper debit authority.

Read-only export analysis:

```powershell
node scripts/analyze_material_accounting_export.mjs `
  --export D:\Users\pcb\Downloads\3dpmon_export_YYYYMMDD-hhmmss.json `
  --certification D:\Users\pcb\Downloads\K2Pro-69E7-cfs-certification.json `
  --output tmp\material-accounting-export-report.json `
  --pretty
```

Use this before and after a live accounting run. The analyzer must remain
read-only: it reports observed MaterialSources, legacy `hostSpoolMap`
compatibility, Universal `SpoolMount` coverage, print-start snapshots, and
`JobMaterialSegment` counts, but it must not migrate mounts, debit spools, or
enable physical CFS commands.
For review, `sourceSpecificUsageCount` only proves that a segment references the
source. Gate evidence uses the stricter
`itemKeeperDigestConsistentUsageCount` / `itemKeeperDigestConsistentSegmentCount`
values. Those digest-consistent counts are scoped to the target multi-source
device and require a matching print-start snapshot, same `printJobId`, same
`deviceId`, a resolved `spoolId`, debit eligibility, finite non-negative usage,
and a digest-consistent projection receipt in the export. The read-only analyzer
cannot prove process-local runtime registry membership, so
`canProjectItemKeeperSourceUsage` remains false unless a later production issuer
exports runtime-certified evidence.
Gate 18.9J-2 adds the reviewed fixture registry scaffold, but its production
registry intentionally remains empty until a K2 live fixture is captured and
reviewed. Caller-supplied fixture receipts, reviewed commits, or capture hashes
must still report `reviewed-live-fixture-registry-entry-required` until that
module-owned immutable registry entry is added.
The analyzer also reports `gate18_9J2` readiness. This is stricter than the
Gate 18.9I evidence check: it requires a K2/CFS target, at least two loaded CFS
sources, source-aware managed mounts for every loaded source in the fixture,
trusted print-start snapshots, source-specific `JobMaterialSegment` records,
at least one observed-used segment, at least one explicit `confirmed-unused`
0mm segment, reviewable source-aware projection digest candidates, and a
matching CFS Debug / Certification panel export. Even when
`gate18_9J2.readyForFixtureReview` is true, it does not enable production
ItemKeeper projection or reviewed registry registration by itself.
Gate 18.9J-2 readiness is scoped to the certification target device when the
panel export contains a concrete device ID. Other monitored K2 printers in the
same all-data export must not make the target fixture fail. The candidate job
must also contain raw K2 `materialUsed` CSV either from the target machine
history or from the same job's `JobMaterialSegment.evidence.completionEvidence`
fallback when print history retention has already removed the machine history
row. The CSV source count must match both the print-start snapshot count and the
`JobMaterialSegment` count, and each parsed CSV value must equal the matching
segment's `usedLengthMm` in print-start binding order. If the certification
panel export carries a concrete session ID, that ID must match the candidate
print-start/session evidence before the job can be marked ready for fixture
review.

Required sequence:

- Mount 3DPmon-managed spools to every CFS source that may be used by the test
  print. The external spool source and every CFS slot remain separate sources.
- Start a K2/CFS print through the guarded print-start flow so the app creates a
  MaterialBindingPlan before transport send and moves it to submitted only after
  local transport success.
- Confirm the app observes a new machine print start after submission. A
  baseline job already present before send must not bind to the pending plan.
- Keep K2 material topology fresh through the print interval. Provider
  disconnect/reconnect, source disappearance, alias conflict, or event-log
  coverage gap must keep the segment out of managed debit eligibility.
- Confirm completed history appears with source-specific `materialUsed`
  evidence. If print history retention removes the row before fixture build,
  confirm the same raw CSV is preserved in
  `JobMaterialSegment.evidence.completionEvidence`; otherwise confirm the result
  is left pending/unattributed when only total usage or incomplete source counts
  are available.
- Confirm the filament manager shows each source segment as read-only usage
  evidence beside the mounted 3DPmon spool. It may show estimated remaining, but
  must not write managed remaining or legacy K1-style usage records yet.
- Confirm ItemKeeper export/projection includes only read-only source-specific
  evidence that has a trusted print-start snapshot and matching completion
  usage. Unused sources require explicit result-set completeness evidence before
  they can be marked confirmed-unused.
- Confirm `gate18_9I.status:"evidence-present"` is based on the target
  multi-source device's own print-start snapshot plus eligible source-specific
  segment evidence. A segment from another device, or a source-specific segment
  without ItemKeeper eligibility, is not enough.

Pass criteria:

- The saved print-start snapshot contains device, session, generation, print
  job, source, spool, and local receipt evidence.
- Source-specific usage such as `T1A -> CFS 1A = 3210mm` and
  `T1B -> CFS 1B = 6543mm` is preserved as separate JobMaterialSegment records,
  and the raw `materialUsed` CSV parses to the same values in the same
  print-start binding order.
- A source that was mounted but not reported as used remains pending or
  unconfirmed unless result-set completeness evidence explicitly proves zero
  usage.
- No managed spool remaining debit occurs during this certification gate.
- `scripts/analyze_material_accounting_export.mjs` reports
  `gate18_9I.status:"evidence-present"` only after source-specific segment
  evidence exists. A K2/CFS export that still has only legacy `hostSpoolMap`
  receives `legacy-single-spool-map-present-for-multi-source-device` and
  `loaded-source-managed-mount-missing` warnings instead of being silently
  treated as source-aware.
- `scripts/analyze_material_accounting_export.mjs` reports
  `gate18_9J2.status:"candidate-ready-for-fixture-review"` only when the same
  export also contains the stricter fixture-review inputs described above.
  `gate18_9J2.canRegisterReviewedFixtureEntry` and
  `gate18_9J2.canProjectItemKeeperSourceUsage` remain false until a later
  module-owned reviewed registry entry and issuer activation are implemented.

Fixture artifact build:

```powershell
node scripts/build_itemkeeper_source_usage_fixture.mjs `
  --export D:\Users\pcb\Downloads\3dpmon_export_POST.json `
  --certification D:\Users\pcb\Downloads\K2Pro-69E7-cfs-certification_POST.json `
  --device-id serial:<k2-device-id> `
  --print-job-id <target-print-job-id> `
  --reviewed-commit <full-git-sha-used-for-capture> `
  --operator-action-id operator:k2-j2-capture-001 `
  --firmware-version <observed-firmware-version> `
  --output-dir tmp\gate18-9j2-capture-001 `
  --pretty
```

This builder is read-only. It creates `fixture-evidence.json`,
`fixture-receipt.json`, `projection-digests.json`, and
`capture-manifest.json` from the exported stores. A rejected receipt is still a
useful artifact because it records the missing snapshot, segment, raw CSV,
order, parity, or usage-state evidence without mutating 3DPmon storage,
ItemKeeper, or the reviewed production registry. The builder resolves raw
history from the target machine only, using the requested `deviceId` and
`printJobId` plus `printPlanId` when available. If that row is absent because of
print history retention, the builder may use the same job's
`JobMaterialSegment.evidence.completionEvidence.rawMaterialUsed` fallback, but
conflicting fallback values or CSV/segment usage mismatches keep the fixture
rejected. Device metadata is anchored to the 3DPmon export target/machine;
certification JSON and CLI metadata may fill missing fields, but conflicts are
reported as `fixture-review-not-ready` review blockers.

## Gate 10: K2 CFS Topology Certification

Goal: bind CFS topology fields to physical attach, detach, stale, reconnect, slot
change, material change, external spool, and assignment behavior.

Required evidence:

- Fresh CFS 1-unit baseline with external spool setting documented.
- CFS disconnect or equivalent offline condition produces stale UI and does not
  refresh last-known slot values as current values.
- Reconnect produces fresh topology and updated `boxsInfo`.
- Slot insert/remove changes loaded/empty/unobserved state as physically seen.
- Material type/color changes are reflected in protocol evidence.
- External source remains separate from CFS slots.

## Gate 12: K1C/CFS-C Provider Certification

Goal: verify that K1C plus CFS-C read-only material provider works without
changing printer identity or Moonraker/IR3 normal monitoring authority.

Required evidence:

- Provider endpoint is persisted in connection settings.
- Restart opens material-only secondary session when configured.
- Provider object discovery subscribes only to existing material objects.
- Attach/detach and stale/reconnect are visible as material topology changes.
- K1 printer identity remains stable when CFS-C provider attaches or detaches.

## Gate 21: Release Certification

Goal: produce release evidence for a build candidate.

Minimum local checks:

- `npx vitest run`
- `npm run test:e2e`
- `npm run build`
- Installer and portable artifacts exist under `dist/`.

Minimum live checks:

- K2 Pro Combo monitored through idle, print-start, printing, completed, and
  returned idle.
- K2/CFS topology observed fresh, stale, and fresh again.
- K1 Max monitoring still works in parallel.
- IR3 V2 / Moonraker path remains outside Printer Core v3 K1/K2 identity/shadow.
- App restart recovers configured material display settings.
- Communication loss and reconnect do not enable unsafe CFS operations.

Release decision:

- If live command authority is not enabled, release can be labeled as read-only
  K2/CFS monitoring plus certification tooling.
- If live K2/CFS print-start authority is enabled later, release notes must state
  the certified printer family, firmware evidence, supported source types, and
  unsupported standalone CFS slot operations.
