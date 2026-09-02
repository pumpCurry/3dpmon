/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ESLint authority boundary 単体テスト
 * @file eslint_authority_boundary.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module eslint_authority_boundary_test
 *
 * 【機能内容サマリ】
 * - Printer Core v3 のtrusted issuerをproduction moduleから直接importできないことを検証
 * - test-only runtime factoryがproduction moduleへ漏れないことを検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1635 (PR #440)
 * @since   1.390.1630 (PR #440)
 * @lastModified 2026-09-02 10:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 合成production moduleを現在のESLint設定で検査する。
 *
 * 【詳細説明】
 * - source文字列そのものをgrepするのではなく、ESLint configを実行し、
 *   実際にCI lintで検出されるdiagnosticだけを検証する。
 *
 * @function lintSyntheticProductionModule
 * @param {string} relativeFilePath - repo rootから見た仮想production module path。
 * @param {string} source - 検査するJavaScript source。
 * @returns {Promise<Array<Object>>} ESLint message配列。
 */
async function lintSyntheticProductionModule(relativeFilePath, source) {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: path.join(REPO_ROOT, "eslint.config.js"),
  });
  const [result] = await eslint.lintText(source, {
    filePath: path.join(REPO_ROOT, relativeFilePath),
  });
  return result.messages;
}

/**
 * 指定ruleのmessage一覧を取り出す。
 *
 * @function messagesForRule
 * @param {Array<Object>} messages - ESLint message配列。
 * @param {string} ruleId - rule id。
 * @returns {string[]} message文字列配列。
 */
function messagesForRule(messages, ruleId) {
  return messages
    .filter((message) => message.ruleId === ruleId)
    .map((message) => message.message);
}

describe("ESLint authority import boundary", () => {
  it("app層production moduleはtrusted print binding factoryをrelative path違いでimportできない", async () => {
    const messages = await lintSyntheticProductionModule(
      "3dp_lib/dashboard_integration_itemkeeper.js",
      `import { createTrustedPrintStartMaterialAccountingPrintBindingRepository } from "./printer_core/dashboard_material_accounting_contract.js";
export const value = createTrustedPrintStartMaterialAccountingPrintBindingRepository;
`
    );

    expect(messagesForRule(messages, "no-restricted-imports")).toHaveLength(1);
    expect(messagesForRule(messages, "no-restricted-imports")[0])
      .toContain("Trusted print binding repository factory is runtime-internal");
  });

  it("app層production moduleはtest-only print binding runtimeをimportできない", async () => {
    const messages = await lintSyntheticProductionModule(
      "3dp_lib/dashboard_panel_init.js",
      `import { createMaterialAccountingPrintBindingRuntimeForTest } from "./printer_core/dashboard_material_accounting_print_binding_runtime.js";
export const value = createMaterialAccountingPrintBindingRuntimeForTest;
`
    );

    expect(messagesForRule(messages, "no-restricted-imports")).toHaveLength(1);
    expect(messagesForRule(messages, "no-restricted-imports")[0])
      .toContain("Test-only print binding runtime factory must not be imported by production modules");
  });

  it("許可moduleだけは必要なtrusted factory importを維持できる", async () => {
    const runtimeMessages = await lintSyntheticProductionModule(
      "3dp_lib/printer_core/dashboard_material_accounting_print_binding_runtime.js",
      `import { createTrustedPrintStartMaterialAccountingPrintBindingRepository } from "./dashboard_material_accounting_contract.js";
export const value = createTrustedPrintStartMaterialAccountingPrintBindingRepository;
`
    );
    const contractMessages = await lintSyntheticProductionModule(
      "3dp_lib/printer_core/dashboard_material_accounting_contract.js",
      `import { createMaterialAccountingPrintBindingRepositoryWithIssuer } from "./dashboard_material_accounting_print_binding_repository.js";
export const value = createMaterialAccountingPrintBindingRepositoryWithIssuer;
`
    );

    expect(messagesForRule(runtimeMessages, "no-restricted-imports")).toEqual([]);
    expect(messagesForRule(contractMessages, "no-restricted-imports")).toEqual([]);
  });

  it("ItemKeeper連携production moduleはForTest projection issuerをexportしない", async () => {
    const source = await readFile(
      path.join(REPO_ROOT, "3dp_lib/dashboard_integration_itemkeeper.js"),
      "utf8"
    );

    expect(source).not.toMatch(/export\s+function\s+registerItemKeeperSourceUsageProjectionCertificationForTest\b/);
    expect(source).not.toMatch(/export\s+function\s+clearItemKeeperSourceUsageProjectionCertificationsForTest\b/);
  });

  it("production moduleはItemKeeper ForTest projection issuer helperをimportできない", async () => {
    const messages = await lintSyntheticProductionModule(
      "3dp_lib/dashboard_integration_itemkeeper.js",
      `import {
  clearItemKeeperSourceUsageProjectionCertificationsForTest,
  registerItemKeeperSourceUsageProjectionCertificationForTest,
} from "./printer_core/dashboard_itemkeeper_source_usage_projection_certification.js";
export const value = [
  clearItemKeeperSourceUsageProjectionCertificationsForTest,
  registerItemKeeperSourceUsageProjectionCertificationForTest,
];
`
    );

    expect(messagesForRule(messages, "no-restricted-imports")).toHaveLength(2);
    expect(messagesForRule(messages, "no-restricted-imports").join("\n"))
      .toContain("ItemKeeper source usage projection test issuer must not be imported by production modules");
  });

  it("production moduleはdynamic importでもItemKeeper ForTest projection issuer moduleを読めない", async () => {
    const messages = await lintSyntheticProductionModule(
      "3dp_lib/dashboard_panel_init.js",
      `export async function loadIssuerForProduction() {
  return import("./printer_core/dashboard_itemkeeper_source_usage_projection_certification.js");
}
`
    );

    expect(messagesForRule(messages, "no-restricted-syntax")).toHaveLength(1);
    expect(messagesForRule(messages, "no-restricted-syntax")[0])
      .toContain("ItemKeeper source usage projection test issuer module must not be dynamically imported by production modules");
  });
});
