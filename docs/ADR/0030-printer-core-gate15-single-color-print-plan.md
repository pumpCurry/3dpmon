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
attested G-code analysis with logical tool list
one tool assignment
one materialSourceId
one explicit protocolToolAlias/source mapping
```

- Add `validatePrintPlan()` for CI and future repository validation.
- Add `createPrintStartCommandRequestFromPlan()` to turn a start-ready PrintPlan
  into the Gate 14 command contract.
- The generated command is still contract-only, and public plans without a
  trusted upload-authority receipt fail before command request generation:

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
Likewise, an un-analyzed G-code asset is invalid. The factory does not assume a
file is one-tool just because `toolCount` is missing, because that would allow a
multicolor file to enter command authority as a single-color print. The analysis
is derived inside the PrintPlan module from `asset.content`; caller-supplied
`asset.analysis` is rejected instead of being trusted as pre-signed evidence.
The generated asset identity includes the file hash. Caller supplied `assetId`
is accepted only when it matches the deterministic path/name/hash identity.
The asset must also carry an upload receipt that binds the analyzed content hash
to the remote print path. `analysis.fileHash`, `asset.fileHash`, and
`uploadReceipt.fileHash` must match, and `uploadReceipt.remotePath` must match
`asset.path`.
At this gate, caller-declared receipts are normalized as `trusted:false` unless
they carry upload-authority provenance. This keeps the public PrintPlan API
usable for contract construction while preventing it from minting command-ready
upload evidence.
Start-ready validation re-derives upload receipt trust from the private
attestation instead of trusting stored `trusted` booleans, so caller mutation
cannot promote a plan to command-ready. It also requires the start context to
match the upload receipt's `sessionId` and `uploadGeneration`, because a genuine
receipt from an earlier upload is not enough to prove that the current remote
path still contains the same bytes. The start context itself is also treated as
authority-owned evidence, not caller input: copying values out of a stale
receipt cannot satisfy start-ready validation unless the context carries
PrinterSession/UploadRegistry authority provenance.

Single-color plans also do not infer `protocolToolAlias = T1A`. If the selected
source is CFS-backed, the protocol alias must be explicitly supplied by the
verified mapping stage. External-spool support should get its own explicit
source-kind contract instead of relying on a hidden T1A default.
