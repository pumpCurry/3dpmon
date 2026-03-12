# 3dpmon Operation Guide

## Operating Specifications
- Dashboard for monitoring Creality K1/K2 series 3D printers
- Supports simultaneous monitoring of multiple printers with per-host data isolation
- Communicates with each printer via WebSocket on port 9999
- Displays camera stream, temperature chart and print status in real time per printer
- Includes remote commands, file management and notification system
- GridStack-based panel system with drag-and-drop layout customization
- Runs as an Electron desktop app or in a browser via HTTP server
- Settings, history and filament data are persisted in IndexedDB / localStorage
- Preparation time, first-layer check time, pause duration and filament
  information are included in the print history

## Startup

### Electron App (Recommended)
1. Download or clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Launch the Electron app:
   ```
   npm start
   ```
   For development mode with DevTools:
   ```
   npm run dev
   ```
   On Windows you can also double-click `start.bat` which installs
   dependencies automatically and launches the Electron app.

### Browser via HTTP Server (Alternative)
1. Start a static HTTP server:
   ```
   npm run start:http
   ```
   This runs `python -m http.server 8313`. You can also use any static
   file server of your choice.
2. Open `http://localhost:8313/3dp_monitor.html` in your browser.

> **Note:** The Electron app provides full functionality including native
> window management. The browser mode is available as a lightweight
> alternative but may have limitations with certain features.

## Connecting to Printers

### Connection Manager
The connection manager modal is the central place for adding, editing and
managing printer connections. Open it from the title bar.

1. Click the **connection manager** button in the title bar.
2. In the modal, click **Add Connection** to register a new printer.
3. Enter the printer's IP address or hostname. The port is selected
   automatically for supported models (K1 series: 9999, K2 series: 9999).
4. Click **Connect** to establish the WebSocket connection.
5. Repeat for additional printers. Each printer connects independently.

Multiple printers can be connected and monitored simultaneously. Each
connection is managed independently with its own reconnection logic.

### First Connection
When launching the dashboard for the first time there is no saved
network configuration. Use the connection manager to add your first
printer. Camera images stream from port `8080` by default.

## Unlocking Audio
Most browsers block audio playback until the user interacts with the
page. Click anywhere on the start screen to unlock sound effects and
voice playback. A small control with music and voice icons appears in
the lower right corner. If the icons show a slash, audio is disabled;
when they show a circle, notifications will play sounds.

## Panel System (GridStack)

The dashboard uses a GridStack-based panel system that allows free
arrangement of monitoring panels.

### Adding Panels
- Open the **panel add menu** from the title bar or right-click context menu.
- Select the panel type you want to add (e.g., Monitor, Temperature
  Graph, Status, Machine Info, etc.).
- Each panel is bound to a specific printer. When adding a panel, select
  the target printer from the available connections.

### Moving and Resizing
- **Drag** any panel by its title bar to reposition it on the grid.
- **Resize** a panel by dragging its edges or corners.
- The grid snaps panels into alignment automatically.

### Layout Persistence
- Panel positions and sizes are saved automatically.
- The layout is restored when the dashboard is restarted.

### Per-Host Panels
Each panel instance is bound to a specific printer hostname. This means
you can have multiple panels of the same type, each showing data from a
different printer. For example, two Temperature Graph panels can display
charts for two separate printers side by side.

## Screen Overview
All information provided by each connected printer is displayed in its
own set of panels. The main panel types include:

- **Monitor Panel** -- Camera feed, head position preview and print
  controls. Pause, stop, adjust temperatures and toggle fans or LED.
- **Temperature Graph Panel** -- Live chart of nozzle and bed temperatures.
- **Status Panel** -- Progress, elapsed time, remaining time and filament usage.
- **Operation Panel** -- Fan controls, LED, feedrate/flow sliders and
  temperature adjustments.
- **Info Panel** -- Machine limits, model details and usage statistics.
- **Log Panel** -- Received messages and errors with copy buttons.
- **Current Print Panel** -- File currently printing with spool info.
- **Print History Panel** -- Completed jobs with thumbnails and video links.
- **File List Panel** -- Upload, delete and start G-code files.

## Notification Settings
Notification settings have moved from the former Settings card to the
**connection manager modal**. Each printer has its own notification
sub-modal accessible from its connection entry:

1. Open the **connection manager** modal.
2. Click the notification settings icon next to the target printer.
3. Configure notification categories in a table layout:
   - **Print Events** -- Start, complete, pause, cancel, power fail
   - **Camera** -- Snapshot events
   - **Temperature Alerts** -- Abnormal temperature thresholds
4. TTS voice and speed are configured per-host. Each printer can have
   different voice settings.

## Filament Spool Management
- Use the **Add** button in the filament panel to register a spool. A
  dialog asks for the spool name, total length and current remaining length.
- Old spool data is converted automatically when upgrading to a new version.
- You can specify `manufacturerName` or `materialName` when registering
  a spool to track vendors or custom materials.
- Remaining length is updated automatically after each job and the 3D
  preview warns when filament runs out.
- Spool mounting is tracked per-host via `hostSpoolMap`. Each printer
  can have a different spool mounted simultaneously.
- Filament spool definitions, presets and inventory are shared globally
  across all printers.

```html
<div id="filament-preview"></div>
<script src="3dp_lib/dashboard_filament_view.js"></script>
<script>
  const preview = createFilamentPreview(
    document.getElementById('filament-preview'),
    {
      filamentDiameter: 1.75,
      filamentTotalLength: 330000,
      filamentCurrentLength: 120000,
      filamentColor: '#22C55E',
      manufacturerName: 'ACME',
      materialName: 'PLA'
    }
  );
</script>
```
