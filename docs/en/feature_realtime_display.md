# Real-Time Camera and Temperature Display

This section describes the real-time monitoring features in 3dpmon. By combining the camera feed with temperature graphs for each printer, you can monitor multiple print jobs simultaneously.

## Main Features
- Stream each printer's built-in camera in its own panel
- Plot nozzle and bed temperatures with live line charts, isolated per printer
- Charts retain history so you can review changes over time
- All displays update on a 500ms aggregator cycle for smooth, low-overhead rendering

## Per-Host Data Isolation

When monitoring multiple printers, each printer maintains fully independent real-time data:

- **Temperature charts** -- Each printer has its own chart buffer (`_hostChartData` Map). Temperature histories never mix between printers, and chart scaling is independent per device.
- **Camera streams** -- Each printer's camera feed runs in a separate panel. Camera frames are routed by hostname so streams remain isolated.
- **Camera ON/OFF control** -- Each printer's camera can be toggled independently using the per-host camera toggle (`hostCameraToggle`). Turning off one printer's camera does not affect others.
- **Chart reset** -- Temperature chart history can be reset per printer without affecting other printers' chart data.

## Panel Layout

Panels are arranged using the GridStack system, allowing free drag-and-drop placement and resizing. In multi-printer setups, you can arrange temperature and camera panels side by side for easy comparison. The Electron app preserves your panel layout between sessions.

## Usage Tips
- Click the camera image in the camera panel to enlarge it.
- Hover over the temperature graph to show the current value as a tooltip.
- To reset the temperature history for a specific printer, use the chart reset option in that printer's temperature panel.
- The 500ms aggregator update cycle balances responsiveness with CPU efficiency. DOM updates are batched per cycle using a dirty-key change queue to avoid unnecessary redraws.

## Troubleshooting
- If the camera repeatedly reconnects and the browser becomes sluggish, an ad-block extension may be blocking the stream. Temporarily disable the extension or whitelist the site to confirm.
- If temperature charts appear frozen, verify the WebSocket connection state in the Connection Manager.
