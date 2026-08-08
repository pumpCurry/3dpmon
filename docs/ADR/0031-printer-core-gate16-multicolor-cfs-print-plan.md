# ADR-0031: Printer Core v3 Gate 16 Multicolor/CFS PrintPlan Contract

## Status

Accepted for dry-run contract implementation.

## Context

K2 Pro Combo live observation showed that a print can be started without an
observed CFS selected source. In that state the printer may execute motion while
not feeding filament, which makes a failed multicolor job look like a dry run.

Gate 15 introduced a single-color PrintPlan so even one-tool jobs must carry an
explicit material source. Gate 16 extends that rule to multicolor/CFS jobs before
any command authority cutover.

## Decision

Add a `multicolor-cfs` PrintPlan contract with explicit `toolAssignments[]`.

Each assignment must include:

- `toolAlias`
- `materialSourceId`
- optional protocol evidence such as observed `colorMatch`
- deterministic `assignmentId`

The plan also carries:

- unique `materialSourceIds[]`
- `colorMatchPolicy`
- `asset.toolCount`
- `authority.canStartPrint = false`

`createPrintStartCommandRequestFromPlan()` may convert the plan into a
`print-start` command request, but the command remains `contract-only` and
`canSend = false`. Timeout or transient failure still must not produce blind
retry for print start.

## Consequences

Gate 16 does not yet send commands to the printer. It freezes the shape needed
for safe multicolor command authority:

- no multicolor job can be represented without explicit tool/source mapping
- `multiColorPrint` intent is carried in the command payload
- command authority can later translate the plan into Creality protocol fields
  without guessing from raw G-code or UI state

The next authority gate can use this contract as the preflight boundary for
single-color and CFS/multicolor start flows.
