# ADR-0034 Printer Core Gate 20 K2/CFS Command Transport Mapping

## Context

Gate 18.5, Gate 19, and Gate 19.5 closed the read-only CFS operation UI and
command dispatcher safety boundary. The remaining release path needs actual K2
WS9999 command transport mapping, but live evidence showed that unsafe
`opGcodeFile` starts can complete without feeding filament when no CFS source is
selected.

Public source cross-check gives strong evidence for the K2/CFS print-start path:

```text
OrcaSlicer/OrcaSlicer@9e34dde632455be8614877baea8c103ea80b7b61
  src/slic3r/Utils/CrealityPrint.cpp

K2-family CFS path:
  set colorMatch
  set multiColorPrint

External-spool fallback:
  set opGcodeFile
```

The same public-source review does not certify the LAN keys for standalone CFS
slot select, load, unload, feed, or retract.

## Decision

Add `3dp_lib/printer_core/dashboard_k2_cfs_command_transport.js`.

The module converts a Printer Core v3 `print-start` command request with
explicit CFS tool assignments into two ordered WS9999 frames:

```json
{"method":"set","params":{"colorMatch":{"path":"<gcode-path>","list":[...]}}}
{"method":"set","params":{"multiColorPrint":{"gcode":"<gcode-path>","enableSelfTest":0}}}
```

The mapper is deliberately narrow:

- It never generates `opGcodeFile` for a CFS PrintPlan.
- It rejects external-spool sources instead of falling back.
- It requires each assignment to provide a protocol tool alias, CFS source ID,
  material type, and color evidence.
- It strips a leading `printprt:` prefix before writing `colorMatch.path` and
  `multiColorPrint.gcode`.
- It rejects standalone `cfs-slot-select`, `cfs-load`, `cfs-unload`,
  `cfs-feed`, and `cfs-retract` with `uncertified-cfs-slot-command` unless a
  later production-certified slot-control profile is explicitly enabled for the
  current printer model and firmware.

`sendK2CfsCommandTransportPlan()` sends the frame list sequentially through an
injected send hook. It does not own the WebSocket and does not open new
connections. This keeps the existing dispatcher/session ownership boundary. The
sender accepts only plans produced by `createK2CfsCommandTransportPlan()`; a
caller-forged plain object cannot mark itself as production-certified and reach
the send hook.

The transport summary distinguishes local submission from protocol
acknowledgement:

- `status:"submitted"` means each frame was handed to the local transport without
  a local send error. It does not prove printer command acceptance.
- `status:"acknowledged"` is reserved for hooks that evaluate a protocol
  response and return an accepted/acknowledged/ok/success status.
- `protocolCommandId` is never synthesized from profile or PrintPlan data. It is
  populated only when the transport response itself reports a protocol response
  ID. Otherwise `correlationEvidence.kind` remains `none`.
- Any missing, unknown, rejected, failed, timeout, or error frame response stops
  the sequence before later frames are sent.
- `details.assignmentEvidence[]` records the CFS source ID, protocol tool alias,
  material type/color, and the source field used for each value. Live
  certification must compare this dry-run evidence with the pre-start observed
  CFS slot state before `--send`.

## Consequences

Gate 20 establishes the K2/CFS print-start transport mapping that is safe enough
to bring into live certification. Gate 19/19.5 later added a separate
production-certified path for standalone CFS slot operations. That path remains
closed by default and opens only when all of the following are true:

- `materialSystem.cfsControl.enabled === true` on the current connection target.
- `certifiedCfsSlotControlCommands[]` explicitly allows the command kind.
- `certificationEvidence` uses schema version 1, certified status, the
  production feed-in-or-out profile, and capture/fixture metadata.
- The current target/runtime reports `printerType:"creality-k2"` and the same
  model/firmware scope as the certification evidence.
- Send-time validation still sees an active session, fresh connected topology,
  a loaded CFS slot target, and a non-busy printer state.

The next live gates must verify:

- `colorMatch` then `multiColorPrint` produces post-start selected CFS evidence.
- material consumption is physically observed.
- command result and expected-state confirmation bind to the same active
  session.
- standalone select/load/unload/feed/retract LAN keys are captured before those
  UI actions are enabled for any additional model, firmware, or transport
  profile.

The existing CFS control panel remains disabled for standalone slot actions
without matching production certification and current send-time revalidation.
