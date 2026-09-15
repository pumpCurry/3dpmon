# Gate 19 K2/CFS Production Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate 19で実機認証されたK2 Pro F012/CFSの1A・1Bに限り、押出し・引戻しをsend-time fail-closed、単発送信、bounded終端確認付きでproduction利用可能にする。

**Architecture:** 実機証跡とproduction policyをmodule-owned immutable registryへ固定し、transport plan生成時にprinter/model/firmware/CFS台数/source/command preconditionを照合する。送信時は同一session/generation/sequenceのfreshなprinter idle、feedState、raw error証跡を必須にし、送信は一度だけ、以後はread-only runtime観測だけをboundedに待ってterminal conditionを確認する。

**Tech Stack:** JavaScript ES modules、Vitest、Electron renderer、Printer Core v3 normalized/live-shadow、Creality K2 WS9999 transport。

**Spec:** `docs/develop/printer-core-v3-gate19-cfs-control-spec-investigation.md`

## Global Constraints

- 認証scopeは `creality-k2 / F012 / firmware 1.0.0 / CFS 1台 / box 1 / 1A・1B` に限定する。
- production commandは `cfs-load` と `cfs-unload` のみ。`cfs-slot-select`、`cfs-feed`、`cfs-retract` は無効のままにする。
- `cfs-load` はselected sourceが0件の場合だけ許可し、target already selectedを含めてそれ以外は拒否する。
- `cfs-unload` はtargetが唯一のselected sourceの場合だけ許可する。
- printer idle、`feedState === 0`、raw `err.errcode === 0 && err.key === 0` を同一session/generationのfresh status evidenceとして要求する。
- physical commandは一度だけ送信し、timeout後もblind retryしない。
- registryを開いてもUI設定はdefault disabledのままにし、Gate 19.5 LIVE activationと分離する。
- 既存のPR #440 freeze head `597dfed8e73ccefcf9d8050ca7c7aebfb127a610` は変更しない。

---

### Task 1: Certification Policy And Scope

**Files:**
- Modify: `3dp_lib/printer_core/dashboard_k2_cfs_command_transport.js`
- Modify: `tests/unit/printer_core_k2_cfs_command_transport.test.js`
- Modify: `tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-slot-control-live/certification-summary.json`
- Modify: `tests/unit/k2_cfs_slot_control_certification_fixture.test.js`

**Interfaces:**
- Consumes: `validateK2CfsSlotControlCertificationEvidence(evidence, commandKind, scope)`
- Produces: source/unit/attachment/command policyを検証するimmutable registry entryとvalidator。

- [x] **Step 1: Write failing scope tests**

  `1C/1D`、CFS 2台、別attachment、別firmware、未認証preconditionをproduction planが拒否し、1A/1Bだけを受理するテストを追加する。

- [x] **Step 2: Run RED tests**

  Run: `npx vitest run tests/unit/printer_core_k2_cfs_command_transport.test.js tests/unit/k2_cfs_slot_control_certification_fixture.test.js`

- [x] **Step 3: Implement policy schema and validation**

  Evidenceへ `scope.cfsUnitCount`、`scope.certifiedSources`、`commandPolicies`、`safety`、`review` を追加し、request sourceから得たbox/slotとruntime scopeを完全照合する。

- [x] **Step 4: Run GREEN tests**

  Run: `npx vitest run tests/unit/printer_core_k2_cfs_command_transport.test.js tests/unit/k2_cfs_slot_control_certification_fixture.test.js`

### Task 2: Command-Specific Selection Authority

**Files:**
- Modify: `3dp_lib/printer_core/dashboard_command_authority.js`
- Modify: `tests/unit/printer_core_command_authority.test.js`

**Interfaces:**
- Consumes: send-time `materialTopology.sources` and `request.commandKind`。
- Produces: `cfs-load` no-selected policyと`cfs-unload` target-unique-selected policy。

- [x] **Step 1: Write failing selection tests**

  load/no-selected allow、load/other-selected reject、load/target-selected reject、unload/target-unique allow、unload/no-selected/other/multiple rejectを追加する。

- [x] **Step 2: Run RED tests**

  Run: `npx vitest run tests/unit/printer_core_command_authority.test.js`

- [x] **Step 3: Split the validator by command kind**

  loaded/selection completenessの共通検査は維持し、terminal preconditionだけをcommand policyで分岐する。

- [x] **Step 4: Run GREEN tests**

  Run: `npx vitest run tests/unit/printer_core_command_authority.test.js`

### Task 3: Fresh Physical Safety Observation

**Files:**
- Modify: `3dp_lib/printer_core/dashboard_k2_printer_activity.js`
- Modify: `3dp_lib/printer_core/dashboard_live_shadow.js`
- Modify: `3dp_lib/dashboard_panel_init.js`
- Modify: `3dp_lib/printer_core/dashboard_command_authority.js`
- Modify: `tests/unit/printer_core_k2_printer_activity.test.js`
- Modify: `tests/unit/printer_core_live_shadow.test.js`
- Modify: `tests/unit/printer_core_command_authority.test.js`
- Modify: `tests/unit/dashboard_panel_init_cfs_control_hook.test.js`

**Interfaces:**
- Produces: `cfsPhysicalSafetyObservation` with printer idle, feedState, raw error, session, generation, sequence, timestamps and freshness.

- [x] **Step 1: Write failing evidence tests**

  feedState/error missing・invalid・nonzero、session/generation/expiry/sequence missing・mismatch、boxsInfo-only延命、reconnect跨ぎをすべてrejectするテストを追加する。

- [x] **Step 2: Run RED tests**

  Run: `npx vitest run tests/unit/printer_core_k2_printer_activity.test.js tests/unit/printer_core_live_shadow.test.js tests/unit/printer_core_command_authority.test.js tests/unit/dashboard_panel_init_cfs_control_hook.test.js`

- [x] **Step 3: Implement one observation family**

  K2 status frameからのみfeedStateとraw errを取り込み、printer idle observationと同じ5秒TTL、session、generation、ordered sequenceへ束縛する。CFS commandではlegacy idle fallbackを廃止する。

- [x] **Step 4: Run GREEN tests**

  Run: `npx vitest run tests/unit/printer_core_k2_printer_activity.test.js tests/unit/printer_core_live_shadow.test.js tests/unit/printer_core_command_authority.test.js tests/unit/dashboard_panel_init_cfs_control_hook.test.js`

### Task 4: Bounded Post-Command Confirmation

**Files:**
- Modify: `3dp_lib/printer_core/dashboard_cfs_command_integration.js`
- Modify: `3dp_lib/dashboard_panel_init.js`
- Modify: `3dp_lib/printer_core/dashboard_command_authority.js`
- Modify: `tests/unit/printer_core_cfs_command_integration.test.js`
- Modify: `tests/unit/dashboard_panel_init_cfs_control_hook.test.js`
- Modify: `tests/unit/printer_core_command_authority.test.js`

**Interfaces:**
- Consumes: single transport submission and fresh shadow observations.
- Produces: load terminal=`target selected + feedState 0 + error clear`; unload terminal=`selected none + feedState 0 + error clear`.

- [x] **Step 1: Write failing confirmation tests**

  即時未完了から後続観測で成功、timeoutでunresolved latch、途中error/feed busy、session/generation change、command送信回数1を固定する。

- [x] **Step 2: Run RED tests**

  Run: `npx vitest run tests/unit/printer_core_cfs_command_integration.test.js tests/unit/dashboard_panel_init_cfs_control_hook.test.js tests/unit/printer_core_command_authority.test.js`

- [x] **Step 3: Implement bounded read-only observation**

  `observeState`だけを一定間隔で反復し、transportを再呼び出さない。terminal condition成立時だけtrusted transition proofを返し、timeoutは未確認結果としてrecovery latchへ残す。

- [x] **Step 4: Run GREEN tests**

  Run: `npx vitest run tests/unit/printer_core_cfs_command_integration.test.js tests/unit/dashboard_panel_init_cfs_control_hook.test.js tests/unit/printer_core_command_authority.test.js`

  Result: 3 files / 102 tests PASS、targeted ESLint PASS、`git diff --check` PASS。

### Task 5: Activation Registry And Documentation

**Files:**
- Modify: `3dp_lib/printer_core/dashboard_k2_cfs_command_transport.js`
- Modify: `3dp_lib/dashboard_panel_init.js`
- Modify: `docs/develop/printer-core-v3-gate19-cfs-control-spec-investigation.md`
- Modify: `docs/develop/printer-core-v3-open-work.md`
- Test: `tests/unit/printer_core_k2_cfs_command_transport.test.js`
- Test: `tests/unit/dashboard_panel_init_cfs_control_hook.test.js`

**Interfaces:**
- Produces: reviewed evidenceから生成したmodule-owned immutable registry entry。UIは明示enable無しではread-only。

- [ ] **Step 1: Write failing registry activation tests**

  exact scope/evidenceではproduction planを生成し、保存設定だけ、別source、別firmware、未許可actionでは生成しないことを固定する。

- [ ] **Step 2: Run RED tests**

  Run: `npx vitest run tests/unit/printer_core_k2_cfs_command_transport.test.js tests/unit/dashboard_panel_init_cfs_control_hook.test.js`

- [ ] **Step 3: Register reviewed evidence and update docs**

  fixture digest、reviewed head、review decisionを含むentryを登録し、stale comment/TODOとGate19のCLOSED scopeを更新する。

- [ ] **Step 4: Run GREEN and full verification**

  Run: `npx vitest run`

  Run: `npm run lint -- --quiet`

  Run: `npm run test:e2e`

  Run: `git diff --check`

### Task 6: Review And Canary Handoff

**Files:**
- Modify only when review findings require changes.

**Interfaces:**
- Produces: Gate19 production activation review cutoff and a minimal read-only/canary checklist.

- [ ] **Step 1: Commit and push the activation cut**

  Use an English commit message and update PR #442.

- [ ] **Step 2: Request formal review**

  Report P1-1 through P1-5 closure evidence, all verification results, and explicit UI default-disabled status.

- [ ] **Step 3: Run minimal read-only confirmation**

  Confirm current F012 reports `feedState=0`, `err.errcode=0`, `err.key=0`, fresh idle evidence, and scope 1A/1B before any canary.

- [ ] **Step 4: Stop before physical canary unless separately authorized**

  Physical command execution requires the operator to reconfirm chamber/mechanical safety at that time.
