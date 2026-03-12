# Monitoring Creality Printers from Your Browser

This page explains how to monitor Creality series 3D printers using 3dpmon in your browser or the Electron desktop app.

## Supported Models
- Creality K1 / K1C / K1A / K1 Max

## Execution Environments

### Browser
Open `3dp_monitor.html` directly in a modern browser. All monitoring and control features work without installation.

### Electron App
Launch the Electron desktop application for a dedicated window experience with native OS integration. The Electron app uses the same codebase but provides additional benefits such as system tray support and persistent window positioning. Panels are arranged using the GridStack layout system, allowing free drag-and-drop placement and resizing.

## Connecting to a Printer

1. Click the **Connection Manager** button to open the connection settings modal.
2. Enter the printer's IP address and WebSocket port (default `9999`).
3. Optionally assign a display name and per-host color to distinguish this printer visually.
4. Click **Connect**. Once connected, the panel header shows the hostname, model and connection state.

## Managing Multiple Printers

3dpmon supports simultaneous monitoring of multiple printers. Each printer maintains an independent WebSocket connection with isolated data.

- **Adding printers** -- Open the Connection Manager modal and add additional IP addresses. Each connection is managed independently.
- **Removing printers** -- Disconnect and remove entries from the Connection Manager.
- **Reconnecting** -- If a connection drops, 3dpmon automatically attempts reconnection. You can also manually reconnect from the Connection Manager.
- **Connection state indicators** -- Each printer entry shows its current state: connected (green), disconnected (grey), or reconnecting (amber).
- **Per-host color settings** -- Assign a unique color to each printer in the Connection Manager. The color is applied to panel borders and headers for quick visual identification.

## Troubleshooting
- Verify the IP address and confirm that your computer and printer are on the same network.
- The WebSocket port is normally `9999`. If you changed it, update the setting in the Connection Manager modal.
- If the connection drops, the system will automatically retry. You can also manually reconnect from the Connection Manager.
- In the Electron app, check the developer console (Ctrl+Shift+I) for connection error details.

Browser and Electron monitoring let you check your printers from anywhere without special software or firmware modifications.
