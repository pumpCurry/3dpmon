# Blank Screen Troubleshooting

This document helps verify the front-end rendering pipeline when the browser only shows a white screen after completing up to **Step 7 (E2E tests & release preparation)** of `future.md`.

## Expected UI layout

1. **Title Bar** – hamburger menu, application title or login status, and a future side menu icon.
2. **Tab Bar** – tabs for each connected printer (scrollable).
3. **Side Menu** – slide-in menu triggered from the hamburger icon listing connections, settings, theme toggle, and About.
4. **Dashboard Cards** – CameraCard, HeadPreviewCard, StatusCard, ControlPanelCard, CurrentPrintCard, TempGraphCard, MachineInfoCard, HistoryFileCard, SettingsCard.
5. **Shared UI** – card handles and close buttons, draggable with scale handles, supports dark and light themes.

## Debug checklist

1. **Startup pipeline**
   - After `npm run dev`, check the terminal output:
    ```
    VITE vX.Y.Z  ready in N ms
    ➜  Local: http://localhost:5173/
    ```
    If an `EACCES: permission denied, rename` error occurs, run
    `scripts/clear-vite.sh` to reset the cache on Dropbox or network drives.
2. **`startup.js` invocation**
   ```js
   // src/startup.js
   import { App } from './core/App.js';
   new App('#app-root');
   ```
3. **`App` construction**
   ```js
   export class App {
     constructor(selector) {
       this.root = document.querySelector(selector);
       this.cm = new ConnectionManager(bus);
       this.db = new DashboardManager(bus, this.cm);
       this.db.render();
     }
   }
   ```
4. **Browser console and network tabs**
   - Ensure no syntax errors or 404s.
   - Confirm resources like `/src/core/App.js` and `/src/cards/Bar_Title.js` return HTTP 200.
5. **`#app-root` contents**
   - In browser dev tools, verify `<div id="app-root">` contains `<header>` and `<main>` elements.

Check each item in order to locate where rendering stops. Report the failing step for further guidance.
