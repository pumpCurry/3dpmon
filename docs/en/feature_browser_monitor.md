# Monitoring Clarity Printers from Your Browser

This page explains how to monitor Clarity series 3D printers using 3dpmon directly in your browser.

## Supported Models
- Clarity K1 / K1C / K1A / K1 Max

## Basic Steps
1. Open `3dp_monitor.html` in your browser.
2. Enter the printer's IP address in the field at the top right and click **Connect**.
3. Once connected, the title bar shows the hostname and status while camera and status information are retrieved.

## Troubleshooting
- Verify the IP address and confirm that your computer and printer are on the same network.
- The WebSocket port is normally `9999`. If you changed it, update the setting in `dashboard_connection.js`.
- If the connection drops, simply click **Connect** again.

Browser monitoring lets you check the printer from anywhere without special software.
