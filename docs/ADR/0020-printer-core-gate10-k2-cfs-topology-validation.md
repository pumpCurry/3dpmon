# ADR-0020 Printer Core Gate 10 K2 CFS Physical Topology Validation

## Context

Gate 9 focuses on the K2 Pro Combo print lifecycle. The next physical evidence
boundary is CFS topology: connection freshness, disconnect/reconnect behavior,
slot/material changes, external spool observation, and Creality `colorMatch`
assignment changes.

Printer Core v3 already treats K2 `boxsInfo` as read-only material topology.
This gate validates that interpretation against deliberate physical operations
before Data Schema v3 material-source authority is introduced.

## Decision

- Add a built-in Analyzer profile named `k2-cfs-topology`.
- The profile requires the scenario label `k2-cfs-topology-validation` and
  successful capture validation.
- The profile requires operator-observed markers from stdin:

```text
observed-cfs-connected-fresh
observed-cfs-disconnected-stale
observed-cfs-reconnected-fresh
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

  `boxsInfo` timeline entries are summarized to box/source counts, material
  source state, and `colorMatch` assignment references. The analyzer does not
  use the summary as authority; it is review evidence for the captured fixture.

- The recommended capture shape is:

```text
node scripts/capture_protocol_fixture.mjs \
  --host 192.168.54.21 \
  --model "K2 Pro Combo" \
  --attachment CFS \
  --scenario k2-cfs-topology-validation \
  --out tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-topology \
  --duration-ms <entire-cfs-observation-window> \
  --send-boxsinfo \
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
