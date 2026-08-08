# Printer Core v3 Gate 10 Live Capture Runbook

## Scope

This runbook is for the K2 Pro Combo + CFS physical topology validation capture.
It is read-only from 3dpmon's side. The capture sends only `/info`, WebSocket
observation, and read-only `boxsInfo` requests.

Do not use this runbook for print start, pause, resume, stop, delete, CFS
load/unload, or material assignment commands.

Do not disconnect or reconnect CFS 485/power wiring while the printer is
powered. Disconnect/reconnect transition evidence may be captured only when a
manufacturer-supported safe logical/operator path is confirmed. When no safe
path exists, split that evidence into a separate power-off-assisted diagnostic
capture and do not force `cfsConnect 1 -> 0 -> 1` in one live WS session.

## Target

Use the local K2 Pro Combo target:

```text
192.168.54.21
```

Expected identity evidence from `/info`:

```json
{
  "model": "F012",
  "version": "1.0.0"
}
```

The wired and wireless MAC addresses may differ. Treat `/info`, `boxsInfo`,
WS9999 behavior, and operator-observed physical state as stronger evidence than
a single MAC address.

## Preflight Diagnostic

Use this only to confirm connectivity. It is not a certification fixture because
stdin markers are disabled and the scenario name is diagnostic.

```powershell
node scripts/capture_k2_cfs_topology.mjs `
  --host 192.168.54.21 `
  --out tmp/gate10-cfs-topology-diagnostic `
  --duration-ms 30000 `
  --no-interactive-markers `
  --minimum-events 2 `
  --notes "Gate 10 diagnostic readiness capture"
```

Expected diagnostic shape:

```text
success=true
httpObserved=true
wsOpened=true
boxsInfoObserved=true
scenario=k2-cfs-topology-diagnostic
```

Analyzer profile is expected to fail with `required-marker-missing` because
physical markers are intentionally absent.

## Certification Capture Command

Run this command when the operator is ready to perform the safe CFS observation
operations. Keep stdin focused in the terminal and type marker names exactly as
listed in the next section.

```powershell
node scripts/capture_k2_cfs_topology.mjs `
  --host 192.168.54.21 `
  --out tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-topology `
  --duration-ms 900000 `
  --boxsinfo-interval-ms 30000 `
  --minimum-events 20 `
  --notes "Gate 10 K2 Pro Combo CFS physical topology"
```

This keeps `--interactive-markers` enabled. Do not pass
`--no-interactive-markers` for the certification fixture.

## Marker Sequence

Type each marker line and press Enter at the moment the physical observation or
operation happens.

```text
observed-cfs-connected
observed-slot-change
observed-material-change
observed-external-spool
observed-color-assignment-change
```

The disconnect/reconnect markers below are diagnostic-only. Use them only after
confirming a manufacturer-supported safe logical/operator path that does not
involve hot-unplugging CFS 485/power wiring:

```text
operator-cfs-disconnect
observed-cfs-disconnected
operator-cfs-reconnect
observed-cfs-reconnected
```

Optional JSON details can be appended when useful:

```text
observed-slot-change {"slot":"1C","operation":"remove-reinsert"}
observed-material-change {"slot":"1C","before":"silver PLA","after":"changed material metadata"}
observed-color-assignment-change {"from":"T1A/T1B/T1C/T1D","to":"operator changed mapping"}
```

Do not put serial numbers, raw MAC addresses, Wi-Fi SSIDs, credentials, or
personal notes into marker details.

## Physical Operations

Suggested order:

```text
1. Confirm CFS is connected and fresh in the printer UI.
2. Enter observed-cfs-connected.
3. Perform a slot remove/reinsert or comparable visible slot change.
4. Enter observed-slot-change.
5. Change material metadata or perform an observable material change.
6. Enter observed-material-change.
7. Observe or attach the external spool endpoint if available.
8. Enter observed-external-spool.
9. Change Creality color/tool assignment if available.
10. Enter observed-color-assignment-change.
11. Let the capture continue for at least one additional boxsInfo interval.
12. Wait for the command duration to end, or stop only after enough post-action
    evidence has been captured.
```

If a safe logical disconnect/reconnect path is confirmed, capture it as a
separate diagnostic scenario named `k2-cfs-disconnect-diagnostic` and analyze it
with the `k2-cfs-disconnect-diagnostic` profile. Do not mix that optional
diagnostic requirement into the Gate 10 certification capture.

## Acceptance Check

Run the analyzer after capture:

```powershell
node scripts/analyze_protocol_scenario.mjs `
  --fixture tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-topology `
  --profile k2-cfs-topology `
  --pretty
```

Expected result for Gate 10 acceptance:

```text
success=true
scenario=k2-cfs-topology-validation
requiredMarkers.missing=[]
requiredPayloadKeys.missing=[]
validation.counts.success=true
```

Review the payload timeline manually before promoting any authority:

```text
slot/material operation -> boxes/materialSources/sameMaterialGroups change
assignment operation    -> colorMatch change
```

If these transitions are visible, use the fixture to design the next
transition/window predicates. Do not certify the predicates before the live
fixture exists. Disconnect/reconnect predicates remain uncertified until the
separate safe diagnostic evidence exists.

## Current Diagnostic Evidence

The 2026-08-08 read-only diagnostic capture showed:

```text
/info reportedModel=F012
WS9999 opened
boxsInfo observed
CFS unit: boxId=1, type=0, 4 observed slots
External endpoint: boxId=0, type=1
All observed material sources had selected=0 while idle
countedEventCount excluded the outbound read-only boxsInfo probe request
```

This evidence confirms readiness for the live physical topology capture, not
topology transition certification.
