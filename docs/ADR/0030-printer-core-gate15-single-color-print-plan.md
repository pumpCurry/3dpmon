# ADR-0030 Printer Core Gate 15 Single-Color PrintPlan

## Status

Accepted for Gate 15 single-color print-authority preparation.

## Context

The K2 Pro Combo negative evidence showed that starting a print by directly
sending a protocol command can advance the printer lifecycle without proving
that a material source was selected or feeding. That risk applies even to
single-color prints if the command path is allowed to infer material source
implicitly.

Gate 15 therefore starts with a PrintPlan contract before any production print
start path is changed.

## Decision

- Add `dashboard_print_plan.js`.
- Add `createSingleColorPrintPlan()`.
- Require every single-color plan to include:

```text
deviceId
gcode asset path
one tool assignment
one materialSourceId
```

- Add `validatePrintPlan()` for CI and future repository validation.
- Add `createPrintStartCommandRequestFromPlan()` to turn a PrintPlan into the
  Gate 14 command contract.
- The generated command is still contract-only:

```text
authority.canSend=false
commandKind=print-start
sideEffect=true
idempotent=false
canBlindRetry=false
```

## Non-Goals

- No production print start routing change.
- No K1/K2 protocol frame generation.
- No upload command.
- No CFS `colorMatch` / `multiColorPrint` sending.
- No Data Schema v3 persistence for PrintPlan records.
- No UI cutover.

## Consequences

Single-color print authority now has a reviewable intermediate representation.
Future K1/K2 senders can consume the same plan shape instead of inferring file
and material selection from UI or protocol defaults.

This also keeps single-color and future multicolor/CFS work aligned:

```text
G-code asset
  -> PrintPlan
  -> command request
  -> expected-state confirmation
```

The single-color plan is intentionally strict: a missing material source is an
invalid plan, not a fallback to external spool or printer default behavior.
