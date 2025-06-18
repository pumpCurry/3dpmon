# Dashboard Usage

This guide explains how to operate the current 3dpmon dashboard.

## Connecting to the Printer
1. Start the HTTP server as described in the README and open `http://localhost:8000/3dp_monitor.html`.
2. Enter the printer's IP address in the upper right field and press **Connect**.
3. The port is automatically selected for supported K1/K2 models. A connection message appears once the WebSocket is established.

## Basic Operation
- The **Monitor** card shows the camera stream and print controls. Use the buttons to pause or stop printing and to toggle fans or the LED.
- Temperature controls below the camera allow adjustment of nozzle and bed targets.
- Print progress, nozzle position and remaining time are updated in real time.

## File Uploads
1. Switch to the **Print History** card and open the **Files** tab.
2. Drag-and-drop a G-code file or click **Upload** to transfer it to the printer.
3. Uploaded files can be started directly from the file list.

## Saving Settings
All settings and print history are stored in the browser's local storage. They are preserved even after closing the page.
