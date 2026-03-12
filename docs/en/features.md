# Dashboard Features

This document describes each component of the 3dpmon dashboard and
highlights what can be controlled or managed from each section.

## Electron App

3dpmon runs as an Electron desktop application. This provides native
window management, automatic dependency handling via `start.bat`, and
full access to local file system features. A browser-based mode via
HTTP server is also supported as an alternative.

## Multi-Printer Support

The dashboard supports simultaneous monitoring of multiple 3D printers.
Each printer connection is independent with its own WebSocket, data
store and reconnection logic.

- **Per-host data isolation**: Each printer maintains its own set of
  state data (`_hostStates`, `_msgHostStates`, `_hostChartData` Maps).
  No data is shared or mixed between printers.
- **Independent connections**: Connect, disconnect and reconnect each
  printer independently through the connection manager.
- **Per-host panels**: Every panel instance is bound to a specific
  printer hostname, allowing side-by-side comparison of multiple printers.
- **Per-host camera**: Camera streams are toggled ON/OFF independently
  per printer.
- **Per-host TTS**: Text-to-speech voice and speed settings are stored
  per printer in the `_hostTts` Map, persisted under the `hostTts` key.

## Panel System (GridStack)

The dashboard uses GridStack for a flexible panel layout system.

- **Drag and drop**: Panels can be freely repositioned by dragging
  their title bars.
- **Resize**: Panels can be resized by dragging edges or corners.
  The grid snaps panels into alignment.
- **Panel add menu**: New panels are added from the panel menu in the
  title bar. Each panel is bound to a selected printer.
- **Layout persistence**: Panel positions and sizes are saved
  automatically and restored on restart.
- **Panel types**: Monitor, Temperature Graph, Status, Operation Panel,
  Machine Info, Log, Current Print, Print History, File List and more.

## Header

The title bar shows connected printer names and overall status. The
connection manager button and panel add menu are located here.

## Connection Manager

A modal dialog for managing all printer connections:

- Add, edit and remove printer connections.
- Connect or disconnect individual printers.
- View connection status for each printer.
- Access per-host notification settings via a sub-modal (see below).

## Monitor

Displays the live camera stream and current status indicators per
printer. Buttons are available to pause, resume or stop the active job.
Nozzle or bed temperature adjustments can also be made here.

## Head Preview

Illustrates the print head position in real time, making it easy to
check movements without opening the printer door.

## Filament Preview

Shows the remaining filament on a 3D spool diagram. The amount is
updated automatically after each print and warns when running low.
Each printer can have a different spool mounted via per-host spool
tracking.

## Status

Lists progress, elapsed time and remaining time along with estimated
filament usage for the current job.

## Operation Panel

Provides controls for model/case/auxiliary fans, LED lighting and a set
of print control buttons. Sliders allow adjusting feedrate, flow rate
and target temperatures. Commands are routed to the correct printer via
explicit hostname arguments.

## Temperature Monitor

Live chart showing nozzle and bed temperatures with historical graphs.
Chart data buffers are maintained per-host (`_hostChartData` Map) so
multiple printers can display independent temperature histories.

## Machine Info

Lists axis limits, firmware versions and other hardware details for each
connected printer.

## Log

Shows received and sent messages as well as notifications. Logs can be
copied for troubleshooting.

## Current Print

Summarizes the file currently printing together with the selected
filament spool information for the specific printer.

## Print History

Provides a table of completed jobs with thumbnails and links to any
recorded videos.

## File List

Allows uploading, deleting and starting G-code files. Files can be
selected directly from this list when launching a job.

## Notification Settings

Notification configuration has moved from the former Settings card to
the **connection manager modal** as a per-host sub-modal.

- Open the connection manager and click the notification icon next to
  a printer to open its notification settings.
- Settings are organized in a table with collapsible categories:
  - **Print Events**: Start, complete, pause, cancel, power fail
  - **Camera**: Snapshot events
  - **Temperature Alerts**: Abnormal temperature warning thresholds
- **Per-host TTS**: Each printer can have its own TTS voice and speech
  rate. The `notify()` function automatically applies the correct TTS
  settings based on the notification's `payload.hostname`.

## Filament Spool

Register, edit or delete filament spools. Remaining length is tracked
automatically and low inventory warnings are displayed.

- Spool definitions, presets and inventory are global (shared across
  all printers).
- Spool mounting is per-host: each printer tracks its currently mounted
  spool via `hostSpoolMap`.
- Usage consumption is correctly attributed to each printer based on
  the hostname.

## Storage Settings

Data is stored in IndexedDB (preferred) with a localStorage fallback.
Full data export in v2.00 format and import supporting both v1.40 and
v2.00 formats are available. Storage writes are throttled with a
2-second interval, and video history is capped at 500 entries.

## Command Palette

Lists quick commands such as auto home, bed leveling, firmware upgrade,
factory reset and raw JSON send. Custom G-code can also be issued from
here. Commands are routed to the correct printer via the panel's bound
hostname.
