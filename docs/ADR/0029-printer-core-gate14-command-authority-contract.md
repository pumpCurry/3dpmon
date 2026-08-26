# ADR-0029 Printer Core Gate 14 Command Authority Contract

## Status

Accepted for Gate 14 command-foundation contract preparation.

## Context

Printer Core v3 must eventually become the command authority, but the K2/CFS
negative evidence showed that a protocol-level "command accepted" or lifecycle
transition is not enough to prove that the requested physical action happened.

Before wiring any production command path into Printer Core v3, the command
boundary needs a stable envelope for:

```text
command ID
result ID
timeout
expected-state confirmation
side-effect classification
retry safety
```

## Decision

- Add `dashboard_command_authority.js` as a pure contract module.
- Add `createPrinterCommandRequest()` to produce a command envelope without
  sending anything to a printer.
- Add `createPrinterCommandResult()` to bind transport outcome and
  expected-state confirmation.
- A result can complete only when the transport status is accepted/acknowledged
  and, for expected-state commands, the observation is explicitly post-command:

```text
observed sequence > sent sequence
same session, with an explicit observed session ID
dispatcher-owned command correlation evidence present
```

The correlation is not a caller boolean. It must be structured evidence bound to
the command ID, session ID, sent sequence, observed sequence, observed session,
and evidence source. Current dry-run code uses module-private attestation as a
fail-closed placeholder; production authority should replace it with
dispatcher-owned evidence from the actual send/observe pipeline.

The dry-run module does not export a public correlation evidence factory. Until
the dispatcher owns that lifecycle evidence, expected-state commands can remain
acknowledged but not completed.

- Add `evaluateExpectedStateConfirmation()` for NormalizedState checks.
- Add `shouldRetryPrinterCommand()` with fail-safe side-effect behavior.
- Unknown commands are treated as:

```text
sideEffect=true
idempotent=false
expectedStateRequired=true
```

- Known non-idempotent side-effect commands do not blind retry:

```text
print-start
print-stop
file-delete
cfs-load
cfs-unload
```

- Gate 14 requests are `contract-only`:

```text
authority.canSend=false
```

## Non-Goals

- No production command routing changes.
- No replacement of `dashboard_send_command.js`.
- No replacement of `dashboard_printmanager.js`.
- No K2/CFS print command authority.
- No automatic retry execution.
- No Data Schema v3 command persistence.

## Consequences

Future command slices can wire the legacy K1/K2 command senders through this
request/result contract. Until that happens, the new module is useful as a
reviewable safety boundary and as CI coverage for the most important rule:

```text
non-idempotent side-effect command + timeout != blind retry
```

Expected-state confirmation also gives the later command authority a single
place to decide whether a command was merely acknowledged or actually observed
in the normalized printer state.

Transport errors, transient errors, timeouts, failed statuses, and unknown
statuses cannot become completed solely because the current normalized state
matches the requested target state.

If the confirmation caller omits `observedSessionId`, the result is treated as
not confirmed even when the expected state matches. Authority wiring should
derive `observedSequence` and `observedSessionId` from the observed
NormalizedState/session source rather than from free-form caller claims. It
should also derive command correlation from dispatcher evidence rather than from
caller-provided `true`.
