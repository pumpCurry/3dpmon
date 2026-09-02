/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 ItemKeeper source usage live fixture 認証テスト
 * @file printer_core_itemkeeper_source_usage_projection_certification.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module printer_core_itemkeeper_source_usage_projection_certification_test
 *
 * 【機能内容サマリ】
 * - Gate 18.9J-1 のlive fixture receiptがruntime projection registryを開かないことを検証
 * - K2 materialUsed CSV parserをfixture評価とruntimeで共有できる契約として検証
 *
 * 【公開関数一覧】
 * - none
 *
 * @version 1.390.1634 (PR #440)
 * @since   1.390.1632 (PR #440)
 * @lastModified 2026-09-02 09:58:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { describe, expect, it } from "vitest";
import {
  evaluateItemKeeperSourceUsageLiveFixture,
  isItemKeeperProjectionCertified,
} from "../../3dp_lib/printer_core/dashboard_itemkeeper_source_usage_projection_certification.js";
import {
  parseK2MaterialUsedSourceCsv,
  resolveK2MaterialUsedSourceCsv,
} from "../../3dp_lib/printer_core/dashboard_material_used_csv_parser.js";

/**
 * 18.9J-1 fixture evidenceの正規値を生成する。
 *
 * 【詳細説明】
 * - expectedSourceCountは独立authorityにせず、expectedSourceOrder.lengthから評価させる。
 *
 * @function createFixtureEvidence
 * @param {Object=} overrides - 上書き値。
 * @returns {Object} fixture evidence。
 */
function createFixtureEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    authority: "itemkeeper-source-usage-live-fixture-evidence",
    gate: "18.9J-1",
    fixtureId: "fixture:k2-pro-f012-itemkeeper-source-order-20260902",
    captureId: "capture:k2-pro-f012-20260902-001",
    capturedAt: "2026-09-02T01:00:00.000Z",
    operatorActionId: "operator:itemkeeper-live-fixture-20260902-001",
    reviewedCommit: "0123456789abcdef0123456789abcdef01234567",
    parser: {
      parserVersion: "k2-material-used-csv:v1",
      sourceOrderingProfile: "print-start-binding-authority-order:v1",
    },
    device: {
      deviceId: "serial:k2-pro-69e7",
      printerType: "creality-k2",
      model: "F012",
      firmwareVersion: "1.1.6.7",
    },
    print: {
      printJobId: "job:k2-source-aware-001",
      printPlanId: "plan:k2-source-aware-001",
    },
    raw: {
      materialUsedSourceCsv: "3210,0,6543",
    },
    artifact: {
      captureSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    expectedSourceOrder: [
      {
        order: 0,
        toolId: 0,
        protocolToolAlias: "T1A",
        materialSourceId: "source:k2:1a",
        mountId: "mount:1a",
        spoolId: "spool:a",
        snapshotId: "snap:1a",
        bindingAuthorityDigest: "fnv1a128:snap-digest-1a",
        usedLengthMm: 3210,
        usageState: "observed-used",
        locator: { unitIndex: 1, slotIndex: 0, protocolSlotId: 0 },
      },
      {
        order: 1,
        toolId: 1,
        protocolToolAlias: "T1B",
        materialSourceId: "source:k2:1b",
        mountId: "mount:1b",
        spoolId: "spool:b",
        snapshotId: "snap:1b",
        bindingAuthorityDigest: "fnv1a128:snap-digest-1b",
        usedLengthMm: 0,
        usageState: "confirmed-unused",
        locator: { unitIndex: 1, slotIndex: 1, protocolSlotId: 1 },
      },
      {
        order: 2,
        toolId: 2,
        protocolToolAlias: "T1C",
        materialSourceId: "source:k2:1c",
        mountId: "mount:1c",
        spoolId: "spool:c",
        snapshotId: "snap:1c",
        bindingAuthorityDigest: "fnv1a128:snap-digest-1c",
        usedLengthMm: 6543,
        usageState: "observed-used",
        locator: { unitIndex: 1, slotIndex: 2, protocolSlotId: 2 },
      },
    ],
    ...overrides,
  };
}

/**
 * print-start snapshot fixtureを生成する。
 *
 * @function createPrintStartSnapshots
 * @returns {Object[]} print-start snapshot配列。
 */
function createPrintStartSnapshots() {
  return [
    {
      snapshotId: "snap:1a",
      deviceId: "serial:k2-pro-69e7",
      printJobId: "job:k2-source-aware-001",
      printPlanId: "plan:k2-source-aware-001",
      materialSourceId: "source:k2:1a",
      mountId: "mount:1a",
      spoolId: "spool:a",
      bindingAuthorityDigest: "fnv1a128:snap-digest-1a",
      bindingAuthority: {
        tool: { toolId: 0, protocolToolAlias: "T1A", order: 0 },
        source: { materialSourceId: "source:k2:1a" },
        mount: { mountId: "mount:1a", spoolId: "spool:a" },
      },
    },
    {
      snapshotId: "snap:1b",
      deviceId: "serial:k2-pro-69e7",
      printJobId: "job:k2-source-aware-001",
      printPlanId: "plan:k2-source-aware-001",
      materialSourceId: "source:k2:1b",
      mountId: "mount:1b",
      spoolId: "spool:b",
      bindingAuthorityDigest: "fnv1a128:snap-digest-1b",
      bindingAuthority: {
        tool: { toolId: 1, protocolToolAlias: "T1B", order: 1 },
        source: { materialSourceId: "source:k2:1b" },
        mount: { mountId: "mount:1b", spoolId: "spool:b" },
      },
    },
    {
      snapshotId: "snap:1c",
      deviceId: "serial:k2-pro-69e7",
      printJobId: "job:k2-source-aware-001",
      printPlanId: "plan:k2-source-aware-001",
      materialSourceId: "source:k2:1c",
      mountId: "mount:1c",
      spoolId: "spool:c",
      bindingAuthorityDigest: "fnv1a128:snap-digest-1c",
      bindingAuthority: {
        tool: { toolId: 2, protocolToolAlias: "T1C", order: 2 },
        source: { materialSourceId: "source:k2:1c" },
        mount: { mountId: "mount:1c", spoolId: "spool:c" },
      },
    },
  ];
}

/**
 * JobMaterialSegment fixtureを生成する。
 *
 * @function createJobMaterialSegments
 * @returns {Object[]} JobMaterialSegment配列。
 */
function createJobMaterialSegments() {
  return [
    {
      segmentId: "seg:1a",
      deviceId: "serial:k2-pro-69e7",
      printJobId: "job:k2-source-aware-001",
      printPlanId: "plan:k2-source-aware-001",
      toolId: 0,
      protocolToolAlias: "T1A",
      order: 0,
      materialSourceId: "source:k2:1a",
      mountId: "mount:1a",
      spoolId: "spool:a",
      usedLengthMm: 3210,
      usageState: "observed-used",
      confidence: "high",
      debit: { status: "eligible", canDebit: true, reasons: [] },
    },
    {
      segmentId: "seg:1b",
      deviceId: "serial:k2-pro-69e7",
      printJobId: "job:k2-source-aware-001",
      printPlanId: "plan:k2-source-aware-001",
      toolId: 1,
      protocolToolAlias: "T1B",
      order: 1,
      materialSourceId: "source:k2:1b",
      mountId: "mount:1b",
      spoolId: "spool:b",
      usedLengthMm: 0,
      usageState: "confirmed-unused",
      confidence: "high",
      debit: { status: "eligible", canDebit: false, reasons: [] },
    },
    {
      segmentId: "seg:1c",
      deviceId: "serial:k2-pro-69e7",
      printJobId: "job:k2-source-aware-001",
      printPlanId: "plan:k2-source-aware-001",
      toolId: 2,
      protocolToolAlias: "T1C",
      order: 2,
      materialSourceId: "source:k2:1c",
      mountId: "mount:1c",
      spoolId: "spool:c",
      usedLengthMm: 6543,
      usageState: "observed-used",
      confidence: "high",
      debit: { status: "eligible", canDebit: true, reasons: [] },
    },
  ];
}

describe("parseK2MaterialUsedSourceCsv", () => {
  it("CSV parserは解析versionとsource順序profileを分離して返す", () => {
    const parsed = parseK2MaterialUsedSourceCsv("3210,0,6543", { expectedCount: 3 });

    expect(parsed).toMatchObject({
      ok: true,
      parserVersion: "k2-material-used-csv:v1",
      sourceOrderingProfile: "print-start-binding-authority-order:v1",
      rawMaterialUsed: "3210,0,6543",
      usedLengthMm: [3210, 0, 6543],
      reasons: [],
    });
  });

  it("CSV parserは空fieldを0mmへ詰めずinvalidとして返す", () => {
    const parsed = parseK2MaterialUsedSourceCsv("3210,,6543", { expectedCount: 3 });

    expect(parsed).toMatchObject({
      ok: false,
      parts: ["3210", "", "6543"],
      usedLengthMm: [3210, 6543],
    });
    expect(parsed.reasons).toContain("material-used-source-empty-field");
  });

  it("CSV parserは先頭/末尾empty fieldと非decimal表現をinvalidとして返す", () => {
    const leading = parseK2MaterialUsedSourceCsv(",3210", { expectedCount: 2 });
    const trailing = parseK2MaterialUsedSourceCsv("3210,", { expectedCount: 2 });
    const hexadecimal = parseK2MaterialUsedSourceCsv("0x10,3210", { expectedCount: 2 });

    expect(leading.reasons).toContain("material-used-source-empty-field");
    expect(trailing.reasons).toContain("material-used-source-empty-field");
    expect(hexadecimal.reasons).toContain("usage-length-invalid");
    expect(hexadecimal.usedLengthMm).toEqual([3210]);
  });

  it("materialUsed CSV resolverはruntime/fixture共通のfield precedenceで抽出する", () => {
    const raw = resolveK2MaterialUsedSourceCsv({
      materialUsed: "111,222",
      materialUsedSourceCsv: "333,444",
      raw: { materialUsed: "555,666" },
    });

    expect(raw).toBe("111,222");
  });
});

describe("evaluateItemKeeperSourceUsageLiveFixture", () => {
  it("valid live fixtureはfixture receiptだけを返しruntime registryを開かない", () => {
    const segments = createJobMaterialSegments();
    const result = evaluateItemKeeperSourceUsageLiveFixture({
      fixtureEvidence: createFixtureEvidence(),
      printStartSnapshots: createPrintStartSnapshots(),
      jobMaterialSegments: segments,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "fixture-accepted",
      authority: "itemkeeper-source-usage-live-fixture-evidence",
      schemaVersion: 1,
      gate: "18.9J-1",
      parserVersion: "k2-material-used-csv:v1",
      sourceOrderingProfile: "print-start-binding-authority-order:v1",
      parsedUsedLengthMm: [3210, 0, 6543],
      errors: [],
      capability: {
        canRegisterProjection: false,
        canProjectItemKeeper: false,
      },
    });
    expect(result.fixtureDigest).toMatch(/^fnv1a128:/);
    expect(result.observedSourceOrder.map((entry) => [
      entry.order,
      entry.protocolToolAlias,
      entry.materialSourceId,
      entry.mountId,
      entry.spoolId,
      entry.usedLengthMm,
      entry.usageState,
    ])).toEqual([
      [0, "T1A", "source:k2:1a", "mount:1a", "spool:a", 3210, "observed-used"],
      [1, "T1B", "source:k2:1b", "mount:1b", "spool:b", 0, "confirmed-unused"],
      [2, "T1C", "source:k2:1c", "mount:1c", "spool:c", 6543, "observed-used"],
    ]);

    const copiedFixtureReceiptSegment = {
      ...segments[0],
      itemKeeperProjection: result,
    };
    expect(isItemKeeperProjectionCertified(copiedFixtureReceiptSegment)).toBe(false);
  });

  it("CSV件数とsource集合件数が一致しないlive fixtureはrejectする", () => {
    const result = evaluateItemKeeperSourceUsageLiveFixture({
      fixtureEvidence: createFixtureEvidence({
        raw: { materialUsedSourceCsv: "3210,0,6543,999" },
      }),
      printStartSnapshots: createPrintStartSnapshots(),
      jobMaterialSegments: createJobMaterialSegments(),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("fixture-rejected");
    expect(result.errors).toContain("material-used-source-count-mismatch");
    expect(result.capability).toEqual({
      canRegisterProjection: false,
      canProjectItemKeeper: false,
    });
  });

  it("expectedSourceOrderの空使用量をconfirmed-unused 0mmとして受理しない", () => {
    const expectedSourceOrder = createFixtureEvidence().expectedSourceOrder.map((entry, index) => (
      index === 1 ? { ...entry, usedLengthMm: "" } : { ...entry }
    ));
    const result = evaluateItemKeeperSourceUsageLiveFixture({
      fixtureEvidence: createFixtureEvidence({ expectedSourceOrder }),
      printStartSnapshots: createPrintStartSnapshots(),
      jobMaterialSegments: createJobMaterialSegments(),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("fixture-rejected");
    expect(result.errors).toContain("expected-source-order-mismatch");
    expect(result.errors).toContain("confirmed-unused-zero-length-required");
  });

  it("segment側のnull/空使用量をconfirmed-unused 0mmとして受理しない", () => {
    const segments = createJobMaterialSegments().map((entry, index) => (
      index === 1 ? { ...entry, usedLengthMm: null } : { ...entry }
    ));
    const result = evaluateItemKeeperSourceUsageLiveFixture({
      fixtureEvidence: createFixtureEvidence(),
      printStartSnapshots: createPrintStartSnapshots(),
      jobMaterialSegments: segments,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("expected-source-order-mismatch");
  });

  it("order/toolIdの欠損や重複があるsource orderをrejectする", () => {
    const missingOrder = createFixtureEvidence().expectedSourceOrder.map((entry, index) => (
      index === 0 ? { ...entry, order: null } : { ...entry }
    ));
    const duplicateOrder = createFixtureEvidence().expectedSourceOrder.map((entry, index) => (
      index === 1 ? { ...entry, order: 0 } : { ...entry }
    ));
    const duplicateAlias = createFixtureEvidence().expectedSourceOrder.map((entry, index) => (
      index === 1 ? { ...entry, protocolToolAlias: "T1A" } : { ...entry }
    ));

    const missingResult = evaluateItemKeeperSourceUsageLiveFixture({
      fixtureEvidence: createFixtureEvidence({ expectedSourceOrder: missingOrder }),
      printStartSnapshots: createPrintStartSnapshots(),
      jobMaterialSegments: createJobMaterialSegments(),
    });
    const duplicateOrderResult = evaluateItemKeeperSourceUsageLiveFixture({
      fixtureEvidence: createFixtureEvidence({ expectedSourceOrder: duplicateOrder }),
      printStartSnapshots: createPrintStartSnapshots(),
      jobMaterialSegments: createJobMaterialSegments(),
    });
    const duplicateAliasResult = evaluateItemKeeperSourceUsageLiveFixture({
      fixtureEvidence: createFixtureEvidence({ expectedSourceOrder: duplicateAlias }),
      printStartSnapshots: createPrintStartSnapshots(),
      jobMaterialSegments: createJobMaterialSegments(),
    });

    expect(missingResult.errors).toContain("expected-source-order-explicit-values-required");
    expect(duplicateOrderResult.errors).toContain("duplicate-expected-source-order");
    expect(duplicateAliasResult.errors).toContain("duplicate-expected-tool-alias");
  });

  it("fixture raw evidenceとhistory resolverのrawが一致しない場合はrejectする", () => {
    const result = evaluateItemKeeperSourceUsageLiveFixture({
      fixtureEvidence: createFixtureEvidence(),
      printStartSnapshots: createPrintStartSnapshots(),
      jobMaterialSegments: createJobMaterialSegments(),
      rawHistoryEntry: {
        materialUsed: "999,0,6543",
        materialUsedSourceCsv: "3210,0,6543",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("fixture-raw-material-used-mismatch");
  });

  it("reviewedCommitがfull SHAでないlive fixtureはrejectする", () => {
    const result = evaluateItemKeeperSourceUsageLiveFixture({
      fixtureEvidence: createFixtureEvidence({ reviewedCommit: "6078d16" }),
      printStartSnapshots: createPrintStartSnapshots(),
      jobMaterialSegments: createJobMaterialSegments(),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("reviewed-commit-full-sha-required");
  });

  it("source orderのtool aliasがsnapshot/segmentと入れ替わるlive fixtureはrejectする", () => {
    const expectedSourceOrder = createFixtureEvidence().expectedSourceOrder.map((entry) => ({ ...entry }));
    expectedSourceOrder[0].protocolToolAlias = "T1B";
    expectedSourceOrder[1].protocolToolAlias = "T1A";

    const result = evaluateItemKeeperSourceUsageLiveFixture({
      fixtureEvidence: createFixtureEvidence({ expectedSourceOrder }),
      printStartSnapshots: createPrintStartSnapshots(),
      jobMaterialSegments: createJobMaterialSegments(),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("expected-source-order-mismatch");
  });
});
