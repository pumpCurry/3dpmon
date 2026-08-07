# ADR-0019 Printer Core Gate 9 K2 Print Lifecycle Capture

## Context

Gate 8 closed the offline scenario analyzer. The next milestone is collecting a
single K2 Pro Combo + CFS print lifecycle fixture that ties physical operator
observations to raw WS9999 `state` / `deviceState` / progress fields.

K2 print semantics are still intentionally marked as provisional in Printer Core
v3. This gate gathers evidence; it does not grant command authority or certify a
mapping by itself.

## Decision

- Add a built-in Analyzer profile named `k2-print-lifecycle`.
- The profile requires the scenario label `k2-print-lifecycle` and successful
  capture validation.
- The profile requires operator-observed markers from stdin:

```text
observed-idle-before-start
observed-heating
observed-printing
observed-paused
observed-resumed
observed-completed
observed-idle-after-completed
```

- The profile also requires action boundary markers:

```text
operator-print-start
operator-pause-requested
operator-resume-requested
```

- The profile requires inbound root/envelope payload evidence:

```text
state
deviceState
printProgress
printFileName
printId
nozzleTemp
targetNozzleTemp
bedTemp0
targetBedTemp0
cfsConnect
boxsInfo
```

- The profile emits a reduced payload timeline for these root fields:

```text
state
deviceState
printProgress
printFileName
printId
```

- The recommended capture shape is:

```text
node scripts/capture_protocol_fixture.mjs \
  --host 192.168.54.21 \
  --model "K2 Pro Combo" \
  --attachment CFS \
  --scenario k2-print-lifecycle \
  --out tests/fixtures/printers/k2-pro-cfs/scenarios/print-lifecycle \
  --duration-ms <entire-print-window> \
  --send-boxsinfo \
  --require-http \
  --require-ws \
  --require-boxsinfo \
  --interactive-markers \
  --minimum-events 20 \
  --notes "Gate 9 K2 Pro Combo print lifecycle"
```

- After capture, run:

```text
node scripts/analyze_protocol_scenario.mjs \
  --fixture tests/fixtures/printers/k2-pro-cfs/scenarios/print-lifecycle \
  --profile k2-print-lifecycle \
  --pretty
```

## Non-Goals

- No automatic print start, pause, resume, stop, delete, or upload command.
- No command retry policy.
- No CFS load/unload command.
- No Data Schema v3 migration.
- No K2 print-state certification until the captured raw state timeline is
  reviewed.

## Consequences

Gate 9 capture can be accepted with one stable profile instead of a long list of
manual marker and payload requirements. The report also includes a reduced
`payloadTimeline`, so the next review can compare raw `state` / `deviceState`
timeline against the operator-observed markers and decide whether K2 print
semantics can move beyond
`k1-compatible-provisional`.
