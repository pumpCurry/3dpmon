# ADR-0018 Printer Core Gate 8 Scenario Analyzer

## Context

Gate 7 added capture markers so physical actions can be aligned with protocol
frames. Before collecting more K2 Pro Combo scenarios, those captures need a
repeatable offline acceptance check. The analyzer must be safe to run in CI and
must not connect to printers or send commands.

## Decision

- Add a read-only protocol scenario analyzer under Printer Core v3.
- Analyze existing `metadata.json` and `events.ndjson` files without modifying
  fixture directories.
- Treat the following evidence classes separately:

```text
metadata.validation
operator markers
protocol payload keys
```

- Support required marker checks for future physical scenarios. Plain
  `--require-marker` keeps backward-compatible "any source" matching, while
  physical observations must use source-aware requirements such as
  `--require-observed-marker` so `scheduled-cli` markers cannot certify
  observed printer state.

```text
operator-pause-requested  # any source or scheduled-cli source
observed-paused           # stdin/operator-observed source required
observed-resumed          # stdin/operator-observed source required
observed-completed        # stdin/operator-observed source required
```

- Scenario names can still use existing operator marker vocabulary such as:

```text
operator-print-start
operator-paused
operator-resumed
operator-completed
cfs-disconnected
cfs-reconnected
```

- Support required payload key checks at the semantic payload root only. The
  analyzer unwraps known `result` / `data` envelopes, but it does not recursively
  search arbitrary object trees. This prevents `boxsInfo.materialBoxs[].state`
  from satisfying a printer-root `state` requirement.

```text
printProgress
state
boxsInfo
cfsConnect
```

- Add a CLI wrapper:

```text
node scripts/analyze_protocol_scenario.mjs --fixture <dir> --require-observed-marker <name> --require-payload-key <key>
```

## Non-Goals

- No live printer connection.
- No K2 command authority.
- No CFS command, load/unload, or material switching.
- No fixture mutation.
- No attempt to certify K2 print-state semantics before physical scenario
  captures exist.

## Consequences

Future K2 Pro Combo physical-state captures can be stored under scenario
subdirectories and checked consistently before review. The Gate 6 idle baseline
can also be analyzed with `--require-payload-key boxsInfo`, proving that the
offline path works before any new live scenario is captured.
