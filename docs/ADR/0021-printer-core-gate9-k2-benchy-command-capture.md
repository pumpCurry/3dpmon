# ADR-0021 Printer Core Gate 9 K2 Benchy Command Capture

## Context

Gate 8 closed the offline scenario analyzer and Gate 9 was originally scoped as
a read-only/manual K2 print lifecycle capture. During live preparation, the local
K2 Pro Combo had a one-print-safe build plate available, so we used the chance to
capture a complete single-color Benchy command lifecycle.

This gate records command evidence only. It does not make Printer Core v3 the
general K2 command authority.

## Decision

- Add `scripts/capture_k2_benchy_print.mjs` as a narrow live-capture CLI.
- The CLI performs preflight evidence collection before any print command:

```text
/info
boxsInfo
reqHistory
reqGcodeFile -> retGcodeFileInfo2
```

- The CLI selects a local Benchy G-code and sends exactly one command:

```json
{"method":"set","params":{"opGcodeFile":"printprt:<printer-local-path>"}}
```

- The CLI does not retry the print command blindly.
- The CLI stores failed command captures under `tmp/failed-captures` when a
print command was sent or `--keep-failed` is specified.
- Add an Analyzer profile named `k2-benchy-print-command`.
- The profile requires automation markers instead of manual stdin markers:

```text
observed-idle-before-start
operator-print-start
observed-printing
observed-heating
observed-completed
observed-idle-after-completed
```

- The live fixture is stored at:

```text
tests/fixtures/printers/k2-pro-cfs/scenarios/benchy-print-command
```

## Observed Live Result

The local file list exposed `retGcodeFileInfo2`. The available single-color
Benchy was:

```text
3DBench_PLA_21m.gcode
```

Its K2 file-list match was:

```text
T1A=T1B
```

Therefore the captured single-color Benchy followed the printer's current match
and did not force the previously inspected `T1C` slot. The `T1C` source remained
recorded as planning evidence in the command marker when available.

The capture observed:

```text
preflight idle
print command sent
active/printing state
heating evidence
completed state
idle after completion
```

Later live comparison found an important negative result: a K2 Pro Combo can
advance and complete a print lifecycle after an `opGcodeFile` start while no CFS
material has `materials[].selected=1`. In that mode the protocol history and
progress look print-like, but the CFS does not physically feed filament. This
gate therefore records `opGcodeFile` as command evidence only, not as a safe K2
CFS print-start contract.

After Gate 9.5, `scripts/capture_k2_benchy_print.mjs` refuses to send this
command for a CFS attachment unless the operator passes:

```text
--allow-unsafe-opgcodefile-cfs-start
```

That override is reserved for reproducing negative evidence. It is not the
planned CFS print-start path.

## OrcaSlicer / CrealityPrint Source Cross-Check

Public source review was performed against:

```text
OrcaSlicer/OrcaSlicer@af9fd10d
CrealityOfficial/CrealityPrint@24b9395
```

OrcaSlicer has the clearest LAN evidence. For K2-family models including F012,
it does not rely on `opGcodeFile` for CFS slot printing. It builds a
tool-to-slot list and sends:

```text
set colorMatch
set multiColorPrint
```

When any selected source is the external box (`boxId == 0`), Orca falls back to
`opGcodeFile`.

CrealityPrint's newer send flow is more abstract. The desktop code passes
`open_cfs` and `color_match_info[]` through the send UI / workflow boundary, and
the cloud path converts those into `enableCfs` and `filamentsList`. This supports
the same design conclusion: CFS printing must carry explicit material mapping
evidence, and `selected` should be observed after start before treating the print
as physically feeding filament.

## Non-Goals

- No K2 command authority promotion.
- No CFS tool assignment override.
- No pause/resume/stop/delete command.
- No filament ledger write.
- No certification that K2 `state` / `deviceState` semantics are final.

## Consequences

We now have a real K2 Pro Combo command lifecycle fixture with outbound command
evidence, K2 `retGcodeFileInfo2` file-list shape, status deltas, and CFS
topology snapshots. This is strong input for later command-authority design, but
the authority cutover remains gated on explicit command/result contracts and
Data Schema v3 material-source mapping.

Any future CFS-safe command path must build a PrintPlan with explicit material
assignment, then confirm selected-source evidence after start before it is
allowed to affect command authority or filament-ledger state.
