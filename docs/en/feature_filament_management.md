# Filament Spool Management and Inventory Tracking

This document introduces the filament management features in 3dpmon that help you track remaining spool length and maintain inventory across multiple printers. In v2.2.1045 RC, 3dpmon also displays read-only device-observed material sources from K2/CFS and K1C/CFS-C separately from the manual spool ledger.

## Registering Spools
- Click **Add** in the filament management panel to register a spool.
- Each spool is assigned a serial number displayed as **#NNN** for quick identification.
- Specify the spool name, total length and remaining length. Manufacturer and material information can also be stored.
- A 3D preview appears on the dashboard and the remaining amount is updated automatically after each job.
- When pending inferred candidates exist, the normal filament management UI separates **confirmed remaining**, **projected remaining**, and **pending inferred usage**.

## K2/CFS and K1C/CFS-C Device Observations

For K2/CFS and K1C/CFS-C, 3dpmon can show material sources reported by the printer or material provider without treating them as manually mounted spools.

- The external spool and CFS slots are displayed as separate sources.
- The display model supports 0 to 4 CFS/CFS-C units, plus the external spool, up to 17 visible material sources.
- Slot color, material name, remaining percentage, loaded state, printer-selected state, and `T1A`-style assignment evidence can be shown.
- Stale CFS data is labeled as a last observation rather than a confirmed current value.
- Invalid remaining values are shown as unknown instead of being rounded to 0%.

These records are saved as read-only `materialSourceObservations`. They do not automatically update `hostSpoolMap`, mount history, usage history, or inventory counts. Non-RFID third-party filament may not report remaining percentage from the printer; manage remaining material through the 3DPmon spool ledger in that case.

> [!IMPORTANT]
> In v2.2.1045 RC, standalone CFS/CFS-C load, unload, feed, retract, and slot select are not enabled. The CFS display is for monitoring; operate filament from the printer itself or from a later certified build.

## Global vs Per-Host Data

Filament data is split between global, per-host, and read-only observation scope:

### Global (shared across all printers)
- **Spool presets** -- Material presets and spool templates are available to all printers.
- **Spool inventory** -- The spool database and inventory counts are global. Any registered spool can be selected and mounted on any printer.

### Per-Host (isolated per printer)
- **Mounted spool** -- Each printer tracks which spool is currently mounted via the `hostSpoolMap`. Different printers can have different spools loaded simultaneously.
- **Filament consumption** -- Usage tracking (length consumed per job) is recorded per host. Functions such as `useFilament`, `reserveFilament` and `finalizeFilamentUsage` all accept a `hostname` argument to attribute consumption to the correct printer.
- **Consumption history** -- Per-host tracking prevents data contamination. Each printer's filament usage history is independent.

### Read-Only Observations
- **materialSourceObservations** -- Stores the last observed external spool and CFS slot state per device. This is monitoring evidence, not ledger authority.

## Inventory Control
- Inventory counts decrease automatically when you swap spools, saving manual work.
- Alerts warn you when inventory is low, and you can open a purchase link if available.

## Multi-Printer Spool Mounting

In a multi-printer setup, spool operations are routed to the correct printer:
- Mounting or unmounting a spool targets the specific printer associated with the panel.
- The `hostSpoolMap` maps each hostname to its currently mounted spool ID.
- Spool remaining length is updated based on consumption data from the correct printer.
- Projected remaining may be used for display and forecasting, but irreversible operations such as inventory consumption, runout decisions, and discarding spools use confirmed remaining only.

## Tips
- Modify `dashboard_spool.js` if you want to maintain a custom spool database.
- Use the reporting feature to see daily or monthly filament usage in graph form, broken down by printer.
- The #NNN serial number format makes it easy to identify spools in the inventory list and mounted-spool display.
