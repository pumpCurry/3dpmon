# ADR-0035: Printer Core v3 Gate 18.7 Material Source Observations

Gate 18.7 adds a persistent read-only observation store for K2/CFS and
K1C/CFS-C material sources. This closes the operational gap where the UI could
show CFS slots at runtime, but the app could not retain the last observed
external spool/CFS slot state across restart without mixing it into the
3DPmon-managed spool ledger.

## Decision

- Add `monitorData.materialSourceObservations`.
- Store records by device ID, with `identityStrength` set to `stable` only for
  strong IDs such as `serial:*`; endpoint/provider fallback IDs remain
  `provisional`.
- Record normalized material sources from K2 `boxsInfo` and CFS-C secondary
  provider frames as `authority: "observation-only"`.
- Preserve external spool sources and CFS slot sources as separate source IDs.
- Preserve `MaterialColor` evidence, RFID `null` / empty string distinctions,
  and remaining raw/normalized/valid fields.
- Add bounded semantic change events. Heartbeat-only observations update
  `lastObservedAt` but do not create new change events.
- Treat `null`, `undefined`, and empty numeric protocol fields as unobserved,
  not as numeric zero. Missing source identity is reported as a diagnostic
  instead of being collapsed to slot `0`.
- Track provider generations. When a newer generation is accepted, the previous
  generation is retired so delayed callbacks from old sessions cannot roll the
  snapshot back.
- Treat K2 `boxsInfo` responses as complete snapshots. Treat CFS-C Moonraker
  `notify_status_update` material payloads as partial snapshots unless the
  initial subscribe response explicitly marks them complete.
- Persist the observation store through localStorage and IndexedDB shared
  storage as last-known read-only evidence. Restored records start as
  `restored-last-known` / stale until a fresh provider observation arrives.

## Non-Authority Boundary

`materialSourceObservations` must not write to or imply:

- `hostSpoolMap`
- `mountHistory`
- `usageHistory`
- managed spool `remainingLengthMm`
- filament ledger command or repair flows
- PrintPlan or command authority eligibility

Future command and PrintPlan gates may use fresh topology as one piece of
send-time evidence, but they must revalidate session, capability, freshness, and
expected state at dispatch time.

## UI Contract

The UI distinguishes:

- **管理中スプール**: the 3DPmon ledger-managed spool mounted to a printer.
- **機器観測フィラメント**: read-only printer/CFS-reported sources.

`T1A` style values are displayed as `割当観測: T1A` because they are slicer/tool
assignment aliases, not physical slot names. A selected slot is displayed as
`機器選択観測`; stale data remains visible as last-known information rather than
current truth.

## Follow-Ups

- Gate 10/12 live certification should verify attach/detach, slot changes,
  RFID/no-RFID behavior, and same-material automatic switching against this
  store.
- Gate 19+ command authority must continue to treat this store as observation
  evidence, not as a direct source of material or ledger authority.
