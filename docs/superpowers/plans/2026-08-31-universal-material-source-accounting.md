# Universal Material Source Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Gate 18.9 Universal MaterialSource accounting so K1 direct spools and K2/CFS multi-source spools share one source-aware accounting model.

**Architecture:** Gate 18.9 starts with documentation and pure contracts before touching storage, UI, or production debit paths. The design separates Device observation, SpoolMount continuity, debit eligibility, and ledger authority so CFS slots can be monitored and assigned without accidental legacy debit.

**Tech Stack:** JavaScript ES modules, Vitest, existing 3dpmon Printer Core v3 modules, existing ADR/develop docs.

**Spec:** `docs/develop/printer-core-v3-gate18-9-universal-material-source-accounting.md`

## Global Constraints

- First contract commits must not change IndexedDB version.
- First contract commits must not change `hostSpoolMap`, `mountHistory`, `usageHistory`, `dashboard_spool.js`, aggregator debit paths, or UI behavior.
- `SpoolMount continuity != Debit eligibility`.
- Physical CFS commands must not update SpoolMount.
- Device observations must not update SpoolMount or ledger authority.
- Multi-source total-only usage must become pending/unattributed, never guessed into per-source debit.
- Existing K1/K1 Max/IR3 single spool behavior must remain unchanged until UI cutover.
- JavaScript file headers must follow `AGENTS.md` `@version`, `@since`, and `@lastModified` rules.

---

### Task 1: Gate 18.9 Documentation Baseline

**Files:**
- Create: `docs/ADR/0036-printer-core-gate18-9-universal-material-source-accounting.md`
- Create: `docs/develop/printer-core-v3-gate18-9-universal-material-source-accounting.md`
- Modify: `docs/develop/printer-core-v3-open-work.md`
- Create: `docs/superpowers/plans/2026-08-31-universal-material-source-accounting.md`

**Interfaces:**
- Consumes: ADR-0004, ADR-0007, ADR-0034, ADR-0035, reviewer Gate 18.9 decision.
- Produces: ADR-0036 and Gate 18.9 implementation spec used by all later tasks.

- [ ] **Step 1: Add ADR-0036**

Write the ADR with these sections:

```markdown
# ADR-0036: Printer Core Gate 18.9 Universal Material Source Accounting

## Status
Accepted for Gate 18.9 design and staged implementation.

## Decision
Gate 18.9 adopts:
Device -> FilamentUnit -> MaterialSource -> SpoolMount

SpoolMount continuity and debit eligibility are separate.
```

- [ ] **Step 2: Add the Gate 18.9 implementation spec**

Document Gate 18.9A/B/C, contract surfaces, identity rules, mount continuity, remaining provenance, legacy cutover, and tests.

- [ ] **Step 3: Update open-work**

Add Gate 18.9 to the gate matrix and add a dedicated section describing Universal MaterialSource accounting as the next active area.

- [ ] **Step 4: Verify docs diff**

Run:

```bash
git diff --check
```

Expected: PASS with no whitespace errors.

- [ ] **Step 5: Commit**

```bash
git add docs/ADR/0036-printer-core-gate18-9-universal-material-source-accounting.md docs/develop/printer-core-v3-gate18-9-universal-material-source-accounting.md docs/develop/printer-core-v3-open-work.md docs/superpowers/plans/2026-08-31-universal-material-source-accounting.md
git commit -m "Document universal material source accounting"
```

### Task 2: Pure Universal Material Accounting Contract

**Files:**
- Create: `tests/unit/printer_core_material_accounting_contract.test.js`
- Create: `3dp_lib/printer_core/dashboard_material_accounting_contract.js`

**Interfaces:**
- Consumes: ADR-0036 terms and existing `createPrinterCoreV3DeterministicId(namespace, parts)`.
- Produces:
  - `FILAMENT_UNIT_KIND`
  - `MATERIAL_SOURCE_KIND`
  - `MATERIAL_IDENTITY_STRENGTH`
  - `SPOOL_MOUNT_STATUS`
  - `SPOOL_MOUNT_VERIFICATION`
  - `MATERIAL_ACCOUNTING_BACKEND`
  - `DEBIT_ELIGIBILITY_STATUS`
  - `createFilamentUnitRecord(input)`
  - `createMaterialSourceRecord(input)`
  - `createSpoolMountRecord(input)`
  - `createMaterialAccountingCutoverRecord(input)`
  - `createMaterialSourceAccountingView(input)`
  - `validateFilamentUnit(record)`
  - `validateMaterialSource(record)`
  - `validateSpoolMount(record)`
  - `validateMaterialAccountingCutover(record)`
  - `createDirectFeedUnitIdentity(input)`
  - `createMaterialSourceIdentity(input)`
  - `createMaterialSourceLocator(input)`
  - `evaluateMaterialDebitEligibility(input)`

- [ ] **Step 1: Write failing contract tests**

Add tests for:

```js
it("represents K1 direct spool as a one-source universal topology", () => {});
it("represents K2 external plus four CFS units as seventeen sources", () => {});
it("keeps material source identity separate from display locator", () => {});
it("allows provisional manual mount but blocks debit until fresh continuity is proven", () => {});
it("blocks debit on explicit physical discontinuity without closing the mount", () => {});
it("does not treat RFID missing as a hard blocker but blocks RFID mismatch", () => {});
it("validates cutover records that seal legacy accounting intervals", () => {});
it("creates an accounting view that preserves confirmed-unused and unknown separately", () => {});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npx vitest run tests/unit/printer_core_material_accounting_contract.test.js
```

Expected: FAIL because `dashboard_material_accounting_contract.js` does not exist.

- [ ] **Step 3: Implement the pure contract module**

Implement factories as pure functions that clone/freeze returned records. Import only:

```js
import { createPrinterCoreV3DeterministicId } from "./dashboard_data_schema_v3.js";
```

Do not import storage, spool, DOM, or UI modules.

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
npx vitest run tests/unit/printer_core_material_accounting_contract.test.js
```

Expected: PASS.

- [ ] **Step 5: Run adjacent tests**

Run:

```bash
npx vitest run tests/unit/printer_core_data_schema_v3.test.js tests/unit/printer_core_material_source_observation.test.js tests/unit/printer_core_material_accounting_contract.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add 3dp_lib/printer_core/dashboard_material_accounting_contract.js tests/unit/printer_core_material_accounting_contract.test.js
git commit -m "Add universal material accounting contracts"
```

### Task 3: Review Request Checkpoint

**Files:**
- No repository file changes required.

**Interfaces:**
- Consumes: Task 1 and Task 2 commits.
- Produces: reviewer feedback before storage/UI/ledger behavior changes.

- [ ] **Step 1: Run full unit suite**

Run:

```bash
npx vitest run
```

Expected: PASS.

- [ ] **Step 2: Run whitespace check**

Run:

```bash
git diff --check HEAD~2
```

Expected: PASS.

- [ ] **Step 3: Push branch**

```bash
git push -u origin codex/printer-core-v3-gate18-9-universal-material-source
```

- [ ] **Step 4: Request review**

Send this review scope:

```text
Gate 18.9A contract review
Base: main f6b8f6ce
Head: <current head>
Scope:
- ADR-0036 Universal MaterialSource accounting
- Gate 18.9 implementation spec
- pure FilamentUnit / MaterialSource / SpoolMount / cutover / debit eligibility contracts
- no storage, UI, ledger, or legacy debit behavior changes
Expected:
- all current v2 behavior unchanged
- no IndexedDB schema change
- no hostSpoolMap write change
- no debit path change
```
