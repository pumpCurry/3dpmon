/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialSource print binding repository 公開入口モジュール
 * @file dashboard_material_accounting_print_binding.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_print_binding
 *
 * 【機能内容サマリ】
 * - Gate 18.9E の print-start material binding repository 公開入口を提供
 * - trusted issuerを直接公開せず、契約モジュール所有のrepository factoryだけを再export
 * - 既存import pathを維持しながらtrust boundaryを薄い互換層で固定
 *
 * 【公開関数一覧】
 * - {@link normalizeStoredMaterialAccountingPrintBindingStore}：保存済みprint binding storeを正規化
 * - {@link createMaterialAccountingPrintBindingStoreDigest}：print binding store digestを生成
 * - {@link createMaterialAccountingPrintBindingRepository}：print binding repositoryを生成
 * - {@link createTrustedPrintStartMaterialAccountingPrintBindingRepository}：trusted print-start issuer注入済みrepositoryを生成
 *
 * @version 1.390.1590 (PR #440)
 * @since   1.390.1516 (PR #438)
 * @lastModified 2026-09-01 18:41:23
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9F でsource-aware残量read model/UIへ接続する
 */

"use strict";

export {
  MATERIAL_ACCOUNTING_PRINT_BINDING_SCHEMA_VERSION,
  MATERIAL_ACCOUNTING_PRINT_BINDING_STATUS,
  createMaterialAccountingPrintBindingStoreDigest,
  createMaterialAccountingPrintBindingRepository,
  createTrustedPrintStartMaterialAccountingPrintBindingRepository,
  normalizeStoredMaterialAccountingPrintBindingStore,
} from "./dashboard_material_accounting_contract.js";
