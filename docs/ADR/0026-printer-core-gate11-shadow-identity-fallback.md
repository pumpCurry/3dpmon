# ADR-0026 Printer Core Gate 11 Shadow Identity Fallback

## Context

Gate 11 prepares Printer Core v3 identity and session contracts before Data
Schema v3 and command authority. Live shadow may observe a frame before a
strong identity has been established, or while identity evidence is conflicted.

Earlier fallback behavior used a `host:<name>` deviceId when no identity record
was available. That was useful for early dry-run diagnostics, but it can be
misread as treating hostname as a stable physical-device identity.

## Decision

- Keep using `identity.deviceIdSeed` when an identity dry-run record exists.
- Keep using endpoint-first `provisional-shadow:*` IDs while an open identity
  conflict exists.
- When no identity exists, also use the same `provisional-shadow:*` namespace:

```text
provisional-shadow:endpoint:<encoded-dest>
provisional-shadow:host:<encoded-host>
```

- Do not emit new `host:<name>` live shadow device IDs.

## Consequences

Live shadow continues to have deterministic per-session keys for read-only
diagnostics, but the fallback namespace is visibly provisional. This reduces
the chance that future Data Schema v3 or command authority code mistakes a
hostname-only fallback for a canonical device ID.
