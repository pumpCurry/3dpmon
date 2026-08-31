# Material Accounting Contract Hardening III Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Gate 18.9A contract review hold before repository and cutover implementation begins.

**Architecture:** Keep Gate 18.9A pure and fail-closed. The contract module may define shape validators and untrusted normalized evidence, but authority-grade usage, snapshot, and migration proof must not be mintable by arbitrary callers.

**Tech Stack:** JavaScript ES modules, Vitest, existing Printer Core v3 deterministic ID helper.

**Spec:** `docs/develop/printer-core-v3-gate18-9-universal-material-source-accounting.md`

## Global Constraints

- Do not change IndexedDB schema or runtime debit behavior in this task.
- Keep edits scoped to `dashboard_material_accounting_contract.js`, its unit test, and documentation/spec text if needed.
- Use TDD: add failing tests before production changes.
- Preserve existing `@since`; update JS `@version` and `@lastModified`.

---

### Task 1: Authority Evidence Boundary

**Files:**
- Modify: `tests/unit/printer_core_material_accounting_contract.test.js`
- Modify: `3dp_lib/printer_core/dashboard_material_accounting_contract.js`

**Interfaces:**
- Produces: `createSourceSpecificMaterialUsageEvidence(input)` returns normalized untrusted evidence.
- Produces: `evaluateMaterialDebitEligibility(input)` rejects untrusted usage evidence and untrusted print-start snapshots.

- [ ] **Step 1: Write failing tests**

```js
it("public usage evidence factory does not mint debit authority", () => {
  const usage = createSourceSpecificMaterialUsageEvidence(validUsageInput);
  const result = evaluateMaterialDebitEligibility({ mount, materialSource, usageEvidence: usage, printStartSnapshot, continuity });
  expect(result.reasons).toContain("untrusted-usage-evidence");
});

it("plain print-start snapshot does not mint debit authority", () => {
  const result = evaluateMaterialDebitEligibility({ mount, materialSource, usageEvidence: trustedRuntimeUsage, printStartSnapshot: plainSnapshot, continuity });
  expect(result.reasons).toContain("untrusted-print-start-snapshot");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/printer_core_material_accounting_contract.test.js`

- [ ] **Step 3: Implement minimal fail-closed behavior**

Make the exported usage factory return `trusted:false` normalized evidence and stop registering it as debit authority. Add print-start snapshot trust validation that rejects plain snapshots until Gate 18.9B introduces a provider/repository issuer.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/unit/printer_core_material_accounting_contract.test.js`

### Task 2: Binding, Identity, And Cutover Invariants

**Files:**
- Modify: `tests/unit/printer_core_material_accounting_contract.test.js`
- Modify: `3dp_lib/printer_core/dashboard_material_accounting_contract.js`

**Interfaces:**
- Produces: source factory functions throw for missing/invalid authority kinds.
- Produces: direct feed unit identity ignores protocol family.
- Produces: `createSpoolMountRecord(input)` requires stable mount operation identity unless explicit `mountId` is supplied.
- Produces: `validateMaterialAccountingCutover(record)` rejects sealed legacy-to-shadow cutovers.

- [ ] **Step 1: Write failing tests**

```js
expect(() => createMaterialSourceLocator({ kind: "typo" })).toThrow();
expect(() => createMaterialSourceIdentity({ deviceId, unitId, kind: "typo" })).toThrow();
expect(createDirectFeedUnitIdentity({ deviceId, protocolFamily: "k1" })).toEqual(createDirectFeedUnitIdentity({ deviceId, protocolFamily: "k2" }));
expect(validateMaterialAccountingCutover(legacyToShadowSealed)).toMatchObject({ ok: false });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/printer_core_material_accounting_contract.test.js`

- [ ] **Step 3: Implement minimal fixes**

Add strict enum helpers for authority identity factories, remove protocol family from direct-feed identity parts, add `mountOperationId` to generated mount IDs, require source `deviceId`, and validate snapshot-time mount interval coverage.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/unit/printer_core_material_accounting_contract.test.js`

### Task 3: Review And Publish Checkpoint

**Files:**
- Modify: `docs/develop/printer-core-v3-gate18-9-universal-material-source-accounting.md` if contract wording changed.

**Interfaces:**
- Produces: pushed commit for PR #438 review.

- [ ] **Step 1: Run focused tests**

Run: `npx vitest run tests/unit/printer_core_material_accounting_contract.test.js`

- [ ] **Step 2: Run broader tests**

Run: `npx vitest run tests/unit/printer_core_data_schema_v3.test.js tests/unit/printer_core_material_source_observation.test.js tests/unit/printer_core_material_accounting_contract.test.js`

- [ ] **Step 3: Run full verification**

Run: `npx vitest run`

- [ ] **Step 4: Check whitespace**

Run: `git diff --check`

- [ ] **Step 5: Commit and request review**

Commit in English, push PR #438, then ask the reviewer whether the Gate 18.9A contract baseline is now acceptable for repository work.
