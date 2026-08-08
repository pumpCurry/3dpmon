# ADR-0024 Printer Core Gate 11 PrinterSession Prep

## Context

Printer Core v3 originally keyed the live runtime by `deviceId` and stored one
`PrinterInstance` for that device. That shape was enough for K1/K2 read-only
shadowing, but later authority gates need to model one physical printer with
multiple transports:

```text
WS9999 status stream
HTTP /info identity probe
MaterialProvider / boxsInfo observation
Camera stream
future command channel
```

Gate 11 should prepare this shape before Data Schema v3 and command authority,
without changing the current UI, print manager, or live shadow behavior.

## Decision

- Add a `PrinterSession` metadata module.
- Keep `PrinterFacade.instances` keyed by `deviceId` for compatibility.
- Add `PrinterFacade.sessions`, also keyed by `deviceId`, as active session
  metadata.
- `beginSession()` now creates both:

```text
PrinterInstance
PrinterSession metadata
```

- `endSession()` closes and removes both only when `sessionId` matches.
- Expose `getSession(deviceId)` as a clone-returning read-only diagnostic API.
- Store transport metadata as evidence only:

```text
kind
endpoint
role
authority = read-only-observation
observedAt
metadata
```

## Non-Goals

- No command routing changes.
- No Data Schema v3 session store yet.
- No multi-transport reconnection policy.
- No camera or MaterialProvider lifecycle ownership transfer.
- No UI authority cutover.

## Consequences

Future gates can promote the same concept into persistent `deviceSessions` and
`deviceEndpoints` stores without first changing the live-shadow API shape.

The current behavior remains compatibility-preserving:

```text
observeFrame()
observeFrameResult()
endSession()
getState()
```

continue to work against the active `PrinterInstance`. `PrinterSession` only
adds a read-only metadata surface that can describe which transports were part
of the active device session.
