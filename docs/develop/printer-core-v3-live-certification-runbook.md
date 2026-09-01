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
  evidence, or confirm the result is left pending/unattributed when only total
  usage or incomplete source counts are available.
- Confirm the filament manager shows each source segment as read-only usage
  evidence beside the mounted 3DPmon spool. It may show estimated remaining, but
  must not write managed remaining or legacy K1-style usage records yet.
- Confirm ItemKeeper export/projection includes only read-only source-specific
  evidence that has a trusted print-start snapshot and matching completion
  usage. Unused sources require explicit result-set completeness evidence before
  they can be marked confirmed-unused.

Pass criteria:

- The saved print-start snapshot contains device, session, generation, print
  job, source, spool, and local receipt evidence.
- Source-specific usage such as `T1A -> CFS 1A = 3210mm` and
  `T1B -> CFS 1B = 6543mm` is preserved as separate JobMaterialSegment records.
- A source that was mounted but not reported as used remains pending or
  unconfirmed unless result-set completeness evidence explicitly proves zero
  usage.
- No managed spool remaining debit occurs during this certification gate.

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
