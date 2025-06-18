# Filament Management Guide

This guide explains the upcoming filament features: usage log, inventory and presets. These tools help track spool changes and remaining stock.

## 1. Overview
- **Usage Log**: Records which spool was used for each print.
- **Inventory**: Tracks the number of unused spools by material and updates the count automatically when switching spools.
- **Presets**: Stores commonly used filament types for quick selection and stock management.

## 2. Data Structure
The data is stored as follows:
```javascript
monitorData = {
  filamentSpools: [ /* per-spool status */ ],
  usageHistory: [ /* job history */ ],
  filamentPresets: [ /* preset definitions */ ],
  filamentInventory: [ /* available stock */ ]
};
```
- **filamentSpools** keep spool IDs, colors, materials and remaining length along with a flag for the active spool.
- **usageHistory** lists when and how each spool was consumed.
- **filamentPresets** hold frequently used filament settings.
- **filamentInventory** counts unused spools by material.

## 3. Operation
New spools can be registered from the **Add** button. Enter the name, length and current remaining amount. Old data is converted automatically on startup. When calling `addSpool()` you may specify `manufacturerName` or `materialName` to track the vendor or custom material. The remaining length updates after every job and a preview warns when running out.

The registration dialog accepts:
- Spool name and sub name
- Manufacturer name (optional)
- Material name and color
- Length and weight (automatic m/g conversion)
- HEX color code

New manufacturers or custom materials can be added via the [+] button next to the field and will appear in future drop-downs.
