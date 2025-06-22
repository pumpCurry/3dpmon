# Filament Spool Management and Inventory Tracking

This document introduces the filament management features in 3dpmon that help you track remaining spool length and maintain inventory.

## Registering Spools
- Click **Add** in the Settings card to register a spool.
- Specify the spool name, total length and remaining length. Manufacturer and material information can also be stored.
- A 3D preview appears on the dashboard and the remaining amount is updated automatically after each job.

## Inventory Control
- Inventory counts decrease automatically when you swap spools, saving manual work.
- Alerts warn you when inventory is low, and you can open a purchase link if available.

## Tips
- Modify `dashboard_spool.js` if you want to maintain a custom spool database.
- Use the reporting feature to see daily or monthly filament usage in graph form.
