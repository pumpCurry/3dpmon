/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 CFS slot control 実機認証fixture検証モジュール
 * @file k2_cfs_slot_control_certification_fixture.test.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module k2_cfs_slot_control_certification_fixture_test
 *
 * 【機能内容サマリ】
 * - F012実機で取得したCFS押出し・引戻し認証証跡のscopeと安全条件を検証
 * - 公開fixtureへ実環境の識別情報が混入していないことを検証
 *
 * 【公開関数一覧】
 * - なし：Vitest による単体テストのみを提供
 *
 * @version 1.390.1673 (PR #442)
 * @since   1.390.1673 (PR #442)
 * @lastModified 2026-09-09 17:12:52
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateK2CfsSlotControlCertificationEvidence,
} from "../../3dp_lib/printer_core/dashboard_k2_cfs_command_transport.js";

/**
 * F012 CFS slot controlの匿名化済み実機認証fixtureパス。
 *
 * @constant {string}
 */
const FIXTURE_PATH = path.resolve(
  "tests",
  "fixtures",
  "printers",
  "k2-pro-cfs",
  "scenarios",
  "cfs-slot-control-live",
  "certification-summary.json",
);

/**
 * 公開fixtureへ残してはならない実ネットワーク識別子の検出パターン。
 *
 * 【詳細説明】
 * - private IPv4、MAC address、および既知の実機hostnameを検出対象にする。
 * - fixture固有の論理source IDや匿名capture IDは許可する。
 *
 * @constant {RegExp}
 */
const RAW_DEVICE_IDENTIFIER_PATTERN = /(?:\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[0-1]))(?:\.\d{1,3}){2,3}\b|\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b|K2Pro-69E7)/iu;

/**
 * 匿名化済みK2 CFS認証fixtureを読み込む。
 *
 * 【詳細説明】
 * - JSON parse後のobjectを返し、各テストが同じ永続証跡を直接検証できるようにする。
 *
 * @function readCertificationFixture
 * @returns {object} parse済み認証fixture
 */
function readCertificationFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
}

describe("K2 CFS slot control live certification fixture", () => {
  it("F012 production evidence scopeと認証対象commandを固定する", () => {
    const fixture = readCertificationFixture();

    expect(fixture).toMatchObject({
      schemaVersion: 1,
      status: "certified",
      gate: "Gate 19",
      commandKinds: ["cfs-load", "cfs-unload"],
      printerType: "creality-k2",
      model: "F012",
      firmwareVersion: "1.0.0",
      attachment: "CFS",
      transportProfile: "k2-ws9999-feed-in-or-out-certified-v1",
    });
    expect(fixture.fixtureId).toBeTruthy();
    expect(fixture.captureId).toBeTruthy();
    expect(Number.isNaN(Date.parse(fixture.certifiedAt))).toBe(false);
    for (const commandKind of fixture.commandKinds) {
      expect(validateK2CfsSlotControlCertificationEvidence(fixture, commandKind, {
        printerType: "creality-k2",
        model: "F012",
        firmwareVersion: "1.0.0",
      })).toEqual({
        ok: true,
        errors: [],
      });
    }
  });

  it("1Aと1Bでload/unloadを各2回、単発送信かつblind retryなしで記録する", () => {
    const fixture = readCertificationFixture();
    const sourceIds = ["cfs:1:slot:0", "cfs:1:slot:1"];

    expect(fixture.operations).toHaveLength(8);
    expect(fixture.safety).toMatchObject({
      physicalCommandCount: 8,
      eachCommandSentOnce: true,
      blindRetryAllowed: false,
      printerIdleRequired: true,
      feedStateIdleRequired: true,
    });

    for (const sourceId of sourceIds) {
      const sourceOperations = fixture.operations.filter((operation) => operation.sourceId === sourceId);
      expect(sourceOperations.filter((operation) => operation.commandKind === "cfs-load")).toHaveLength(2);
      expect(sourceOperations.filter((operation) => operation.commandKind === "cfs-unload")).toHaveLength(2);
    }

    for (const operation of fixture.operations) {
      expect(operation.sentFrameCount).toBe(1);
      expect(operation.blindRetryAllowed).toBe(false);
      expect(operation.status).toBe("post-observed");
      expect(operation.operatorObservedPhysicalMotion).toBe(true);
      expect(operation.feedStateSequence.length).toBeGreaterThan(0);
    }
  });

  it("最終idle・no-error・CFS装填状態と物理目視確認を保存する", () => {
    const fixture = readCertificationFixture();

    expect(fixture.finalObservation).toEqual({
      printerIdle: true,
      errorFree: true,
      feedState: 0,
      selectedSourceIds: [],
      loadedSourceIds: ["cfs:1:slot:0", "cfs:1:slot:1"],
      nozzleFilamentRetracted: true,
      residualMotionOrNoise: false,
    });
    expect(fixture.operatorConfirmation).toMatchObject({
      result: "success",
      nozzleSetAndUnsetObserved: true,
      purgeGenerated: true,
      repeatedCycleCompleted: true,
    });
    expect(fixture.safety.excludedSources).toEqual(["cfs:1:slot:3", "external"]);
  });

  it("公開証跡へ実IP・MAC・hostnameを含めない", () => {
    const fixtureText = fs.readFileSync(FIXTURE_PATH, "utf8");

    expect(fixtureText).not.toMatch(RAW_DEVICE_IDENTIFIER_PATTERN);
    expect(fixtureText).not.toMatch(/(?:serial|ssid|credential|token)\s*[:=]/iu);
  });
});
