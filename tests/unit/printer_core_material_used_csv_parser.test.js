/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 materialUsed CSV parser 単体テスト
 * @file printer_core_material_used_csv_parser.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_material_used_csv_parser_test
 *
 * 【機能内容サマリ】
 * - K2/CFS source-specific materialUsed CSV のcompletionEvidence境界を検証する
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1667 (PR #440)
 * @since   1.390.1664 (PR #440)
 * @lastModified 2026-09-02 19:33:18
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";
import {
  K2_MATERIAL_USED_CSV_PARSER_VERSION,
  K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE,
  resolveK2MaterialUsedCompletionEvidenceCsv
} from "../../3dp_lib/printer_core/dashboard_material_used_csv_parser.js";

describe("resolveK2MaterialUsedCompletionEvidenceCsv", () => {
  it("durable completionEvidence fallbackではsourceCountとpartCountの欠落をfail-closed reasonにする", () => {
    const result = resolveK2MaterialUsedCompletionEvidenceCsv(null, [
      {
        evidence: {
          completionEvidence: {
            rawMaterialUsed: "3210,0",
            parserVersion: K2_MATERIAL_USED_CSV_PARSER_VERSION,
            sourceOrderingProfile: K2_MATERIAL_USED_SOURCE_ORDERING_PROFILE
          }
        }
      }
    ], {
      expectedSourceCount: 2
    });

    expect(result).toMatchObject({
      rawMaterialUsed: "3210,0",
      source: "job-material-segment-completion-evidence"
    });
    expect(result.reasons).toEqual(expect.arrayContaining([
      "completion-evidence-source-count-missing",
      "completion-evidence-part-count-missing"
    ]));
  });
});
