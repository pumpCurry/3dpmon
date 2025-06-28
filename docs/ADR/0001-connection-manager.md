# ADR-0001 ConnectionManager design choice

We introduce an ES6 class `ConnectionManager` to manage multiple WebSocket connections.
This ADR records the reason behind choosing a custom implementation instead of relying on existing libraries.

## Status
Accepted

## Context
The dashboard must handle multiple printers and reconnect automatically when the connection drops. Most lightweight libraries provide either minimal reconnection or heavy feature sets. We required a small footprint and tight integration with our EventBus.

## Decision
Implement our own `ConnectionManager` that keeps a registry of connections and forwards events through the EventBus. It handles exponential backoff up to 60 seconds.

## Consequences
This class becomes the core communication layer in v2. Unit tests ensure basic behavior, and the mock WebSocket server helps development.
