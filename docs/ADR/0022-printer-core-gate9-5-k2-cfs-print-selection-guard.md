# ADR-0022 Printer Core Gate 9.5 K2 CFS Print Selection Guard

## Context

Gate 9 captured K2 Pro Combo Benchy command evidence. Follow-up live testing
showed a hazardous read-only finding: `opGcodeFile` can start and complete a
K2 print lifecycle while no CFS slot is selected and no filament is physically
fed. The protocol can therefore look successful even when the print is
dry-run-like.

This must be visible before K2 command authority, Data Schema v3 material-source
authority, or filament ledger writes are enabled.

## Decision

- Add a scenario analyzer profile named `k2-cfs-print-selection`.
- Harden `scripts/capture_k2_benchy_print.mjs` so CFS attachments do not send
  `opGcodeFile` by default.
- The profile is intentionally scenario-name agnostic so it can be applied to
  Gate 9/10 fixtures and future manually started prints.
- The profile requires:

```text
operator-print-start
observed-printing
boxsInfo
```

- The profile also requires that at least one observed `boxsInfo` frame contains
  a material source with:

```text
materialBoxs[].materials[].selected == 1
```

- The analyzer report now includes a read-only `cfsSelection` summary:

```text
checked
observedSelectedSource
selectedSourceIds
framesWithSelected
framesWithoutSelected
timeline[]
```

- If the profile is used and no selected source is observed, the scenario fails
  with:

```text
cfs-selected-source-missing
```

- The Gate 9 capture helper now requires an explicit negative-evidence override
  before sending `opGcodeFile` with a CFS attachment:

```text
--allow-unsafe-opgcodefile-cfs-start
```

Without that flag, it records preflight evidence and an
`operator-print-start-blocked` marker instead of starting a dry-run-like CFS
print.

## Source Evidence

The source cross-check supports this contract:

```text
OrcaSlicer/OrcaSlicer@af9fd10d
  K2-family CFS print:
    set colorMatch
    set multiColorPrint
  external source fallback:
    set opGcodeFile

CrealityOfficial/CrealityPrint@24b9395
  send workflow:
    open_cfs
    color_match_info[]
  cloud task:
    enableCfs
    filamentsList
```

This does not yet prove the final LAN command authority shape for 3dpmon, but it
does prove that a CFS-safe print plan must carry explicit assignment evidence and
must verify selected-source observation after start.

## Non-Goals

- No automatic K2 print start.
- No automatic `colorMatch` / `multiColorPrint` sending.
- No retry policy.
- No filament ledger write.
- No UI authority change.

## Consequences

Future K2/CFS print captures can be checked with:

```text
node scripts/analyze_protocol_scenario.mjs \
  --fixture <fixture-dir> \
  --profile k2-cfs-print-selection \
  --pretty
```

The Gate 9 Benchy command capture remains useful negative evidence: it can pass
the command-capture profile while failing the CFS selected-source profile. That
distinction prevents later command authority from mistaking protocol completion
for physical filament delivery.

Future reproduction of that negative evidence is still possible, but it must be
intentional via `--allow-unsafe-opgcodefile-cfs-start`. Normal CFS command
captures should wait for a PrintPlan path that can express explicit material
assignment and selected-source confirmation.
