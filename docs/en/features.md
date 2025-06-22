# Dashboard Features

This document describes each component of the 3dpmon dashboard and
highlights what can be controlled or managed from each section.

## Header
Fields for entering the printer's IP address are provided along with
buttons to connect or disconnect. Connection status is shown in the
title area and reconnection attempts are handled automatically.

## Monitor
Displays the live camera stream and current status indicators. Buttons
are available to pause, resume or stop the active job. Nozzle or bed
temperature adjustments can also be made here.

## Head Preview
Illustrates the print head position in real time, making it easy to
check movements without opening the printer door.

## Filament Preview
Shows the remaining filament on a 3D spool diagram. The amount is
updated automatically after each print and warns when running low.

## Status
Lists progress, elapsed time and remaining time along with estimated
filament usage for the current job.

## Operation Panel
Provides controls for model/case/auxiliary fans, LED lighting and a set
of print control buttons. Sliders allow adjusting feedrate, flow rate
and target temperatures.

## Temperature Monitor
Live chart showing nozzle and bed temperatures with historical graphs.

## Machine Info
Lists axis limits, firmware versions and other hardware details.

## Log
Shows received and sent messages as well as notifications. Logs can be
copied for troubleshooting.

## Current Print
Summarizes the file currently printing together with the selected
filament spool information.

## Print History
Provides a table of completed jobs with thumbnails and links to any
recorded videos.

## File List
Allows uploading, deleting and starting G-code files. Files can be
selected directly from this list when launching a job.

## Settings
Holds storage options, notification toggles, filament spool management
and a command palette for additional commands.

### Storage Settings
Manage localStorage data, import/export configuration and clear cached
history information.

### Notification Settings
Enable sound effects or voice announcements and configure warning
thresholds for abnormal temperatures.

### Filament Spool
Register, edit or delete filament spools. Remaining length is tracked
automatically and low inventory warnings are displayed.

### Command Palette
Lists quick commands such as auto home, bed leveling, firmware upgrade,
factory reset and raw JSON send. Custom G-code can also be issued from
here.
