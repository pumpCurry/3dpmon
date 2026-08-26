# Printer Core v3 Live Certification Results - 2026-08-26

This note records the live-device evidence gathered on 2026-08-26 for the
Printer Core v3 release-candidate path. The run used the built desktop app and
read-only/protected command tooling from branch `codex/printer-core-v3-gate0`.

## Scope

- K1 Max upload routing and overwrite behavior.
- K2 Pro Combo registration, K2/CFS print-start, completion observation, file
  history, file list, CFS material display, WebRTC camera, and restart recovery.
- IR3 V2 remained connected through its Moonraker/compatibility path and was not
  used for Printer Core v3 K1/K2 command certification.

## Devices

| Host | Role | Observed identity |
| --- | --- | --- |
| `192.168.54.151` | K1 Max test target 1 | `/info` model `K1 Max`, MAC `FCEE28014A1B` |
| `192.168.54.152` | K1 Max test target 2 | `/info` model `K1 Max`, MAC `FCEE280703FA` |
| `192.168.54.153` | K2 Pro Combo with one CFS | `/info` model `F012`, serial `905251280E69E7`, videoPort `443`, wssPort `443` |

The K2 Pro Combo was connected over wireless LAN. The `/info` MAC may represent
the wired LAN interface and must not be used as the only identity equivalence
key.

## Test Files

| Target | Local file | Intended use |
| --- | --- | --- |
| K1 Max only | `D:/Users/pcb/Downloads/K1MAX_testcorn01_PLA_1m12s.gcode` | Upload routing and overwrite validation |
| K2 Pro Combo only | `D:/Users/pcb/Downloads/K2PRO_testcorn01_PLA_1m21s.gcode` | CFS-A1 live print-start and completion validation |

## K1 Max Upload Routing

Result: PASS.

- Uploaded `K1MAX_testcorn01_PLA_1m12s.gcode` to `192.168.54.151` only.
- Verified the file appeared on `192.168.54.151`.
- Verified the file did not appear on `192.168.54.152`.
- Re-uploaded the same K1 file to both `192.168.54.151` and
  `192.168.54.152`.
- Verified both targets contained the file after the second upload, covering the
  forced overwrite path for the already-present target and the add path for the
  second target.

Observed evidence:

- `.151` file size: `140164`.
- `.152` file size after second upload: `140164`.

## K2 Pro Combo Preflight

Result: PASS.

- Uploaded `K2PRO_testcorn01_PLA_1m21s.gcode` to `192.168.54.153`.
- Verified the K2 file list contained the uploaded file.
- Verified K2 WS status was idle/ready before live command submission.
- Verified CFS was connected and CFS unit 1 slot A was available as the intended
  source.
- Dry-run command generation produced only:
  - `set colorMatch`
  - `set multiColorPrint`
- Dry-run did not produce `opGcodeFile`.

Observed CFS source for print:

- Tool alias: `T1A`.
- Source: CFS unit `1`, slot `0` (`1A`).
- Material: `Generic PLA`.
- Color: `0ffffff`.
- Percent: `100`.

## K2 Pro Combo Live Print

Result: PASS.

- Submitted the confirmed live command to `192.168.54.153`.
- The print completed successfully.
- `colorMatch` was observed as `T1A -> boxId 1 materialId 0`.
- CFS slot `1A` became selected during the run.
- `usedMaterialLength` advanced during the run and ended around `208 mm`.
- Final app history row recorded the job as successful.

Observed completion evidence:

- File: `K2PRO_testcorn01_PLA_1m21s.gcode`.
- Start epoch: `1787714315`.
- Usage time: `196 s`.
- Used material: about `208.6 mm`.
- `printfinish`: `1`.
- App history displayed: `2026/08/26 12:18:35 -> 2026/08/26 12:21:51`,
  success, `209 mm`.

## K2 App Registration And UI

Result: PASS.

- Registered `192.168.54.153:9999` in the built app as `creality-k2`.
- The app resolved and displayed the printer as `K2Pro-69E7`.
- The app retained the K2 target with:
  - `printerType: "creality-k2"`
  - `cameraProtocol: "k2-webrtc"`
  - `cameraPort: 8000`
  - `k2MoonrakerHttpPort: 4408`
  - one CFS unit plus one external source slot in material settings.
- The top bar showed four connected devices including `K2Pro-69E7`.
- The K2 file list panel showed the uploaded test file.
- The K2 print history panel showed the completed test print.

## K2 CFS Material Display

Result: PASS.

- The K2 filament panel rendered one external spool plus CFS slots `1A` through
  `1D`.
- The panel displayed:
  - topology state `最新` after fresh `boxsInfo` observation.
  - three loaded CFS slots and zero selected slots after completion.
  - assignment `T1A` on slot `1A`.
  - the read-only operation warning that CFS/CFS-C operations must be performed
    on the printer until command authority is explicitly enabled.
- After app restart, the panel first showed `最終観測`, then returned to `最新`
  after the next read-only `boxsInfo` refresh response was observed.

This behavior matches the stale/fresh safety contract: restored last-known CFS
data is not shown as current until a new topology observation arrives.

Non-RFID filament observation:

- Third-party filament can be loaded without RFID-backed remaining data.
- In that case the printer reports material usage during/after the print, but it
  does not provide an authoritative spool remaining value for 3DPmon to display.
- 3DPmon must therefore treat CFS slot `percent` as device observation only and
  map non-RFID CFS slots to the same app-owned spool ledger model used for K1
  remaining management before release-level material accounting can be certified.
- This is a ledger/assignment authority task rather than a K2 read-only camera or
  print-start blocker.

## K2 WebRTC Camera

Result: PASS.

- Standalone WebRTC probe succeeded before the print.
- Standalone WebRTC probe succeeded after the print.
- The built app displayed a WebRTC `<video>` stream for `K2Pro-69E7`.
- Observed app video dimensions: `1280 x 720`.
- Observed app video state: `readyState = 4`, playing, display `inline`.
- Manual UI inspection confirmed that the stream connected, but also found that
  the initial WebRTC `<video>` element rendered at native pixel size inside the
  camera card. The CSS was updated after the run so WebRTC video uses the same
  card-bounded `object-fit: contain` behavior as the MJPEG image path.

The K2 camera path uses `http://<host>:8000/call/webrtc_local`; `/info`
`videoPort:443` remains identity/firmware evidence and was not needed for the
working local WebRTC path in this environment.

## Restart Recovery

Result: PASS.

- Quit and relaunched the built desktop app with the same persisted profile.
- The app restored the four configured devices.
- `K2Pro-69E7` returned in the top connection list.
- K2 file history and file list panels were restored/refreshed.
- K2 WebRTC camera reconnected and resumed video playback.
- CFS topology stayed stale until a post-restart `boxsInfo` response arrived,
  then returned to fresh display.

## Remaining Physical Certification

The following checks remain useful for full release certification but were not
completed in this run:

- K2 CFS physical detach/reconnect/stale/re-fresh sequence.
- Manual slot insert/remove and material type/color change observation.
- K1C plus CFS-C provider live certification.
- Longer multi-device soak with communication loss/reconnect.
