# Remote Control, File Management and Notifications

This page details 3dpmon's remote control capabilities, file handling tools and notification settings across multiple printers.

## Remote Control
- Use the **Operation Panel** to adjust nozzle or bed temperatures and toggle fans or the LED light.
- Pause, stop or reset a print job even while it is running.
- When the head cannot be moved by hand during pause, use the **XY Unlock** button to release the stepper lock.
- Frequently used commands are available from the **Command Palette** for one-click access.
- For K2/CFS file printing, 3dpmon uses a guarded path from `colorMatch`
  to `multiColorPrint` only when CFS slot observation and assignment
  evidence are available.

> [!IMPORTANT]
> In v2.2.1045 RC, standalone CFS/CFS-C load, unload, feed, retract, and slot select are not enabled. LIVE SEND in the CFS Debug / Certification panel is not enabled as a production command.

### Per-Host Command Routing

In a multi-printer setup, all commands are routed to the specific printer associated with each panel. When you adjust temperature or send a control command from a panel, the command is sent to that panel's host -- there is no global "active printer" selection. Send-time checks revalidate the target connection, session, file identity, and CFS observation state before guarded K2/CFS print-start commands proceed.

## File Management
- Upload or delete G-code files from the **File List** panel.
- Choose an uploaded file and press **Start Print** to launch a job.
- You can re-run previous jobs from the history panel.
- For K2-family printers, file lists and print history are requested over
  WS9999 first and can fall back to the read-only HTTP API on port `4408`.

### Per-Host File Lists

Each printer maintains its own file list via the `_fileListMap` per-host Map. File listings are fetched and cached independently for each connected printer, so browsing files on one printer does not interfere with another.

## Managing Multiple Printers

Use the **Connection Manager** modal to add, remove and manage printer connections. The modal provides:
- A list of all configured printers with connection state indicators
- Controls to connect, disconnect or reconnect individual printers
- Per-host color assignment for visual identification
- Per-host display name configuration

Panels are arranged using the GridStack layout system, allowing free placement and resizing of panels for each printer.

## Notification Settings

Notification settings are configured through the **Connection Manager modal's sub-modal**, not a standalone settings panel.

- Toggle notifications per printer from the connection settings.
- Notifications are organized in a table format with collapsible categories: print events, camera alerts and temperature alerts.
- Browser notifications or optional webhooks can alert you when a print completes or when filament runs low.
- Thresholds for low filament warnings and webhook URLs are configured per connection.
- Notification messages display the printer's display name (from `storedData.hostname.rawValue` or model) rather than a raw hostname.

### Per-Host TTS Settings

Text-to-speech (TTS) voice announcements can be configured independently for each printer:
- Each printer can use a different TTS voice and speech rate, stored in the `_hostTts` Map.
- TTS settings are persisted per host using the `hostTts` storage key.
- When a notification fires, the `notify()` function automatically applies the TTS settings for the relevant printer based on `payload.hostname`.

## Per-Host Print History

Print history is tracked independently for each printer. Completion records, duration logs and filament consumption are stored per host to prevent data contamination between printers.
