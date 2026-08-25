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
  `cfs-feed`, and `cfs-retract` with `uncertified-cfs-slot-command`.

`sendK2CfsCommandTransportPlan()` sends the frame list sequentially through an
injected send hook. It does not own the WebSocket and does not open new
connections. This keeps the existing dispatcher/session ownership boundary.

## Consequences

Gate 20 establishes the K2/CFS print-start transport mapping that is safe enough
to bring into live certification. It does not yet enable UI command buttons or
certify physical extrusion.

The next live gates must verify:

- `colorMatch` then `multiColorPrint` produces post-start selected CFS evidence.
- material consumption is physically observed.
- command result and expected-state confirmation bind to the same active
  session.
- standalone select/load/unload/feed/retract LAN keys are captured before those
  UI actions are enabled.

The existing CFS control panel remains disabled for standalone slot actions
until a later certification gate supplies the missing transport evidence.
