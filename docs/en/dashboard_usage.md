# 3dpmon Operation Guide

## Operating Specifications 
- Browser-based dashboard for monitoring Clarity K1 series 3D printers
- Communicates with the printer via WebSocket on port 9999
- Displays camera stream, temperature chart and print status in real time
- Includes remote commands, file management and notification system
- Settings and history are stored in the browser
- Preparation time, first-layer check time, pause duration and filament
  information are included in the print history

## Usage 
1. Download this repository and place the files in a folder
2. Launch a static HTTP server, e.g.:
   ```
   python -m http.server 8000
   ```
3. Open `http://localhost:8000/3dp_monitor.html` in your browser
4. Enter your printer's IP address in the top right field and click "Connect"
5. Use the dashboard to monitor and control the printer

## First Connection
When launching the dashboard for the first time there is no saved
network configuration. Enter the printer's IP address or hostname in
the field at the top right and click **Connect**. The port is selected
automatically for supported models (K1 and K2 series), so normally only
the IP is required. Camera images currently stream from port `8080` and
support for `8000` is under development.

## Unlocking Audio
Most browsers block audio playback until the user interacts with the
page. Click anywhere on the start screen to unlock sound effects and
voice playback. A small control with music and voice icons appears in
the lower right corner. If the icons show a slash, audio is disabled;
when they show a circle, notifications will play sounds. These settings
can be customized from the **Settings** card.

## Screen Overview
All information provided by the printer is displayed on the dashboard.
The main monitor card shows the camera feed and print controls, while
other cards allow file management, temperature adjustments and various
settings.

## Dashboard Layout
- **Title Bar** – Shows the printer hostname and print state. Enter the
  destination IP here and use the Connect/Disconnect buttons. A mute
  indicator appears if sound is disabled.
- **Monitor Card** – Combines the camera feed, head position preview and
  print controls. Here you can pause or stop printing, adjust nozzle and
  bed temperatures and toggle fans or the LED light.
- **Temperature Graph** – Displays a live chart of nozzle and bed
  temperatures.
- **Info Card** – Lists machine limits, model details and overall usage
  statistics.
- **Log Card** – Shows received messages and errors in separate tabs with
  buttons to copy the logs.
- **Print History Card** – Contains a history of completed jobs and a
  file list tab with upload controls for G-code files.
- **Settings Card** – Provides storage settings, notification options and
  a command palette for frequently used commands.

## Filament Spool Management
- Use the **Add** button in the Settings card to register a spool. A dialog
  asks for the spool name, total length and the current remaining length.
- Old spool data is converted automatically when upgrading to a new version.
- You can specify `manufacturerName` or `materialName` when calling
  `addSpool()` to track vendors or custom materials.
- Remaining length is updated automatically after each job and the 3D preview
  warns when filament runs out.
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

