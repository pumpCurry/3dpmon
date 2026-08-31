# Gate 18.9G Trusted Attribution Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep result-set completeness fail-closed from public callers, and document that a future provider/session-bound issuer is required before source-specific absence can become trusted.

**Architecture:** Keep the public print binding repository shadow-only. Preserve the private trusted evidence machinery for future internal composition, but make the public registry a validation/fail-closed facade. A caller-provided source set is evidence shape, not an issuer. `recordUsageAttribution()` may only mark missing sources as `confirmed-unused` when a future module-owned issuer supplies trusted evidence; until then, absence stays `unknown`.

**Tech Stack:** JavaScript ES modules, Vitest, existing Printer Core v3 material accounting contracts.

**Spec:** `docs/ADR/0036-printer-core-gate18-9-universal-material-source-accounting.md` and `docs/develop/printer-core-v3-gate18-9-universal-material-source-accounting.md`

## Global Constraints

- Public callers must not mint trusted print-start snapshots, trusted usage evidence, or trusted result-set completeness evidence by hand.
- Public callers must not convert source coverage into trusted result-set completeness.
- Future trusted result-set completeness must be scoped to `deviceId`, `printJobId`, `printPlanId`, provider/session/generation, result-set revision, expected source/tool digest, observed result digest, and the exact source set observed for that job.
- Future trusted result-set completeness may only convert absent planned sources to `confirmed-unused`; until that issuer exists, public caller coverage leaves absent planned sources as `unknown`.
- Restart/re-hydration must not restore orphaned or mismatched print binding records to authority arrays.
- GitHub commit/PR text must be English; user-facing summaries must be Japanese.

---

### Task 1: Contract-Owned Result-Set Completeness Issuer

**Files:**
- Modify: `3dp_lib/printer_core/dashboard_material_accounting_contract.js`
- Test: `tests/unit/printer_core_material_accounting_contract.test.js`

**Interfaces:**
- Produces: `createMaterialResultSetCompletenessEvidence(input)` returning a frozen untrusted shape.
- Produces: `createTrustedMaterialResultSetCompletenessRegistry(options)` returning `{ certifyCompleteResultSet(input), validate(evidence, scope) }`, where public `certifyCompleteResultSet()` fails closed until an internal issuer exists.
- Consumes: existing private `validateTrustedResultSetCompletenessEvidence(evidence, scope)` through repository dependency injection only.

- [x] **Step 1: Write the failing test**

```js
it("public result-set registryはtrusted issuer未接続ではcomplete evidenceを発行しない", () => {
  const registry = createTrustedMaterialResultSetCompletenessRegistry();
  const forged = createMaterialResultSetCompletenessEvidence({
    deviceId: "serial:k2pro-69e7",
    printJobId: "job:4c",
    printPlanId: "plan:4c",
    materialSourceIds: ["source:1a", "source:1b"],
    observedSourceIds: ["source:1a", "source:1b"],
    observedAt: "2026-08-31T06:00:00.000Z",
  });
  const blocked = registry.certifyCompleteResultSet({
    deviceId: "serial:k2pro-69e7",
    printJobId: "job:4c",
    printPlanId: "plan:4c",
    materialSourceIds: ["source:1a", "source:1b"],
    observedSourceIds: ["source:1b", "source:1a"],
    observedAt: "2026-08-31T06:00:00.000Z",
    source: "trusted-source-specific-result-registry",
  });

  expect(registry.validate(forged, { deviceId: "serial:k2pro-69e7", printJobId: "job:4c", printPlanId: "plan:4c" })).toBe(false);
  expect(blocked.reasons).toEqual(["trusted-result-set-issuer-unavailable"]);
  expect(registry.validate(blocked, { deviceId: "serial:k2pro-69e7", printJobId: "job:4c", printPlanId: "plan:4c" })).toBe(false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/printer_core_material_accounting_contract.test.js`
Expected: FAIL because the registry/factory exports are not implemented.

- [x] **Step 3: Write minimal implementation**

Add public untrusted shape factory and keep the private trusted issuer unavailable to public callers. Public `certifyCompleteResultSet()` verifies malformed/incomplete source coverage for diagnostics, then returns `trusted-result-set-issuer-unavailable` for otherwise complete caller-supplied coverage.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/printer_core_material_accounting_contract.test.js`
Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

```bash
git add 3dp_lib/printer_core/dashboard_material_accounting_contract.js tests/unit/printer_core_material_accounting_contract.test.js docs/superpowers/plans/2026-08-31-gate18-9g-trusted-attribution-authority.md
git commit -m "Add trusted material result-set registry"
```

### Task 2: Repository Keeps Public Registry Evidence Non-Authoritative

**Files:**
- Modify: `3dp_lib/printer_core/dashboard_material_accounting_print_binding_repository.js`
- Test: `tests/unit/printer_core_material_accounting_print_binding.test.js`
- Modify: `docs/ADR/0036-printer-core-gate18-9-universal-material-source-accounting.md`
- Modify: `docs/develop/printer-core-v3-gate18-9-universal-material-source-accounting.md`

**Interfaces:**
- Consumes: `resultSetCompletenessEvidence` from Task 1.
- Produces: `recordUsageAttribution()` result with absent planned source segments left as `unknown` when caller only has public registry blocked evidence.

- [x] **Step 1: Write the failing test**

```js
it("public registryのblocked complete evidenceでは未出現sourceをunknownに残す", () => {
  const registry = createTrustedMaterialResultSetCompletenessRegistry();
  const repository = createMaterialAccountingPrintBindingRepository();
  repository.recordPrintStartBindings({ printPlan, printJobId, materialSources, spoolMounts, capturedAt, bindingOperationId });
  const evidence = registry.certifyCompleteResultSet({
    deviceId,
    printJobId,
    printPlanId: printPlan.printPlanId,
    materialSourceIds: materialSources.map((source) => source.materialSourceId),
    observedSourceIds: materialSources.map((source) => source.materialSourceId),
    observedAt: completedAt,
    source: "trusted-source-specific-result-registry",
  });

  const result = repository.recordUsageAttribution({
    printPlan,
    printJobId,
    completedAt,
    attributionOperationId,
    resultSetCompleteness: "complete",
    resultSetCompletenessEvidence: evidence,
    materialUsages: [{ materialSourceId: materialSources[0].materialSourceId, usedLengthMm: 3210 }],
  });

  expect(result.segments.find((segment) => segment.materialSourceId === materialSources[1].materialSourceId).usageState).toBe("unknown");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/printer_core_material_accounting_print_binding.test.js`
Expected: FAIL until repository scope validation includes the source set.

- [x] **Step 3: Write minimal implementation**

Pass planned source IDs into the validator scope, but rely only on module-owned validator success. Public blocked evidence must not mark absent sources as `confirmed-unused`. Keep generated ledger events shadow-only and keep all spool remaining writes disabled.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/printer_core_material_accounting_print_binding.test.js`
Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

```bash
git add 3dp_lib/printer_core/dashboard_material_accounting_print_binding_repository.js tests/unit/printer_core_material_accounting_print_binding.test.js docs/ADR/0036-printer-core-gate18-9-universal-material-source-accounting.md docs/develop/printer-core-v3-gate18-9-universal-material-source-accounting.md
git commit -m "Use trusted result-set evidence for shadow attribution"
```

### Task 3: Review And Verification

**Files:**
- Modify: `docs/develop/printer-core-v3-open-work.md`

**Interfaces:**
- Produces: Reviewer request describing Gate 18.9G scope and explicit non-goals.

- [x] **Step 1: Run targeted tests**

Run: `npx vitest run tests/unit/printer_core_material_accounting_contract.test.js tests/unit/printer_core_material_accounting_print_binding.test.js tests/unit/dashboard_filament_manager_cfs_sources.test.js tests/unit/printer_core_material_topology_view_model.test.js`
Expected: PASS.

- [x] **Step 2: Run full verification**

Run: `git diff --check`
Expected: no output.

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 3: Push and request review**

Push the branch and ask the reviewer whether Gate 18.9G can close, specifically calling out that production debit remains disabled.
