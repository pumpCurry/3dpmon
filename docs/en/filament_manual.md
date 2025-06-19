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

### Registered Filament Tab

The Registered Filament tab lists all spools that have been added so far and lets you edit them.

```
[Add New]

┏Search: ━━━━━━━━━━━━━━━━━━━┓
┃[Brand▼][Material▼][Color▼][Name][🔍 Search]┃
┗━━━━━━━━━━━━━━━━━━━━━━┛
┌───┐ List: (nnn of nnn)
│Prev│ |Brand|Material|Color|Name|Sub Name|Uses|Last Used|Cmd|
│    │ |.....|.......|....|....|.......|....|........|...|
│    │ |.....|.......|....|....|.......|....|........|...|
└───┘ |.....|.......|....|....|.......|....|........|...|
```

 - Use **Add New** to register a spool.
 - Favorites and frequently used filaments are shown in carousels below this button.
- **Search** filters the list by brand, material, name, color or a partial match.
  - Brand: `manufacturerName`
  - Material: `materialName`
  - Name: `reelName/reelSubName`
  - Color: `{■}{filamentColor}{materialColorName}` (`■` uses `filamentColor` as font color)
  - The name field accepts partial matches.
- Click the search icon to apply the filters.
- A 3D preview appears on the left of the list.
- Columns can be sorted by clicking the header.
  - **ID**: Filament ID (epoch)
  - **Brand**: `manufacturerName`
  - **Material**: `materialName`
  - **Color**: `{■}{filamentColor}{materialColorName}`
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
