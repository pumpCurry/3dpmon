# Filament Spool Management and Inventory Tracking

This document introduces the filament management features in 3dpmon that help you track remaining spool length and maintain inventory across multiple printers.

## Registering Spools
- Click **Add** in the filament management panel to register a spool.
- Each spool is assigned a serial number displayed as **#NNN** for quick identification.
- Specify the spool name, total length and remaining length. Manufacturer and material information can also be stored.
- A 3D preview appears on the dashboard and the remaining amount is updated automatically after each job.

## Global vs Per-Host Data

Filament data is split between global and per-host scope:

### Global (shared across all printers)
- **Spool presets** -- Material presets and spool templates are available to all printers.
- **Spool inventory** -- The spool database and inventory counts are global. Any registered spool can be selected and mounted on any printer.

### Per-Host (isolated per printer)
- **Mounted spool** -- Each printer tracks which spool is currently mounted via the `hostSpoolMap`. Different printers can have different spools loaded simultaneously.
- **Filament consumption** -- Usage tracking (length consumed per job) is recorded per host. Functions such as `useFilament`, `reserveFilament` and `finalizeFilamentUsage` all accept a `hostname` argument to attribute consumption to the correct printer.
- **Consumption history** -- Per-host tracking prevents data contamination. Each printer's filament usage history is independent.

## Inventory Control
- Inventory counts decrease automatically when you swap spools, saving manual work.
- Alerts warn you when inventory is low, and you can open a purchase link if available.

## Multi-Printer Spool Mounting

In a multi-printer setup, spool operations are routed to the correct printer:
- Mounting or unmounting a spool targets the specific printer associated with the panel.
- The `hostSpoolMap` maps each hostname to its currently mounted spool ID.
- Spool remaining length is updated based on consumption data from the correct printer.

## Tips
- Modify `dashboard_spool.js` if you want to maintain a custom spool database.
- Use the reporting feature to see daily or monthly filament usage in graph form, broken down by printer.
- The #NNN serial number format makes it easy to identify spools in the inventory list and mounted-spool display.
