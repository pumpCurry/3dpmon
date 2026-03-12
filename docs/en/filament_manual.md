# Filament Management Guide

This guide explains the filament management features: spool tracking,
usage log, inventory, presets and per-host spool mounting. These tools
help track spool changes, remaining stock and per-printer consumption.

## 1. Overview
- **Spool Tracking**: Register spools with material, color, length and manufacturer. Remaining length updates automatically after each print.
- **Usage Log**: Records which spool was used for each print, attributed to the specific printer.
- **Inventory**: Tracks the number of unused spools by material and updates the count automatically when switching spools.
- **Presets**: Stores commonly used filament types for quick selection and stock management.
- **Per-Host Mounting**: Each printer tracks its currently mounted spool independently via `hostSpoolMap`.

## 2. Data Structure

The data is stored as follows:
```javascript
monitorData = {
  filamentSpools: [ /* per-spool status */ ],
  usageHistory: [ /* job history */ ],
  filamentPresets: [ /* preset definitions */ ],
  filamentInventory: [ /* available stock */ ],
  hostSpoolMap: { /* per-host spool assignments */ }
};
```

### Global Data (Shared Across All Printers)

The following collections are **global** and shared across all connected
printers:

- **filamentSpools** -- All registered spool definitions. Each entry
  contains the spool ID, color, material, dimensions, remaining length
  and metadata.
- **usageHistory** -- A log of when and how each spool was consumed,
  including which printer used it.
- **filamentPresets** -- Frequently used filament settings for quick
  registration.
- **filamentInventory** -- Counts of unused spools grouped by material.

### Per-Host Data

- **hostSpoolMap** -- Maps each printer hostname to its currently
  mounted spool ID. This allows different printers to have different
  spools loaded simultaneously.

```javascript
// Example hostSpoolMap
monitorData.hostSpoolMap = {
  "192.168.54.151:9999": "1709234567890",  // K1Max-4A1B has spool A
  "192.168.54.152:9999": "1709234599999"   // K1Max-03FA has spool B
};
```

When a print job finishes, the filament consumption is deducted from
the spool assigned to that specific printer in `hostSpoolMap`, ensuring
accurate per-host usage tracking.

## 3. Operation

New spools can be registered from the **Add** button in the filament
panel. Enter the name, length and current remaining amount. Old data is
converted automatically on startup. When calling `addSpool()` you may
specify `manufacturerName` or `materialName` to track the vendor or
custom material. The remaining length updates after every job and a
preview warns when running out.

The registration dialog accepts:
- Spool name and sub name
- Manufacturer name (optional)
- Material name and color
- Length and weight (automatic m/g conversion)
- HEX color code

New manufacturers or custom materials can be added via the [+] button
next to the field and will appear in future drop-downs.

### Mounting a Spool on a Printer

To mount a spool on a specific printer:
1. Open the filament panel for the target printer.
2. Select a spool from the registered list.
3. Click **Mount** or select the spool. The `hostSpoolMap` entry for
   that printer is updated.

Each printer can have a different spool mounted. When a print job
completes, the system looks up the mounted spool for that printer
via `hostSpoolMap` and deducts the consumed filament length.

### Per-Host Usage Tracking

Filament consumption is tracked per printer:
- The `useFilament()`, `reserveFilament()` and `finalizeFilamentUsage()`
  functions accept a `hostname` argument to identify which printer is
  consuming filament.
- Usage history entries include the printer hostname, allowing you to
  see which printer consumed which spool.
- If a spool is selected before the job finishes and the history entry
  lacks filament information, the mounted spool for that printer is
  added automatically.

### Registered Filament Tab

The Registered Filament tab lists all spools that have been added so far and lets you edit them.

```
[Add New]

+--Search: --------------------+
|[Brand v][Material v][Color v][Name][Search]|
+------------------------------+
+---+ List: (nnn of nnn)
|Prev| |Brand|Material|Color|Name|Sub Name|Uses|Last Used|Cmd|
|    | |.....|.......|....|....|.......|....|........|...|
|    | |.....|.......|....|....|.......|....|........|...|
+---+ |.....|.......|....|....|.......|....|........|...|
```

 - Use **Add New** to register a spool.
 - Favorites and frequently used filaments are shown in carousels below this button.
- **Search** filters the list by brand, material, name, color or a partial match.
  - Brand: `manufacturerName`
  - Material: `materialName`
  - Name: `reelName/reelSubName`
  - Color: displays the color swatch using `filamentColor` as font color
  - The name field accepts partial matches.
- Click the search icon to apply the filters.
- A 3D preview appears on the left of the list.
- Columns can be sorted by clicking the header.
  - **ID**: Filament ID (epoch)
  - **Brand**: `manufacturerName`
  - **Material**: `materialName`
  - **Color**: swatch with `filamentColor` and `materialColorName`
  - **Name**: `reelName`
  - **Sub Name**: `reelSubName`
  - **Uses**: Number of times the filament ID was used (from history)
  - **Last Used**: Last print time (YYYY-MM-DD HH:mm:ss)
  - **Cmd**: Edit opens the same dialog used for registration.

Default settings for a new spool:
```javascript
const defaultFilamentOptions = {
  filamentDiameter: 1.75,
  filamentTotalLength: 336000,
  filamentCurrentLength: 336000,
  reelOuterDiameter: 195,
  reelThickness: 58,
  reelWindingInnerDiameter: 68,
  reelCenterHoleDiameter: 54,
  reelBodyColor: '#91919A',
  reelFlangeTransparency: 0.4,
  reelWindingForegroundColor: '#71717A',
  reelCenterHoleForegroundColor: '#F4F4F5',
  showInfoLength: true,
  showInfoPercent: true,
  showInfoLayers: true,
  showResetButton: false,
  showProfileViewButton: true,
  showSideViewButton: true,
  showFrontViewButton: true,
  showAutoRotateButton: true,
  enableDrag: true,
  enableClick: false,
  onClick: null,
  disableInteraction: false,
  showOverlayLength: true,
  showOverlayPercent: true,
  showLengthKg: true,
  showSlider: false,
  filamentWeightKg: 1.0,
  showReelName: true,
  showReelSubName: true,
  showMaterialName: true,
  showMaterialColorName: true,
  showMaterialColorCode: true,
  showManufacturerName: true,
  showOverlayBar: true,
  showPurchaseButton: true,
  currencySymbol: '¥',
};

const sampleRegistration = {
  manufacturerName: 'CC3D',
  reelName: 'PLA MAX Filament',
  reelSubName: 'Matte Finish',
  filamentColor: '#FCC4B6',
  materialName: 'PLA+',
  materialColorName: 'Sand',
  materialColorCode: '#ED1C78',
  purchaseLink: 'https://www.amazon.co.jp/dp/B09B4WWM6C',
  price: 1699,
};
```
