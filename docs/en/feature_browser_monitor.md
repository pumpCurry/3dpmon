# Monitoring Creality Printers from Your Browser or Electron

This page explains how to monitor Creality-series, K2 Pro Combo / CFS, and Moonraker / IR3 V2 printers with 3dpmon in a browser or in the Electron desktop app.

## Support Scope

| Family | Monitoring | Camera | Filament Supply | Print Start | Standalone CFS Control |
| --- | --- | --- | --- | --- | --- |
| Creality K1 / K1C / K1 Max family | Supported | MJPEG | External spool | Existing path | N/A |
| K2 Pro Combo / CFS | Supported | WebRTC | External spool + 0-4 CFS units, read-only | Guarded CFS-aware path | Disabled |
| K1C + CFS-C | Implementation foundation / live certification pending | Model dependent | Read-only provider foundation | Certification pending | Disabled |
| Moonraker / IR3 V2 | Supported through a separate protocol path | Moonraker-family path | Separate from K1/K2 CFS authority | Separate path | N/A |

> [!IMPORTANT]
> In v2.2.1044 RC, standalone CFS/CFS-C load, unload, feed, retract, and slot select are not enabled. K2/CFS print start uses a guarded path and proceeds only when CFS slot observation and assignment evidence are available.

## Execution Environments

- **Electron app**: Recommended. It provides free GridStack panel layout, persistent window placement, native notifications, and K2 WebRTC camera display.
- **Browser build**: For development and local verification, run `npm run start:http` and open `http://localhost:8313/3dp_monitor.html`.

## Connecting to a Printer

1. Launch the app.
2. Open **Settings** and add the printer IP address and port. Creality K1/K2 devices normally use WebSocket port `9999`.
3. Choose the printer type. Register K2 Pro Combo as a K2-family printer, and register IR3 V2 / Moonraker devices as Moonraker-family printers.
4. Once connected, panels show hostname, status, temperatures, camera, file list, print history, and related data.
5. For K2/CFS, 3dpmon displays the external spool and CFS slots such as 1A-4D as separate read-only material sources.

## Managing Multiple Printers

3dpmon supports simultaneous monitoring of multiple printers.

- **Adding, removing, and reconnecting printers**: Use Settings to manage each printer independently.
- **Connection state indicators**: Each printer entry shows connected, disconnected, or reconnecting state.
- **Per-host color settings**: Assign a visual color to each printer so panels remain easy to identify.
- **Per-host data isolation**: Each printer keeps its data under `monitorData.machines[hostname]` to avoid cross-device mixing.
- **Printer Core v3 identity dry-run**: K1/K2-family devices use `/info` and WS9999 observations to infer identity. Moonraker / IR3 V2 devices are not mixed into that K1/K2-specific path.

## Panel System

Monitoring data is shown as GridStack panels. Panels can be dragged and resized freely, and layouts are saved automatically. Add panels from the panel menu.

For K2/CFS, the Hybrid Filament UI and CFS Debug / Certification panel separate read-only probes, preflight, dry-run payloads, ARM state, before/after evidence, and protocol event export. LIVE SEND and standalone CFS operations do not become production operations until live certification is complete.

## Troubleshooting

- Verify the IP address and confirm that your computer and printer are on the same network.
- Creality K1/K2 WebSocket connections normally use port `9999`. If you changed it, update the setting.
- K2 WebRTC camera information from `/info` is retained as identity/transport evidence, while the actual camera display connects to the observed WebRTC camera service.
- If CFS data is stale or unobserved, the panel shows the last observed state rather than a current confirmed state. Check the state label before making operational decisions.
- If the connection drops, 3dpmon automatically retries. You can also reconnect manually from Settings.

Browser and Electron monitoring let you check multiple printers from one dashboard without special firmware modifications.
