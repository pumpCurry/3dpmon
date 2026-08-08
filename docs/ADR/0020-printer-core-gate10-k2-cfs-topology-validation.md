# ADR-0020 Printer Core Gate 10 K2 CFS Physical Topology Validation

## Context

Gate 9 focuses on the K2 Pro Combo print lifecycle. The next physical evidence
boundary is CFS topology: physical connect/disconnect/reconnect behavior,
slot/material changes, external spool observation, and Creality `colorMatch`
assignment changes. Protocol freshness/staleness remains derived evidence from
`cfsConnect` and `boxsInfo`; it is not encoded in physical marker names.

Printer Core v3 already treats K2 `boxsInfo` as read-only material topology.
This gate validates that interpretation against deliberate physical operations
before Data Schema v3 material-source authority is introduced.

## Decision

- Add a built-in Analyzer profile named `k2-cfs-topology`.
- The profile requires the scenario label `k2-cfs-topology-validation` and
  successful capture validation.
- The profile requires operator-observed markers from stdin:

```text
observed-cfs-connected
observed-cfs-disconnected
observed-cfs-reconnected
observed-slot-change
observed-material-change
observed-external-spool
observed-color-assignment-change
```

- The profile also requires action boundary markers:

```text
operator-cfs-disconnect
operator-cfs-reconnect
```

- The profile requires inbound root/envelope payload evidence:

```text
cfsConnect
boxsInfo
```

- The profile emits a reduced payload timeline for:

```text
cfsConnect
boxsInfo
```

  `boxsInfo` timeline entries are summarized to box/source counts, box-unit
  state, external source endpoint counts, material source state,
  `same_material` groups, and `colorMatch` assignment references. The analyzer
  does not use the summary as authority; it is review evidence for the captured
  fixture.

- The recommended capture shape is the dedicated read-only Gate 10 wrapper:

```text
node scripts/capture_k2_cfs_topology.mjs \
  --host <DEVICE_IP> \
  --out tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-topology \
  --duration-ms <entire-cfs-observation-window> \
  --boxsinfo-interval-ms 30000
```

  The wrapper uses the generic recorder with K2+CFS metadata, `--send-boxsinfo`,
  a read-only `boxsInfo` interval probe,
  `--require-http`, `--require-ws`, `--require-boxsinfo`,
  `--interactive-markers`, `--minimum-events 20`, and failed-capture retention
  enabled by default. The interval probe repeats only
  `{"method":"get","params":{"boxsInfo":1}}` so CFS reconnect, slot changes,
  and material changes can be observed without CFS control authority.
  Positive interval values must be at least `5000` ms; the default remains
  `30000` ms for Gate 10 so the probe does not become a high-frequency polling
  loop during physical operations.

- Capture validation records both total `eventCount` and `countedEventCount`.
  `countedEventCount` is the value used for `--minimum-events`. It excludes the
  outbound read-only `boxsInfo` probe request events themselves, because those
  requests are observation aids rather than device evidence. Inbound
  `boxsInfo`, transport events, markers, and heartbeat acknowledgements remain
  counted evidence. The offline Analyzer recomputes this value from
  `events.ndjson` and compares it with `metadata.validation.countedEventCount`
  when that metadata field is present.

- `--no-interactive-markers` is diagnostic-only. When this option is used, the
  wrapper writes `scenario: "k2-cfs-topology-diagnostic"` instead of
  `k2-cfs-topology-validation`, and the notes also state that Gate 10 profile
  acceptance is not expected. Certification captures must leave stdin markers
  enabled.

- The equivalent generic recorder command is:

```text
node scripts/capture_protocol_fixture.mjs \
  --host <DEVICE_IP> \
  --model "K2 Pro Combo" \
  --attachment CFS \
  --scenario k2-cfs-topology-validation \
  --out tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-topology \
  --duration-ms <entire-cfs-observation-window> \
  --send-boxsinfo \
  --boxsinfo-interval-ms 30000 \
  --require-http \
  --require-ws \
  --require-boxsinfo \
  --interactive-markers \
  --minimum-events 20 \
  --notes "Gate 10 K2 Pro Combo CFS physical topology"
```

- After capture, run:

```text
node scripts/analyze_protocol_scenario.mjs \
  --fixture tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-topology \
  --profile k2-cfs-topology \
  --pretty
```

## Non-Goals

- No CFS load/unload command authority.
- No automatic material switching.
- No automatic spool mapping to 3dpmon inventory.
- No ledger write or Data Schema v3 material-source persistence.
- No certification of multicolor print planning.

## Consequences

Gate 10 can validate physical CFS behavior with one repeatable profile instead
of ad hoc marker lists. The reduced `payloadTimeline` lets review compare
`cfsConnect` and summarized `boxsInfo` changes against operator markers before
any CFS topology is promoted to persistent schema or command authority.
