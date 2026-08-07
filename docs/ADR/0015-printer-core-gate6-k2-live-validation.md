# ADR-0015 Printer Core Gate 6 K2 Pro Combo Live Validation

## Context

Gate 5 closed the K2 live shadow wiring while keeping the legacy UI, command route,
print manager, and filament ledger authoritative. The next boundary is a live,
read-only validation against the local K2 Pro Combo with CFS (`model: "F012"`).

The local target is reachable on the development network and exposes:

- HTTP `/info`: `model: "F012"`, `version: "1.0.0"`, `videoPort: 443`, `wssPort: 443`.
- WebSocket 9999: K1-like status deltas plus K2 CFS `boxsInfo`.

K2 Plus and K2 Pro without CFS remain supported family variants, but they are not
live validation targets for this gate because no hardware is available.

## Decision

- Validate K2 Pro Combo live observation using only read-only traffic:
  - HTTP `GET /info`
  - WebSocket 9999 observation
  - one explicit `{"method":"get","params":{"boxsInfo":1}}` read-only probe
- Refresh the sanitized `tests/fixtures/printers/k2-pro-cfs` fixture with the Gate 6
  idle live capture.
- Replay the captured WebSocket stream through `K2Adapter` / `PrinterFacade` before
  accepting the fixture as the Gate 6 baseline.
- Keep K2 command authority, filament ledger writes, and CFS control operations out
  of scope.

## Evidence

Capture command:

```text
node scripts/capture_protocol_fixture.mjs --host <DEVICE_IP> --model "K2 Pro Combo" --attachment CFS --scenario gate6-live-idle-validation --out tests/fixtures/printers/k2-pro-cfs --duration-ms 15000 --send-boxsinfo --require-http --require-ws --require-boxsinfo --minimum-events 2 --keep-failed --notes "Gate 6 read-only K2 Pro Combo live validation capture"
```

Capture result:

- `success: true`
- `eventCount: 11`
- `httpObserved: true`
- `wsOpened: true`
- `boxsInfoObserved: true`
- `failureReasons: []`
- The same success criteria are stored in fixture metadata under
  `metadata.validation`.

Replay result:

- WebSocket JSON frames replayed: 6
- First status frame reported `model: "F012"` and `cfsConnect: 1`.
- CFS topology became `connected: true`, `topologyState: "fresh"`.
- Material topology normalized to 1 CFS unit, 5 material sources, and 4 tool
  assignments.
- Temperature delta frames preserved K2 CFS topology while updating nozzle and bed
  temperatures.

## Consequences

Gate 6 proves that the local K2 Pro Combo can provide the read-only evidence needed
by Printer Core v3 and that the normalized CFS topology remains stable across sparse
status delta frames.

The proof level is intentionally split:

- Real hardware verified: HTTP `/info`, WS9999 protocol capture, read-only
  `boxsInfo`, K2Adapter replay, and PrinterFacade replay.
- Fixture/integration verified: dashboard connection wiring into
  `observeK2LiveShadowFrame()` and runtime shadow storage.

This gate does not prove print lifecycle semantics for active K2 jobs. A later
hardware-assisted gate should capture and review the following physical states:

- idle
- heating
- printing
- paused
- resumed
- completed
- CFS disconnect and reconnect
- slot/material assignment changes

Future physical-state captures should not overwrite the Gate 6 idle baseline.
They should be added as separate scenario fixtures such as:

- `tests/fixtures/printers/k2-pro-cfs/scenarios/printing`
- `tests/fixtures/printers/k2-pro-cfs/scenarios/paused`
- `tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-reconnect`
