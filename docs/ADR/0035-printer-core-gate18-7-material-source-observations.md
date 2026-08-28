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
- Track provider generations per provider ID. `providerStates[providerId]`
  stores the active transport generation, retired generations, last sequence,
  and disconnected time. When a newer generation is accepted, the previous
  generation is retired so delayed callbacks from old sessions cannot roll the
  snapshot back. Sequence rollback checks use the provider-scoped
  `lastSequence` first, so independent material providers do not invalidate one
  another.
- Separate the logical material provider session from the actual transport
  generation. CFS-C Moonraker reconnects keep the same provider session but
  increment transport generation so late frames from the previous socket can be
  rejected without self-locking the endpoint.
- CFS-C Moonraker transport generations include a run-local token in addition
  to the transport epoch. A process restart therefore cannot recreate the same
  generation ID and lock itself out through previously persisted retired
  generations.
- Mark `waiting`, `connecting`, and `disconnected` provider states as
  disconnected observations immediately. A provider only becomes fresh again
  after a new material payload is observed, not merely because a socket is
  opening.
- Treat K2 `boxsInfo` responses as complete snapshots. Treat CFS-C Moonraker
  `notify_status_update` material payloads as partial snapshots unless the
  initial subscribe response explicitly marks them complete.
- Normalized material topology carries `observationMask.sections` and each
  normalized source carries `observedFields`. Partial observation merging uses
  this mask instead of normalized object shape, because the normalizer fills
  unobserved protocol fields with `null` to preserve a stable API. Missing
  `colorMatch` does not clear assignments; an explicitly observed empty
  `colorMatch: []` does.
- Merge CFS-C partial snapshots into the runtime UI topology for display while
  still writing the partial batch to the observation store. This keeps slots not
  present in a Moonraker delta visible as last-known values.
- Persist the observation store through localStorage and IndexedDB shared
  storage as last-known read-only evidence. Restored records start as
  `restored-last-known` / stale until a fresh provider observation arrives.
- Use `resolveDisplayMaterialTopology()` as the display read-model boundary.
  UI panels may fall back to `materialSourceObservations` only as stale
  last-known evidence when live runtime topology is missing, and only when the
  caller explicitly opts in with `allowPersistentLastKnown: true`. Print
  dispatch and command authority do not pass this fallback store and must
  continue to require live send-time validation.
- Restore and import the observation store through a schema-aware normalization
  boundary. Future schema versions are retained as unsupported evidence instead
  of being relabeled as the current schema.
- Reject invalid explicit `observedAt` values instead of converting them to the
  current time. Missing `observedAt` still means the app received the observation
  now.
- Rekey from a provisional observation device to an existing stable device is an
  explicit merge operation. It preserves source snapshots, aliases, canonical
  event evidence, and provider generation state instead of silently dropping the
  provisional record. Strong identity conflict still fails closed.
- Rekey merge of the same source ID uses newer `lastObservedAt` as the winner.
  If the timestamps are equal but semantic content differs, the stable record is
  left unchanged and a `source-merge-conflict` event records the conflict.
- Missing live sources in a complete snapshot become explicit
  `presence: "unobserved"` tombstones, not `empty` slots.
- Stable host fallback is used only when exactly one stable observation record
  matches the host. Ambiguous stable candidates are rejected instead of merged
  or displayed as current evidence.

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
- A later read-model cleanup may split this helper into a richer explicit
  `resolveMaterialSourceReadModel()` if command/UI separation needs more fields.
  The current display boundary already keeps restored evidence out of print
  dispatch and command eligibility.
