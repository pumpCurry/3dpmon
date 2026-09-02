/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 IndexedDB CAS 単体テスト
 * @file dashboard_storage_idb_cas.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_storage_idb_cas_test
 *
 * 【機能内容サマリ】
 * - shared store単一keyのcompare-and-swap更新を検証
 * - pending shared writeがCAS後の値を古い値で上書きしない境界を固定
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1582 (PR #440)
 * @since   1.390.1580 (PR #440)
 * @lastModified 2026-09-01 15:42:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEmptyMaterialAccountingSpoolMountStore,
  normalizeStoredMaterialAccountingSpoolMountStore,
} from "../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js";

/**
 * IndexedDB request互換の最小オブジェクトを生成する。
 *
 * @function createFakeRequest
 * @returns {Object} fake request。
 */
function createFakeRequest() {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  };
}

/**
 * transaction完了を次tickへスケジュールする。
 *
 * @function scheduleTransactionComplete
 * @param {Object} tx - fake transaction。
 * @returns {void}
 */
function scheduleTransactionComplete(tx) {
  if (tx._scheduled) return;
  tx._scheduled = true;
  setTimeout(() => {
    tx._scheduled = false;
    if (!tx._aborted && typeof tx.oncomplete === "function") {
      tx.oncomplete();
    }
  }, 0);
}

/**
 * dashboard_storage_idb.js用の最小fake IndexedDBを導入する。
 *
 * @function installFakeIndexedDb
 * @param {Object=} initialShared - shared store初期値。
 * @returns {{shared: Map<string,Object>, machines: Map<string,Object>}} fake store群。
 */
function installFakeIndexedDb(initialShared = {}) {
  const stores = {
    shared: new Map(Object.entries(initialShared).map(([key, value]) => [key, { key, value }])),
    machines: new Map(),
  };
  const db = {
    objectStoreNames: {
      contains: (name) => Object.prototype.hasOwnProperty.call(stores, name),
    },
    createObjectStore: (name) => {
      stores[name] = new Map();
      return stores[name];
    },
    transaction: (storeNames) => {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      const tx = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        _scheduled: false,
        _aborted: false,
        abort: () => {
          tx._aborted = true;
          if (typeof tx.onabort === "function") tx.onabort();
        },
        objectStore: (name) => {
          if (!names.includes(name)) {
            throw new Error(`store ${name} is not in transaction`);
          }
          const backing = stores[name] || new Map();
          stores[name] = backing;
          return {
            get: (key) => {
              const req = createFakeRequest();
              globalThis.queueMicrotask(() => {
                req.result = backing.get(key);
                if (typeof req.onsuccess === "function") req.onsuccess();
                scheduleTransactionComplete(tx);
              });
              return req;
            },
            getAll: () => {
              const req = createFakeRequest();
              globalThis.queueMicrotask(() => {
                req.result = Array.from(backing.values());
                if (typeof req.onsuccess === "function") req.onsuccess();
                scheduleTransactionComplete(tx);
              });
              return req;
            },
            put: (record) => {
              backing.set(record.key || record.hostname, { ...record });
              scheduleTransactionComplete(tx);
            },
            clear: () => {
              backing.clear();
              scheduleTransactionComplete(tx);
            },
          };
        },
      };
      return tx;
    },
  };
  globalThis.indexedDB = {
    open: () => {
      const req = createFakeRequest();
      globalThis.queueMicrotask(() => {
        req.result = db;
        if (typeof req.onupgradeneeded === "function") {
          req.onupgradeneeded({ target: req });
        }
        if (typeof req.onsuccess === "function") {
          req.onsuccess();
        }
      });
      return req;
    },
  };
  return stores;
}

describe("compareAndSwapSharedValue", () => {
  beforeEach(() => {
    vi.resetModules();
    delete globalThis.indexedDB;
  });

  it("現在digest一致時だけshared keyを書き換える", async () => {
    const stores = installFakeIndexedDb();
    const {
      initIdb,
      compareAndSwapSharedValue,
      exportAllIdb,
    } = await import("../../3dp_lib/dashboard_storage_idb.js");
    const {
      createMaterialAccountingSpoolMountStoreDigest,
    } = await import("../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js");
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const nextStore = normalizeStoredMaterialAccountingSpoolMountStore({ storeRevision: 1 });

    await initIdb();
    const result = await compareAndSwapSharedValue({
      key: "materialAccountingSpoolMountStore",
      expectedDigest: baseStore.storeDigest,
      createDigest: createMaterialAccountingSpoolMountStoreDigest,
      nextValue: nextStore,
    });

    expect(result).toMatchObject({ ok: true, casApplied: true, reason: "cas-applied" });
    expect(stores.shared.get("materialAccountingSpoolMountStore").value).toEqual(nextStore);
    await expect(exportAllIdb()).resolves.toMatchObject({
      materialAccountingSpoolMountStore: nextStore,
    });
  });

  it("digest不一致時は値を書き換えない", async () => {
    const currentStore = normalizeStoredMaterialAccountingSpoolMountStore({ storeRevision: 5 });
    installFakeIndexedDb({ materialAccountingSpoolMountStore: currentStore });
    const {
      initIdb,
      compareAndSwapSharedValue,
      exportAllIdb,
    } = await import("../../3dp_lib/dashboard_storage_idb.js");
    const {
      createMaterialAccountingSpoolMountStoreDigest,
    } = await import("../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js");
    const nextStore = normalizeStoredMaterialAccountingSpoolMountStore({ storeRevision: 6 });

    await initIdb();
    const result = await compareAndSwapSharedValue({
      key: "materialAccountingSpoolMountStore",
      expectedDigest: "fnv1a128:stale",
      createDigest: createMaterialAccountingSpoolMountStoreDigest,
      nextValue: nextStore,
    });

    expect(result).toMatchObject({ ok: false, casApplied: false, reason: "cas-mismatch" });
    await expect(exportAllIdb()).resolves.toMatchObject({
      materialAccountingSpoolMountStore: currentStore,
    });
  });

  it("同一keyのpending shared writeはCAS開始時に破棄され古い値で上書きしない", async () => {
    installFakeIndexedDb();
    const {
      initIdb,
      queueSharedWrite,
      compareAndSwapSharedValue,
      flushIdb,
      exportAllIdb,
    } = await import("../../3dp_lib/dashboard_storage_idb.js");
    const {
      createMaterialAccountingSpoolMountStoreDigest,
    } = await import("../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js");
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const staleStore = normalizeStoredMaterialAccountingSpoolMountStore({ storeRevision: 2 });
    const casStore = normalizeStoredMaterialAccountingSpoolMountStore({ storeRevision: 3 });

    await initIdb();
    queueSharedWrite("materialAccountingSpoolMountStore", staleStore);
    const result = await compareAndSwapSharedValue({
      key: "materialAccountingSpoolMountStore",
      expectedDigest: baseStore.storeDigest,
      createDigest: createMaterialAccountingSpoolMountStoreDigest,
      nextValue: casStore,
    });
    await flushIdb();

    expect(result).toMatchObject({ ok: true, casApplied: true });
    await expect(exportAllIdb()).resolves.toMatchObject({
      materialAccountingSpoolMountStore: casStore,
    });
  });

  it("CAS保護keyは通常queueへ積まずCAS中の古いflushで上書きしない", async () => {
    installFakeIndexedDb();
    const {
      initIdb,
      queueSharedWrite,
      compareAndSwapSharedValue,
      flushIdb,
      exportAllIdb,
    } = await import("../../3dp_lib/dashboard_storage_idb.js");
    const {
      createMaterialAccountingSpoolMountStoreDigest,
    } = await import("../../3dp_lib/printer_core/dashboard_material_accounting_mount_store.js");
    const baseStore = createEmptyMaterialAccountingSpoolMountStore();
    const staleStore = normalizeStoredMaterialAccountingSpoolMountStore({ storeRevision: 7 });
    const casStore = normalizeStoredMaterialAccountingSpoolMountStore({ storeRevision: 8 });

    await initIdb();
    queueSharedWrite("materialAccountingSpoolMountStore", staleStore);
    const result = await compareAndSwapSharedValue({
      key: "materialAccountingSpoolMountStore",
      expectedDigest: baseStore.storeDigest,
      createDigest: createMaterialAccountingSpoolMountStoreDigest,
      nextValue: casStore,
    });
    await flushIdb();

    expect(result).toMatchObject({ ok: true, casApplied: true });
    await expect(exportAllIdb()).resolves.toMatchObject({
      materialAccountingSpoolMountStore: casStore,
    });
  });
});
