# Gate 18.9H SpoolMount Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Gate 18.9H foundation that lets 3DPmon record operator-managed spool mounts per Universal MaterialSource without changing legacy K1 spool behavior, physical CFS commands, ItemKeeper, or remaining debit.

**Architecture:** Gate 18.9H is split into H-1a and H-1b. H-1a adds pure store normalization and a pure service transaction boundary with an injected durable writer contract. H-1b connects the same contract to `monitorData`, shared storage, and IndexedDB CAS.

**Tech Stack:** JavaScript ES modules, Vitest, existing Printer Core v3 deterministic IDs, existing Universal `SpoolMountRepository`.

**Spec:** `docs/develop/printer-core-v3-gate18-9h-spool-mount-authority.md`

## Global Constraints

- H-1a must not modify `monitorData`, `dashboard_storage.js`, `dashboard_storage_idb.js`, UI, physical command code, ItemKeeper, legacy `hostSpoolMap`, legacy `usageHistory`, or managed spool remaining.
- H-1a production success must require injected durable writer result `{ ok: true, casApplied: true }`.
- H-1a must reject legacy `hostSpoolMap` cross-backend spool occupancy.
- H-1a must not persist generic `operationsById`; operation idempotency is reconstructed from `spoolMounts[]` and `events[]`.
- H-1a must keep device observation, RFID, selected state, stale providers, and physical CFS command results out of mount authority writes.
- H-1b is the first task allowed to add `monitorData.materialAccountingSpoolMountStore` and IndexedDB durable persistence.

---

### Task 1: H-1a Store Normalization

**Files:**
- Create: `3dp_lib/printer_core/dashboard_material_accounting_mount_store.js`
- Test: `tests/unit/printer_core_material_accounting_mount_store.test.js`

**Interfaces:**
- Consumes: `createSpoolMountRepository(initialMounts)`, `validateSpoolMount(record)`, `createPrinterCoreV3DeterministicId(namespace, parts)`, `stableStringifyPrinterCoreV3Value(value)`.
- Produces:
  - `MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_SCHEMA_VERSION`
  - `MATERIAL_ACCOUNTING_SPOOL_MOUNT_STORE_AUTHORITY`
  - `createEmptyMaterialAccountingSpoolMountStore(input)`
  - `normalizeStoredMaterialAccountingSpoolMountStore(stored)`
  - `createMaterialAccountingSpoolMountStoreDigest(store)`
  - `createMaterialAccountingSpoolMountStoreSnapshot(store)`

- [ ] **Step 1: Write the failing normalization test**

```js
it("空storeをproduction mount authority shapeへ正規化する", () => {
  const store = normalizeStoredMaterialAccountingSpoolMountStore(null);
  expect(store).toMatchObject({
    schemaVersion: 1,
    authority: "material-accounting-spool-mount-store",
    storeRevision: 0,
    spoolMounts: [],
    events: [],
    conflicts: [],
    retainedUnsupportedEntries: [],
    invariants: {
      operatorManaged: true,
      deviceObservationWrites: false,
      physicalCommandWrites: false,
      legacyHostSpoolMapWrites: false,
      legacyUsageHistoryWrites: false,
      legacySpoolRemainingWrites: false,
      filamentLedgerWrites: false,
      printBindingWrites: false,
    },
  });
  expect(store.storeDigest).toMatch(/^fnv1a128:/);
});
```

- [ ] **Step 2: Run the new store test and confirm RED**

Run: `npx vitest run tests/unit/printer_core_material_accounting_mount_store.test.js`

Expected: FAIL because `dashboard_material_accounting_mount_store.js` does not exist.

- [ ] **Step 3: Implement minimal store constants, clone/freeze helpers, stable digest, and empty normalization**

Implementation must calculate `storeDigest` from canonical content excluding the existing `storeDigest` field.

- [ ] **Step 4: Run the store test and confirm GREEN**

Run: `npx vitest run tests/unit/printer_core_material_accounting_mount_store.test.js`

Expected: PASS.

- [ ] **Step 5: Add failing quarantine and conflict tests**

```js
it("invalid recordはactive authorityから外しretainedUnsupportedEntriesへ隔離する", () => {
  const store = normalizeStoredMaterialAccountingSpoolMountStore({
    spoolMounts: [{ mountId: "", materialSourceId: "source:1a" }],
  });
  expect(store.spoolMounts).toEqual([]);
  expect(store.retainedUnsupportedEntries).toEqual([
    expect.objectContaining({ kind: "spoolMount", reason: expect.stringContaining("invalid") }),
  ]);
});

it("同時open conflictはfirst-winせず衝突集合をactive authorityから外す", () => {
  const store = normalizeStoredMaterialAccountingSpoolMountStore({
    spoolMounts: [
      createMount({ mountOperationId: "op:a", spoolId: "spool:a" }),
      createMount({ mountOperationId: "op:b", spoolId: "spool:b" }),
    ],
  });
  expect(store.spoolMounts).toEqual([]);
  expect(store.conflicts).toEqual([
    expect.objectContaining({ type: "source-open-mount-conflict" }),
  ]);
});
```

- [ ] **Step 6: Implement record restoration through `SpoolMountRepository`**

Implementation must validate all candidates, load them into the pure repository, and if any conflict occurs remove every involved mount from active `spoolMounts[]` and record the conflict.

- [ ] **Step 7: Run targeted tests**

Run: `npx vitest run tests/unit/printer_core_material_accounting_mount_store.test.js`

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add 3dp_lib/printer_core/dashboard_material_accounting_mount_store.js tests/unit/printer_core_material_accounting_mount_store.test.js
git commit -m "Add material accounting spool mount store"
```

---

### Task 2: H-1a Operator Mount Service

**Files:**
- Create: `3dp_lib/printer_core/dashboard_material_accounting_mount_service.js`
- Test: `tests/unit/printer_core_material_accounting_mount_service.test.js`

**Interfaces:**
- Consumes: Task 1 store functions and existing `createSpoolMountRecord`.
- Produces:
  - `createMaterialAccountingSpoolMountService(input)`
  - service method `operatorMountSource(input)`
  - service method `operatorUnmountSource(input)`
  - service method `operatorReplaceSourceMount(input)`

- [ ] **Step 1: Write failing mount success and CAS failure tests**

```js
it("operatorMountSourceはCAS成功後だけmountを返す", async () => {
  const persist = vi.fn(async () => ({ ok: true, casApplied: true }));
  const service = createMaterialAccountingSpoolMountService({
    store: normalizeStoredMaterialAccountingSpoolMountStore(null),
    managedSpools: [{ id: "spool:a", deleted: false }],
    legacyHostSpoolMap: {},
    persist,
    now: () => "2026-09-01T00:00:00.000Z",
  });
  const result = await service.operatorMountSource({
    operatorActionId: "action:1",
    expectedDeviceId: "device:k2",
    materialSource: createSource({ deviceId: "device:k2", materialSourceId: "source:1a" }),
    spoolId: "spool:a",
    actor: "operator",
  });
  expect(result).toMatchObject({ ok: true, action: "mount" });
  expect(result.store.spoolMounts).toHaveLength(1);
  expect(persist).toHaveBeenCalledWith(expect.objectContaining({
    baseStoreDigest: expect.any(String),
    nextStore: expect.objectContaining({ spoolMounts: expect.any(Array) }),
  }));
});

it("casApplied falseならmountを成功扱いにしない", async () => {
  const service = createMaterialAccountingSpoolMountService({
    store: normalizeStoredMaterialAccountingSpoolMountStore(null),
    managedSpools: [{ id: "spool:a", deleted: false }],
    legacyHostSpoolMap: {},
    persist: async () => ({ ok: true, casApplied: false }),
    now: () => "2026-09-01T00:00:00.000Z",
  });
  const result = await service.operatorMountSource({
    operatorActionId: "action:1",
    expectedDeviceId: "device:k2",
    materialSource: createSource({ deviceId: "device:k2", materialSourceId: "source:1a" }),
    spoolId: "spool:a",
    actor: "operator",
  });
  expect(result).toMatchObject({ ok: false, reason: "durable-cas-not-applied" });
  expect(result.store.spoolMounts).toEqual([]);
});
```

- [ ] **Step 2: Run service tests and confirm RED**

Run: `npx vitest run tests/unit/printer_core_material_accounting_mount_service.test.js`

Expected: FAIL because service module does not exist.

- [ ] **Step 3: Implement service constructor and `operatorMountSource`**

Implementation must reject unknown identity, wrong device, missing/deleted spool, existing Universal conflict, and legacy `hostSpoolMap` occupancy before calling `persist`.

- [ ] **Step 4: Run service tests and confirm GREEN**

Run: `npx vitest run tests/unit/printer_core_material_accounting_mount_service.test.js`

Expected: PASS.

- [ ] **Step 5: Add failing unmount and replace tests**

```js
it("expectedMountIdが現在open mountと違うunmountを拒否する", async () => {
  const service = createMountedService();
  const result = await service.operatorUnmountSource({
    operatorActionId: "action:close",
    materialSourceId: "source:1a",
    expectedMountId: "mount:stale",
    actor: "operator",
    reason: "operator-unmount",
  });
  expect(result).toMatchObject({ ok: false, reason: "expected-mount-mismatch" });
  expect(result.store.spoolMounts[0]).toMatchObject({ status: "open" });
});

it("replaceのnew mount conflictではold mountをopenのまま保持する", async () => {
  const service = createMountedService({
    managedSpools: [{ id: "spool:a" }, { id: "spool:b" }],
    extraMounts: [createOpenMount({ materialSourceId: "source:1b", spoolId: "spool:b" })],
  });
  const result = await service.operatorReplaceSourceMount({
    operatorActionId: "action:replace",
    materialSource: createSource({ deviceId: "device:k2", materialSourceId: "source:1a" }),
    expectedOldMountId: service.snapshot().spoolMounts.find((m) => m.materialSourceId === "source:1a").mountId,
    newSpoolId: "spool:b",
    actor: "operator",
  });
  expect(result).toMatchObject({ ok: false, reason: "spool-already-mounted-on-another-source" });
  expect(service.snapshot().spoolMounts.find((m) => m.materialSourceId === "source:1a")).toMatchObject({ status: "open", spoolId: "spool:a" });
});
```

- [ ] **Step 6: Implement unmount and atomic replace**

Implementation must stage the whole next store in memory and call `persist` once. It must not mutate service current store until durable CAS succeeds.

- [ ] **Step 7: Add failing idempotency and payload conflict tests**

```js
it("restart後も同operation同payloadはidempotentに扱う", async () => {
  const first = await createServiceWithPersistOk().operatorMountSource(createMountInput({ operatorActionId: "action:1" }));
  const restored = createServiceWithPersistOk({ store: first.store });
  const retry = await restored.operatorMountSource(createMountInput({ operatorActionId: "action:1" }));
  expect(retry).toMatchObject({ ok: true, action: "idempotent" });
  expect(retry.store.spoolMounts).toHaveLength(1);
});

it("restart後の同operation異payloadはconflictにする", async () => {
  const first = await createServiceWithPersistOk().operatorMountSource(createMountInput({ operatorActionId: "action:1", spoolId: "spool:a" }));
  const restored = createServiceWithPersistOk({ store: first.store, managedSpools: [{ id: "spool:a" }, { id: "spool:b" }] });
  const retry = await restored.operatorMountSource(createMountInput({ operatorActionId: "action:1", spoolId: "spool:b" }));
  expect(retry).toMatchObject({ ok: false, reason: "same-mount-operation-different-payload" });
});
```

- [ ] **Step 8: Implement operation events and reconstructed idempotency**

Implementation must keep operation evidence in `events[]` and rebuild operation checks from normalized store input. It must not add durable `operationsById`.

- [ ] **Step 9: Run targeted service tests**

Run: `npx vitest run tests/unit/printer_core_material_accounting_mount_service.test.js`

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add 3dp_lib/printer_core/dashboard_material_accounting_mount_service.js tests/unit/printer_core_material_accounting_mount_service.test.js
git commit -m "Add material accounting spool mount service"
```

---

### Task 3: H-1a Verification And Review Package

**Files:**
- Modify: `docs/develop/printer-core-v3-gate18-9h-spool-mount-authority.md`
- Modify: `docs/develop/printer-core-v3-open-work.md`

**Interfaces:**
- Consumes: Task 1 and Task 2 public APIs and Vitest results.
- Produces: review-ready H-1a cutoff commit.

- [ ] **Step 1: Update spec status lines**

Change H-1a status from pending to implemented/tested. Keep H-1b pending.

- [ ] **Step 2: Run targeted tests**

Run:

```bash
npx vitest run tests/unit/printer_core_material_accounting_mount_store.test.js tests/unit/printer_core_material_accounting_mount_service.test.js
```

Expected: PASS.

- [ ] **Step 3: Run adjacent repository/accounting tests**

Run:

```bash
npx vitest run tests/unit/printer_core_spool_mount_repository.test.js tests/unit/printer_core_material_accounting_contract.test.js tests/unit/printer_core_material_accounting_print_binding.test.js
```

Expected: PASS.

- [ ] **Step 4: Run full unit suite**

Run: `npx vitest run`

Expected: PASS.

- [ ] **Step 5: Run whitespace check**

Run: `git diff --check`

Expected: PASS.

- [ ] **Step 6: Commit verification docs if changed**

```bash
git add docs/develop/printer-core-v3-gate18-9h-spool-mount-authority.md docs/develop/printer-core-v3-open-work.md
git commit -m "Mark Gate 18.9H-1a implementation readiness"
```

- [ ] **Step 7: Send reviewer package**

Reviewer prompt must include head SHA, file list, targeted test output summary, full Vitest result, `git diff --check` result, and explicit request to review P0/P1 for H-1a before H-1b durable persistence.

---

## Self-Review

- Spec coverage: H-1a pure store/service, non-durable operations index, CAS writer contract, legacy cross-backend guard, atomic replace, restart idempotency, and no side effects are covered by Task 1 and Task 2. H-1b durable storage is explicitly separated.
- Placeholder scan: The plan contains no TBD markers and no unstated validation steps. Each test step includes concrete assertions and expected command results.
- Type consistency: Store APIs use `materialAccountingSpoolMountStore`; service APIs match the Gate 18.9H spec: `operatorMountSource`, `operatorUnmountSource`, `operatorReplaceSourceMount`.
