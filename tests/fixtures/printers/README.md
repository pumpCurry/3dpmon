# Printer Protocol Fixtures

This directory stores sanitized real-device captures for Printer Core v3.

Each device fixture directory should contain:

- `metadata.json`: model, firmware, attachment, capture source, and redaction notes.
- `*.ndjson`: ordered protocol events exported by `ProtocolRecorder`.
- Optional `notes.md`: operator notes that explain the physical scenario.

Required Gate 0 baseline devices:

- `k1-max/device-a`
- `k1-max/device-b`
- `k2-pro-cfs`
- `ir3v2`

Pending external Gate 0 baseline:

- `k1c-cfs-c`: capture requires the separate K1C test environment because that printer is not reachable from the current development network.

Supported but not live-tested in this fixture set:

- K2 Plus: supported model family, but no local hardware is available for live-device fixture capture.
- K2 Pro without CFS: supported model family variant, but no local hardware is available for live-device fixture capture.

Live K2-family test target:

- K2 Pro Combo with CFS: represented by `k2-pro-cfs`; reported model `F012`.
- The `k2-pro-cfs` fixture was refreshed during Gate 6 with a read-only idle capture
  that observed HTTP `/info`, WebSocket 9999 status, and `boxsInfo` topology.
- Keep the Gate 6 idle baseline at `k2-pro-cfs` stable. Add later physical-state
  captures under scenario subdirectories such as `k2-pro-cfs/scenarios/printing`,
  `k2-pro-cfs/scenarios/paused`, and `k2-pro-cfs/scenarios/cfs-reconnect`.
- For physical-state captures, add operator markers with
  `--marker-at <ms:name[:json-details]>` or `--interactive-markers` so the fixture
  records the observed boundaries such as print start, pause, resume, completion,
  CFS disconnect, CFS reconnect, and material changes.
- Treat `--marker-at` as a planned boundary and `--interactive-markers` as
  operator-observed evidence. If a scheduled marker does not fire inside the
  capture window, the capture is failed by validation instead of silently
  dropping the marker.
- Before accepting physical-state scenario fixtures, run the offline analyzer
  with the marker and inbound payload keys expected for that scenario. Example:

```text
node scripts/analyze_protocol_scenario.mjs --fixture tests/fixtures/printers/k2-pro-cfs/scenarios/printing --require-validation-success --require-marker operator-print-start --require-observed-marker observed-printing --require-payload-key printProgress
```

  Use `--require-observed-marker` for physical state observations that must come
  from stdin/operator input. Required payload keys are checked at the inbound
  semantic payload root, including known `result` / `data` envelopes, not inside
  nested structures such as `boxsInfo.materialBoxs[].state`.
- For the Gate 9 K2 Pro Combo print lifecycle fixture, prefer the built-in
  Analyzer profile:

```text
node scripts/analyze_protocol_scenario.mjs --fixture tests/fixtures/printers/k2-pro-cfs/scenarios/print-lifecycle --profile k2-print-lifecycle --pretty
```

  The profile report includes a reduced `payloadTimeline` for root
  `state` / `deviceState` / `printProgress` / file identity fields so review can
  compare raw protocol transitions with operator-observed markers.
- For the Gate 10 K2 Pro Combo CFS topology fixture, prefer the dedicated
  read-only capture wrapper:

```text
node scripts/capture_k2_cfs_topology.mjs --host <DEVICE_IP> --out tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-topology --duration-ms <observation-window-ms>
```

  It enables `/info`, WS9999, read-only `boxsInfo`, interactive markers,
  minimum event validation, and failed-capture retention with Gate 10 defaults.
- After capture, run the built-in Analyzer profile:

```text
node scripts/analyze_protocol_scenario.mjs --fixture tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-topology --profile k2-cfs-topology --pretty
```

  The profile report includes a reduced `payloadTimeline` for `cfsConnect` and
  summarized `boxsInfo` topology so review can compare physical CFS changes with
  operator-observed markers.
- For K2/CFS print-start fixtures, also run the selected-source guard:

```text
node scripts/analyze_protocol_scenario.mjs --fixture tests/fixtures/printers/k2-pro-cfs/scenarios/<scenario> --profile k2-cfs-print-selection --pretty
```

  This profile requires post-start `boxsInfo.materialBoxs[].materials[].selected`
  evidence for a CFS slot, plus a same-frame `colorMatch` assignment to that
  source.
  A print lifecycle that completes with no selected CFS source is retained as
  negative command evidence, but must not be treated as proof that filament was
  physically fed.
- `scripts/capture_k2_benchy_print.mjs` blocks CFS `opGcodeFile` starts by
  default. Use `--allow-unsafe-opgcodefile-cfs-start` only when intentionally
  reproducing the negative dry-run-like command evidence from Gate 9.
- `scripts/capture_k2_cfs_print_start.mjs` is the Gate 20 dry-run/live
  certification helper for the explicit CFS print-start path. Run it first
  without `--send` to inspect the `colorMatch` -> `multiColorPrint` frames; add
  `--send --confirm-live --confirm-host <host>` only after the operator confirms
  the build plate, G-code path, and CFS slot assignment.

Fixture rules:

- Keep relative event order and relative timestamps.
- Redact IP addresses, MAC addresses, serial numbers, tokens, SSIDs, credentials, hostnames, print IDs, RFID values, and G-code file names.
- Treat wired and wireless MAC addresses as endpoint aliases, not as the physical printer identity.
- Preserve unknown raw fields after redaction.
- Do not include commands that move hardware unless the scenario explicitly requires a hardware smoke capture.
- Marker details must describe observations only. Do not store raw IP addresses, MAC addresses, serial numbers, hostnames, credentials, SSIDs, print IDs, RFID values, or unredacted G-code file names in marker text.
- Marker provenance is set by the capture CLI. Do not rely on user-provided
  `source` values inside marker details.
