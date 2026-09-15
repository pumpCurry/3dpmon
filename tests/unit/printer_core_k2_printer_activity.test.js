/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 printer activity 単体テストモジュール
 * @file printer_core_k2_printer_activity.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_k2_printer_activity_test
 *
 * 【機能内容サマリ】
 * - K2 status frameのfeedState観測と累積snapshot境界を検証
 * - CFS物理操作の補助診断値をidle成功判定と分離して保持することを検証
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1674 (PR #442)
 * @since   1.390.1674 (PR #442)
 * @lastModified 2026-09-15 11:47:43
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";
import {
  classifyK2PrinterActivity,
  listObservedK2PrinterStatusScalarKeys,
  mergeK2PrinterStatusScalarSnapshot,
} from "../../3dp_lib/printer_core/dashboard_k2_printer_activity.js";

describe("K2 printer activity CFS physical safety inputs", () => {
  it("feedStateをstatus scalarとして列挙し累積snapshotへ保持する", () => {
    expect(listObservedK2PrinterStatusScalarKeys({ state: 0, feedState: 0 })).toEqual([
      "feedState",
      "state",
    ]);
    expect(mergeK2PrinterStatusScalarSnapshot(
      { state: 0, feedState: 101 },
      { feedState: 0 }
    )).toMatchObject({ state: 0, feedState: 0 });
  });

  it("feedStateは有限numberへ正規化するがphysical idle成功とは独立して返す", () => {
    const result = classifyK2PrinterActivity({
      state: 0,
      deviceState: 0,
      printLeftTime: 0,
      targetNozzleTemp: 0,
      targetBedTemp0: 0,
      feedState: "0",
    });

    expect(result.idle).toBe(true);
    expect(result.feedState).toBe(0);
  });
});
