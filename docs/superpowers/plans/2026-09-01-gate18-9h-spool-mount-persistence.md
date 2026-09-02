# Gate 18.9H-1b SpoolMount Durable Persistence Plan

> **For agentic workers:** Use this only after H-1a pure store/service review clears P0/P1 and H-1b receives GO.

**Goal:** Connect `materialAccountingSpoolMountStore` to durable application storage without weakening the production CAS contract established in H-1a.

**Non-goals:** No UI, no physical CFS command enablement, no filament remaining debit, no legacy `usageHistory` write, no `hostSpoolMap` migration, and no ItemKeeper projection.

## Design Boundary

- `monitorData.materialAccountingSpoolMountStore` is the runtime copy of the production mount store.
- Normal throttled persistence may queue the store for backup/export visibility, but production mount service success must use a dedicated durable CAS writer.
- IndexedDB is the only backend that can initially return `casApplied:true`.
- localStorage fallback may save the normalized store for backup/restore, but must not report production CAS success for mount/unmount/replace.
- Import/restore must normalize the incoming store and must not project it into `hostSpoolMap`, `usageHistory`, managed spool remaining, print binding shadow store, or physical command latch.

## Task 1: Storage Shape Round-trip

Files:

- `3dp_lib/dashboard_data.js`
- `3dp_lib/dashboard_storage.js`
- `3dp_lib/dashboard_storage_idb.js`
- `tests/unit/dashboard_storage_migration.test.js`
- `tests/unit/dashboard_storage_durable.test.js`
- `tests/unit/dashboard_storage.test.js`

Steps:

- [x] Add `materialAccountingSpoolMountStore` to `monitorData` with the H-1a empty normalized shape.
- [x] Add the key to `LS_GLOBAL_FIELDS`.
- [x] Add the key to `SHARED_KEYS`.
- [x] Import `normalizeStoredMaterialAccountingSpoolMountStore()` in `dashboard_storage.js`.
- [x] Add restore/import merge logic that normalizes the store and keeps it separate from all legacy accounting fields.
- [x] Add migration/round-trip tests proving save -> restore preserves mount store and leaves `hostSpoolMap`, `usageHistory`, `filamentSpools.remainingLengthMm`, `materialAccountingPrintBindingStore`, and `physicalCommandRecoveryLatch` unchanged.
- [x] Add a storage completeness test asserting the new key is queued/written with other shared storage keys.

## Task 2: IndexedDB Shared-key CAS Primitive

Files:

- `3dp_lib/dashboard_storage_idb.js`
- New test file, likely `tests/unit/dashboard_storage_idb_cas.test.js`

Proposed API:

```js
compareAndSwapSharedValue({
  key,
  expectedDigest,
  createDigest,
  nextValue
});
```

Contract:

- [x] Return `{ ok: false, casApplied: false, reason: "indexeddb-unavailable" }` when IndexedDB is unavailable.
- [x] In one `readwrite` transaction, read the current shared record, calculate the current digest, compare it with `expectedDigest`, and only then write `nextValue`.
- [x] Return `{ ok: false, casApplied: false, reason: "cas-mismatch", currentDigest }` without writing if the digest differs.
- [x] Return `{ ok: true, casApplied: true, backend: "indexedDB", key, currentDigest, nextDigest }` after transaction completion.
- [x] If transaction fails, return `{ ok: false, casApplied: false, reason: "indexeddb-write-failed" }` and do not disable safety checks into a fake CAS success path.
- [x] Ensure queued writes for the same key cannot overwrite a just-committed CAS value with stale data; flush or remove pending shared writes for the CAS key before/inside the CAS path.

## Task 3: SpoolMount Store CAS Writer

Files:

- `3dp_lib/dashboard_storage.js`
- `tests/unit/dashboard_storage_durable.test.js`
- New test file if needed, likely `tests/unit/printer_core_material_accounting_mount_storage.test.js`

Proposed API:

```js
commitMaterialAccountingSpoolMountStoreDurably({
  baseStoreDigest,
  nextStore,
  operation
});
```

Contract:

- [x] Normalize `nextStore` before persistence.
- [x] Reject missing or invalid `baseStoreDigest`.
- [x] Reject missing operation evidence.
- [x] If IndexedDB is unavailable, return `{ ok: false, casApplied: false, reason: "production-cas-unavailable" }`.
- [x] Use `compareAndSwapSharedValue()` with key `materialAccountingSpoolMountStore` and the H-1a store digest function.
- [x] Only after CAS success, update `monitorData.materialAccountingSpoolMountStore` to the committed normalized store.
- [x] Do not call `saveUnifiedStorageDurably()` as a substitute for CAS.
- [x] Do not mutate `hostSpoolMap`, `usageHistory`, `filamentSpools`, `materialAccountingPrintBindingStore`, or `physicalCommandRecoveryLatch`.
- [x] Reject stale managed spool / legacy occupancy preconditions before CAS so a service-side send-time check cannot race a storage-side state change.

## Task 4: Service Integration Factory

Files:

- New module if useful: `3dp_lib/printer_core/dashboard_material_accounting_mount_runtime.js`
- Tests: `tests/unit/printer_core_material_accounting_mount_runtime.test.js`

Contract:

- [x] Build the H-1a service from current `monitorData.materialAccountingSpoolMountStore`.
- [x] Resolve managed spools from `monitorData.filamentSpools`.
- [x] Resolve legacy occupancy from `monitorData.hostSpoolMap`.
- [x] Accept trusted MaterialSource records only from the existing read-only MaterialSource observation/registry path.
- [x] Require the service to resolve `materialSourceId` through trusted resolver callbacks instead of accepting caller supplied `materialSource` records as authority.
- [x] Bind `sourceIdentityDigestAtOpen` to `MaterialSource.identity` as well as locator/unit/kind evidence.
- [x] Quarantine semantic mount/event authority conflicts without first-win restoration.
- [x] Inject `commitMaterialAccountingSpoolMountStoreDurably()` as `persist`.
- [x] Keep this runtime factory unused by UI until H-2.

## Task 5: Verification And Review

- [x] Run focused storage tests.
- [x] Run focused mount store/service/runtime tests.
- [x] Run full `npx vitest run`.
- [x] Run `git diff --check`.
- [x] Update Gate 18.9H spec status: H-1b implemented/tested, H-2 pending.
- [x] Request reviewer validation before H-2 UI work.
- [ ] Request reviewer validation for the H-1a/H-1b hardening follow-up before H-2 UI work.

## Expected Reviewer Questions

- Does queued IndexedDB writing race with CAS writes for the same shared key?
- Is localStorage fallback allowed to hold the data while refusing production writes?
- Should import adopt a valid incoming store when current store is non-empty but different?
- Should H-1b expose a repair/conflict banner, or leave that entirely for H-2?

Initial recommendation:

- CAS writes should flush or remove pending writes for `materialAccountingSpoolMountStore`.
- localStorage fallback can store/restore but must not enable production mount operations.
- Import can normalize and restore when current store is empty or identical; divergent non-empty import should be quarantined/blocked rather than merged.
- Repair UI belongs to H-2, but H-1b should preserve conflict evidence.
