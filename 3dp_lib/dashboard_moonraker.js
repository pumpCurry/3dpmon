/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Moonraker(Fluidd/Klipper)プロトコルアダプタ モジュール
 * @file dashboard_moonraker.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_moonraker
 *
 * 【機能内容サマリ】
 * - Klipper + Moonraker 機(例: Ideaformer IR3 v2)を、既存の Creality K1 系
 *   データパイプライン(processData → storedData → UI)へ「翻訳」して流し込む
 *   薄いアダプタ層。
 * - Moonraker の JSON-RPC 2.0 over WebSocket (`/websocket`) を購読(subscribe)し、
 *   差分push される機器状態を K1 系の WS JSON と同じ形へ正規化する。
 * - 翻訳は純粋関数 {@link translateMoonrakerStatus} に分離し、ユニットテスト可能とする。
 *   WebSocket ライフサイクルは {@link createMoonrakerSession} が担う。
 *
 * 【設計方針(Phase 0 PoC)】
 * - 監視(読み取り)専用。操作(pause/resume/温度設定等)は後続フェーズ。
 * - 既存 K1 系コードには一切手を入れず、出力を K1 形 JSON に揃えることで
 *   下流(集計/台帳/通知/パネル)を無改修で再利用する。
 * - 進捗はファイル位置(virtual_sdcard)優先。IR3 はベルト(無限Z)機のため
 *   Z 基準のレイヤ推定が成立しない点に配慮している。
 *
 * 【公開関数一覧】
 * - {@link mapMoonrakerState}：Moonraker 状態文字列 → K1 数値状態コード
 * - {@link mergeMoonrakerStatus}：subscribe 差分を全体状態へマージ
 * - {@link translateMoonrakerStatus}：Moonraker 状態 → K1 形オブジェクトへ翻訳(純粋関数)
 * - {@link createMoonrakerSession}：WebSocket セッション(接続/購読/再接続)生成
 *
 * @version 1.390.1119 (PR #385)
 * @since   1.390.1119 (PR #385)
 * @lastModified 2026-06-16 21:00:00
 * -----------------------------------------------------------
 * @todo
 * - Phase 1: 履歴(server/history)/ファイル(server/files)取り込み、カメラ(webcams/list)URL対応
 * - Phase 2: belt 45°プレビュー、gcode ログタブ、per-type 操作/温調パネル、追加温度センサ(CAN/MCU/HOST)グラフ
 * - Phase 3: 操作系(printer.print.* / gcode.script / emergency_stop / 温度設定)の RPC 化
 * - 認証(API key / JWT)対応(現状の実機は login_required=false の前提)
 * - done(v1): live_position 実位置、レイヤー導出(meta+slicerZ)、残時間(estimated_time)高精度化
 */

import { PRINT_STATE_CODE } from "./dashboard_ui_mapping.js";

/**
 * 押出ノズル温度スライダ上限の既定値(機器 config 取得前のフォールバック)。
 * @constant {number}
 */
export const MOONRAKER_DEFAULT_MAX_NOZZLE = 300;

/**
 * ベッド温度スライダ上限の既定値(機器 config 取得前のフォールバック)。
 * @constant {number}
 */
export const MOONRAKER_DEFAULT_MAX_BED = 120;

/**
 * 再接続の上限回数(K1 系 connectWs と揃える)。
 * @constant {number}
 */
export const MOONRAKER_MAX_RECONNECT = 5;

/**
 * ベルト(無限Z)機と判定する Z 軸上限のしきい値(mm)。
 * 通常機の Z は数百mm。ベルト機は config で 99999 等の巨大値になる。
 * @constant {number}
 */
export const MOONRAKER_BELT_Z_THRESHOLD = 10000;

/**
 * Moonraker `printer.objects.subscribe` で購読する監視対象オブジェクト。
 * 値 `null` は「そのオブジェクトの全フィールド」を意味する(Moonraker 仕様)。
 *
 * @constant {Object<string, (null|string[])>}
 */
export const MOONRAKER_SUBSCRIBE_OBJECTS = {
  extruder: null,                                  // ノズル温度/目標
  heater_bed: null,                                // ベッド温度/目標
  print_stats: null,                               // 状態/経過/使用フィラメント/ファイル名
  display_status: null,                            // 進捗(0-1)
  virtual_sdcard: null,                            // ファイル位置進捗(0-1)
  // 座標フォールバック＋軸範囲(幾何判定)＋プリンタ制限(Fluidd Printer Limits ペイン相当)
  toolhead: ["position", "homed_axes", "axis_maximum", "axis_minimum",
             "max_velocity", "max_accel", "max_accel_to_decel", "square_corner_velocity"],
  // スライサZ(レイヤ算出)/速度係数(M220)/流量係数(M221)/実速度/Gコードオフセット(Z)
  gcode_move: ["gcode_position", "speed_factor", "extrude_factor", "speed", "homing_origin"],
  motion_report: ["live_position", "live_velocity"], // 実位置(プレビュー用・最頻更新)
  fan: ["speed"],                                  // モデルファン
  idle_timeout: ["state"],                         // Idle/Printing/Ready
  webhooks: ["state", "state_message"],            // Klippy 状態(ready/shutdown/error)
  "filament_motion_sensor encoder_sensor": ["enabled", "filament_detected"], // 材料検知
};

/**
 * 数値を小数2桁へ丸める(温度表示用)。非数値は null を返す。
 *
 * @private
 * @param {*} v - 入力値
 * @returns {?number} 丸めた数値、または null
 */
function _round2(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/**
 * 数値を整数へ丸める(速度/加速度の制限表示用)。非数値は null。
 * @private
 * @param {*} v - 入力値
 * @returns {?number} 丸めた整数、または null
 */
function _round0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * 数値を小数3桁へ丸める(pressure_advance 等の微小値表示用)。非数値は null。
 * @private
 * @param {*} v - 入力値
 * @returns {?number} 丸めた数値、または null
 */
function _round3(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

/**
 * Moonraker(Klipper)の状態文字列を、ダッシュボード内部の K1 数値状態コードへ写像する。
 *
 * 【詳細説明】
 * - Klippy 自体が `ready` 以外(shutdown/error/startup)の場合は機器異常とみなし
 *   printFailed(=4)を返して UI 上で異常を可視化する。
 * - 印刷状態は print_stats.state の文字列を K1 の {@link PRINT_STATE_CODE} に対応づける。
 *   cancelled / error は K1 に対応コードが無いため printFailed(=4)へ寄せる。
 *
 * @function mapMoonrakerState
 * @param {string} printState  - print_stats.state("standby"|"printing"|"paused"|"complete"|"cancelled"|"error")
 * @param {string} [klippyState] - webhooks.state("ready"|"startup"|"shutdown"|"error")
 * @returns {number} K1 数値状態コード(0:停止 1:印刷中 2:正常終了 4:失敗 5:一時停止)
 * @example
 * mapMoonrakerState("printing", "ready"); // → 1
 * mapMoonrakerState("complete", "ready"); // → 2
 * mapMoonrakerState("standby", "shutdown"); // → 4
 */
export function mapMoonrakerState(printState, klippyState) {
  if (klippyState && klippyState !== "ready") {
    // Klippy 異常(shutdown/error/startup)→ 失敗扱いで可視化
    return PRINT_STATE_CODE.printFailed;
  }
  switch (printState) {
    case "printing":  return PRINT_STATE_CODE.printStarted; // 1
    case "paused":    return PRINT_STATE_CODE.printPaused;  // 5
    case "complete":  return PRINT_STATE_CODE.printDone;    // 2
    case "cancelled": return PRINT_STATE_CODE.printFailed;  // 4
    case "error":     return PRINT_STATE_CODE.printFailed;  // 4
    case "standby":
    default:          return PRINT_STATE_CODE.printIdle;    // 0
  }
}

/**
 * Moonraker の subscribe 差分(notify_status_update)を、保持している全体状態へ
 * マージする。Moonraker の status は「オブジェクト名 → フィールド辞書」の2階層
 * 構造であり、差分は変更されたフィールドのみを含むため、オブジェクト単位で
 * 浅いマージ(Object.assign)を行う。
 *
 * @function mergeMoonrakerStatus
 * @param {Object} target  - マージ先(累積している全体状態。破壊的に更新する)
 * @param {Object} partial - 受信した差分(または初期スナップショット)
 * @returns {Object} マージ後の target(同一参照)
 * @example
 * const acc = {};
 * mergeMoonrakerStatus(acc, { extruder: { temperature: 200 } });
 * mergeMoonrakerStatus(acc, { extruder: { target: 210 } });
 * // acc.extruder === { temperature: 200, target: 210 }
 */
export function mergeMoonrakerStatus(target, partial) {
  if (!partial || typeof partial !== "object") return target;
  for (const [key, val] of Object.entries(partial)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const base = (target[key] && typeof target[key] === "object" && !Array.isArray(target[key]))
        ? target[key]
        : {};
      target[key] = Object.assign(base, val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

/**
 * Moonraker の累積状態を、K1 系 WS JSON と同じ形のオブジェクトへ翻訳する(純粋関数)。
 *
 * 【詳細説明】
 * - 返値は {@link processData} がそのまま解釈できるよう、K1 のキー名・単位・状態コードに
 *   揃える(例: nozzleTemp/bedTemp0/printProgress[0-100]/state[数値]/usedMaterialLength[mm])。
 * - 進捗は virtual_sdcard.progress(ファイル位置)優先、無ければ display_status.progress。
 * - 残時間(printLeftTime)は Moonraker がネイティブに持たないため、ファイル進捗からの
 *   線形推定(Fluidd の file 方式)で算出する。0 進捗時は null(算出不能)。
 * - ジョブID(printStartTime, epoch秒)は Moonraker が開始 epoch を返さないため、
 *   印刷検知時に `now - print_duration` で安定IDを確定し、ファイル名が変わるまで維持する。
 *   ctx.job を破壊的に更新する点に注意(セッション内で状態を引き継ぐため)。
 * - 座標は parseCurPosition が解釈できる "X: .. Y: .. Z: .." 文字列を生成する。
 *
 * @function translateMoonrakerStatus
 * @param {Object} status - 累積済み Moonraker status(mergeMoonrakerStatus の結果)
 * @param {MoonrakerTranslateContext} ctx - 翻訳コンテキスト(hostname/最大温度/ジョブ状態)
 * @param {number} nowMs - 現在時刻(Date.now() 相当, ミリ秒)。テスト容易性のため引数化
 * @returns {Object} K1 形に正規化したデータオブジェクト
 *
 * @typedef {Object} MoonrakerGcodeMeta
 * @property {?number} estimatedTime    - スライサ見積り総時間(秒)
 * @property {?number} objectHeight     - 造形高さ(mm)
 * @property {?number} layerHeight      - レイヤー高さ(mm)
 * @property {?number} firstLayerHeight - 初層高さ(mm)
 * @property {?number} [layerCount]     - 総レイヤー数(スライサが供給する場合)
 *
 * @typedef {Object} MoonrakerTranslateContext
 * @property {string}  hostname        - 機器ホスト名(routing キー)
 * @property {number} [maxNozzleTemp]  - ノズル温度上限(config 由来)
 * @property {number} [maxBedTemp]     - ベッド温度上限(config 由来)
 * @property {?MoonrakerGcodeMeta} [meta] - 現在ファイルの gcode メタ(残時間/レイヤー算出に使用)
 * @property {{startEpoch:?number, filename:?string}} job - セッション内ジョブ状態(破壊的更新)
 *
 * @example
 * const ctx = { hostname: "Ideaformer", maxNozzleTemp: 310, maxBedTemp: 90, job: { startEpoch: null, filename: null } };
 * const k1 = translateMoonrakerStatus(merged, ctx, Date.now());
 * // k1.nozzleTemp, k1.printProgress, k1.state ... が K1 形で得られる
 */
export function translateMoonrakerStatus(status, ctx, nowMs) {
  const s   = status || {};
  const ext = s.extruder || {};
  const bed = s.heater_bed || {};
  const ps  = s.print_stats || {};
  const ds  = s.display_status || {};
  const vsd = s.virtual_sdcard || {};
  const gm  = s.gcode_move || {};
  const th  = s.toolhead || {};
  const mr  = s.motion_report || {};
  const fan = s.fan || {};
  const wh  = s.webhooks || {};
  const fms = s["filament_motion_sensor encoder_sensor"] || {};

  const klippyState = wh.state;       // "ready" | "shutdown" | "error" | "startup"
  const printState  = ps.state;       // "standby" | "printing" | ...
  const stateCode   = mapMoonrakerState(printState, klippyState);

  // --- 進捗(0-1)→ K1 の 0-100 ----------------------------------------------
  // ベルト(無限Z)機のため Z 基準は使わず、ファイル位置(virtual_sdcard)を最優先。
  const progressFrac = (typeof vsd.progress === "number") ? vsd.progress
                     : (typeof ds.progress === "number")  ? ds.progress
                     : null;
  const printProgress = progressFrac != null ? Math.round(progressFrac * 100) : 0;

  // --- 経過時間(秒) ---------------------------------------------------------
  const printDuration = Number(ps.print_duration || 0);

  // --- ジョブID(printStartTime, epoch秒) -----------------------------------
  // 印刷/一時停止中はジョブが進行中。ファイル名が変わるか未確定なら確定し直す。
  const nowSec   = Math.floor((Number(nowMs) || 0) / 1000);
  const filename = ps.filename || "";
  if (!ctx.job) ctx.job = { startEpoch: null, filename: null };
  if (printState === "printing" || printState === "paused") {
    if (!ctx.job.startEpoch || ctx.job.filename !== filename) {
      // now - 経過 で開始時刻を逆算(安定したジョブIDとして利用)
      ctx.job.startEpoch = Math.max(1, nowSec - Math.round(printDuration));
      ctx.job.filename   = filename;
    }
  }
  // 完了/失敗時は直近のジョブIDを維持(履歴登録で同一IDを使うため)。
  const printStartTime = ctx.job.startEpoch || 0;

  // --- 残時間(秒) -----------------------------------------------------------
  // スライサ見積り(metadata.estimated_time)があればそれを優先（より安定）、
  // 無い/超過時はファイル進捗からの線形推定にフォールバックする（Fluidd の file 方式）。
  const meta = ctx.meta || null;
  let printLeftTime = null;
  if (meta && Number(meta.estimatedTime) > 0) {
    printLeftTime = Math.round(Number(meta.estimatedTime) - printDuration);
  }
  if ((printLeftTime == null || printLeftTime <= 0)
      && progressFrac && progressFrac > 0.001 && printDuration > 0) {
    const totalEst = printDuration / progressFrac;
    printLeftTime  = Math.round(totalEst - printDuration);
  }
  if (printLeftTime != null) printLeftTime = Math.max(0, printLeftTime);

  // --- 座標 "X: .. Y: .. Z: .." (parseCurPosition 互換) ----------------------
  // プレビューには実位置 motion_report.live_position を最優先（最も実機に追従）。
  // 無ければ gcode_move.gcode_position → toolhead.position の順でフォールバック。
  // ※ live_position の Z はベルト機ではベルト軸の実座標（高さではない）。
  const pos = Array.isArray(mr.live_position) ? mr.live_position
            : Array.isArray(gm.gcode_position) ? gm.gcode_position
            : Array.isArray(th.position)       ? th.position
            : null;
  let curPosition = null;
  if (pos && pos.length >= 3
      && Number.isFinite(Number(pos[0]))
      && Number.isFinite(Number(pos[1]))
      && Number.isFinite(Number(pos[2]))) {
    curPosition = `X: ${Number(pos[0]).toFixed(2)} Y: ${Number(pos[1]).toFixed(2)} Z: ${Number(pos[2]).toFixed(2)}`;
  }

  // --- レイヤー(導出) -------------------------------------------------------
  // print_stats.info.{current,total}_layer はこのファームでは null のため、Fluidd と
  // 同じく gcode メタ + スライサZ(gcode_move.gcode_position[2]) から算出する。
  //   総レイヤー = ceil((object_height - first_layer_height) / layer_height) + 1
  //   現在レイヤー = ceil((slicerZ - first_layer_height) / layer_height) + 1  (0..total にクランプ)
  // ※ レイヤーには「スライサZ」を使う。実位置(キネマティックZ=ベルト軸)とは別物。
  let layerTotal = null;
  let layerCurrent = null;
  // ファーム側が将来 info を埋める場合はそれを最優先する。
  const psInfo = ps.info || {};
  if (Number.isFinite(Number(psInfo.total_layer)) && Number(psInfo.total_layer) > 0) {
    layerTotal = Number(psInfo.total_layer);
  }
  if (Number.isFinite(Number(psInfo.current_layer))) {
    layerCurrent = Number(psInfo.current_layer);
  }
  // スライサが layer_count を埋めていれば総レイヤーはそれを最優先(最も正確)
  if (layerTotal == null && meta && Number(meta.layerCount) > 0) {
    layerTotal = Number(meta.layerCount);
  }
  if (meta && Number(meta.objectHeight) > 0 && Number(meta.layerHeight) > 0) {
    const lh  = Number(meta.layerHeight);
    const flh = Number.isFinite(Number(meta.firstLayerHeight)) ? Number(meta.firstLayerHeight) : lh;
    if (layerTotal == null) {
      layerTotal = Math.ceil((Number(meta.objectHeight) - flh) / lh) + 1;
    }
    const slicerZ = Array.isArray(gm.gcode_position) ? Number(gm.gcode_position[2]) : NaN;
    if (layerCurrent == null && Number.isFinite(slicerZ)) {
      // 完了レイヤー数は round で求める(浮動小数の境界での±1ブレを回避)。
      // 現在レイヤー = 完了数 + 1、[0, total] にクランプ。
      const c = Math.round((slicerZ - flh) / lh) + 1;
      layerCurrent = Math.min(layerTotal, Math.max(0, c));
    }
  }

  // --- ファン --------------------------------------------------------------
  const fanSpeed = Number(fan.speed || 0);

  /** @type {Object} K1 形に正規化した出力 */
  const out = {
    hostname: ctx.hostname,

    // 状態(数値コード)
    state: stateCode,
    printState: stateCode,

    // 温度
    nozzleTemp: _round2(ext.temperature),
    targetNozzleTemp: _round2(ext.target),
    maxNozzleTemp: ctx.maxNozzleTemp || MOONRAKER_DEFAULT_MAX_NOZZLE,
    bedTemp0: _round2(bed.temperature),
    targetBedTemp0: _round2(bed.target),
    maxBedTemp: ctx.maxBedTemp || MOONRAKER_DEFAULT_MAX_BED,

    // 進捗/時間
    printProgress: printProgress,
    printJobTime: Math.round(printDuration),
    printLeftTime: printLeftTime,
    printStartTime: printStartTime,

    // ファイル
    printFileName: filename,

    // 材料(mm)
    usedMaterialLength: Math.round(Number(ps.filament_used || 0)),

    // ファン(ON/OFF と %)
    fan: fanSpeed > 0 ? 1 : 0,
    modelFanPct: Math.round(fanSpeed * 100),
  };

  // 座標は取得できたときのみ付与(parseCurPosition で X/Y/Z に分解される)
  if (curPosition) out.curPosition = curPosition;

  // レイヤー(導出できたときのみ付与)。dashboardMapping の layer / TotalLayer に対応。
  if (layerTotal != null) out.TotalLayer = layerTotal;
  if (layerCurrent != null) out.layer = layerCurrent;

  // --- 速度/流量 係数(Fluidd Tool ペイン相当・既存 K1 制御UIへ流用) ----------
  // gcode_move.speed_factor=M220, extrude_factor=M221（1.0=100%）。
  // 既存の curFeedratePct/curFlowratePct(印刷速度/フロー率スライダ)へそのまま反映。
  if (Number.isFinite(Number(gm.speed_factor)))   out.curFeedratePct = Math.round(Number(gm.speed_factor) * 100);
  if (Number.isFinite(Number(gm.extrude_factor))) out.curFlowratePct = Math.round(Number(gm.extrude_factor) * 100);

  // --- プリンタ制限(Fluidd Printer Limits ペイン相当・機器情報テーブルへ表示) ----
  // 既存 K1 フィールド(accelerationLimits/velocityLimits/...)は NO_PROCESSING=生文字列表示。
  if (Number.isFinite(Number(th.max_velocity)))           out.velocityLimits       = `${_round0(th.max_velocity)} mm/s`;
  if (Number.isFinite(Number(th.max_accel)))              out.accelerationLimits   = `${_round0(th.max_accel)} mm/s²`;
  if (Number.isFinite(Number(th.square_corner_velocity))) out.cornerVelocityLimits = `${_round2(th.square_corner_velocity)} mm/s`;
  if (Number.isFinite(Number(th.max_accel_to_decel)))     out.accelToDecelLimits   = `${_round0(th.max_accel_to_decel)} mm/s²`;
  if (Number.isFinite(Number(ext.pressure_advance)))      out.pressureAdvance      = `${_round3(ext.pressure_advance)} s`;
  // リアルタイム速度(実速度 mm/s): motion_report.live_velocity 優先、無ければ gcode_move.speed
  const liveVel = Number.isFinite(Number(mr.live_velocity)) ? Number(mr.live_velocity)
                : Number.isFinite(Number(gm.speed)) ? Number(gm.speed) : null;
  if (liveVel != null) out.realTimeSpeed = `${_round0(liveVel)} mm/s`;

  // 材料検知センサ(エンコーダ)が有効なときのみ materialStatus を反映
  //   0:材料OK / 1:材料切れNG (K1 の MATERIAL_STATUS_MAP に合わせる)
  if (fms && fms.enabled === true && typeof fms.filament_detected === "boolean") {
    out.materialStatus = fms.filament_detected ? 0 : 1;
  }

  // 完了時は終了時刻(epoch秒)を付与(履歴の見栄え用)
  if (stateCode === PRINT_STATE_CODE.printDone) {
    out.printFinishTime = nowSec;
  }

  // Klippy 異常時はエラー状況へ反映(errorStatus パネル表示用)
  if (klippyState && klippyState !== "ready") {
    out.err = { errcode: 1, key: 0 };
  }

  // --- 幾何(ベルト機/非正方ベッド) ------------------------------------------
  // toolhead.axis_maximum から判定。Z 上限が極端に大きい(無限)= ベルト機。
  // beltGeometry はオブジェクトのため processData のバルク反映から除外され、
  // setStageGeometry へ明示転送される。model は機器情報パネル表示用の文字列。
  const am = th.axis_maximum;
  if (Array.isArray(am) && am.length >= 3) {
    const zMax = Number(am[2]);
    const belt = Number.isFinite(zMax) && zMax >= MOONRAKER_BELT_Z_THRESHOLD;
    out.beltGeometry = {
      belt,
      sizeX: Number.isFinite(Number(am[0])) && Number(am[0]) > 0 ? Number(am[0]) : 0,
      sizeY: Number.isFinite(Number(am[1])) && Number(am[1]) > 0 ? Number(am[1]) : 0,
      zMax: belt ? null : (Number.isFinite(zMax) ? zMax : null),
    };
    out.model = belt ? "Klipper (belt)" : "Klipper";
  }

  return out;
}

/* ==========================================================================
 * 履歴 / ファイル一覧の変換(Moonraker REST/RPC → K1 形)
 * ======================================================================== */

/**
 * Moonraker のサムネイル配列から最大サイズのものを選ぶ。
 *
 * @function pickLargestThumbnail
 * @param {Array<{width:number,relative_path:string}>} thumbnails - metadata.thumbnails
 * @returns {?{width:number,relative_path:string}} 最大サムネ、無ければ null
 */
export function pickLargestThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  return thumbnails.reduce((a, b) => (Number(b?.width || 0) > Number(a?.width || 0) ? b : a));
}

/**
 * Moonraker のサムネイル相対パスから完全な画像URLを組み立てる。
 * relative_path は gcode ファイルのあるディレクトリからの相対パス。
 *
 * @function buildMoonrakerThumbUrl
 * @param {string} httpBase     - "http://IP:PORT"
 * @param {string} gcodeFilename - gcodes ルートからの相対ファイルパス
 * @param {string} relativePath  - thumbnail.relative_path
 * @returns {string} 完全なサムネイルURL(組み立て不能時は空文字)
 */
export function buildMoonrakerThumbUrl(httpBase, gcodeFilename, relativePath) {
  if (!httpBase || !relativePath) return "";
  const fn = String(gcodeFilename || "");
  const dir = fn.includes("/") ? fn.slice(0, fn.lastIndexOf("/") + 1) : "";
  const path = dir + relativePath;
  return `${httpBase}/server/files/gcodes/${path}`;
}

/**
 * Moonraker のカメラ stream_url / snapshot_url を絶対URLへ解決する。
 *
 * Moonraker/Fluidd のカメラURLは機器・構成依存で可変（例 IR3 v2 は相対
 * "/webcam/?action=stream" を nginx(80) が crowsnest へプロキシ）。K1 の固定
 * "ip:8080/?action=stream" とは別。相対パスは httpBase 起点、絶対(http...)は
 * そのまま返す。
 *
 * @function buildMoonrakerCameraUrl
 * @param {string} camUrl   - webcams[].stream_url / snapshot_url
 * @param {string} httpBase - "http://IP:PORT"（相対URL解決の起点）
 * @returns {string} 絶対URL（解決不能なら空文字）
 */
export function buildMoonrakerCameraUrl(camUrl, httpBase) {
  const u = String(camUrl || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  const base = String(httpBase || "").replace(/\/+$/, "");
  if (!base) return "";
  return u.startsWith("/") ? base + u : base + "/" + u;
}

/**
 * Moonraker `server.webcams.list` の結果を、表示用カメラ配列へ正規化する。
 * 無効(enabled:false)カメラと stream_url 解決不能なものは除外する。
 *
 * @function moonrakerWebcamsToList
 * @param {Object|Array} result - server.webcams.list の result（{webcams:[...]} か配列）
 * @param {string} httpBase     - "http://IP:PORT"
 * @returns {Array<{name:string, streamUrl:string, snapshotUrl:string}>}
 */
export function moonrakerWebcamsToList(result, httpBase) {
  const cams = Array.isArray(result?.webcams) ? result.webcams
             : (Array.isArray(result) ? result : []);
  return cams
    .filter((c) => c && c.enabled !== false)
    .map((c) => ({
      name: c.name || c.location || "camera",
      streamUrl: buildMoonrakerCameraUrl(c.stream_url, httpBase),
      snapshotUrl: buildMoonrakerCameraUrl(c.snapshot_url, httpBase),
    }))
    .filter((c) => c.streamUrl);
}

/**
 * Moonraker `server.history.list` のジョブ配列を、K1 の生履歴エントリ配列へ変換する。
 * 進行中(in_progress)ジョブは現在ジョブとしてライブ状態側で扱うため除外する。
 *
 * @function moonrakerHistoryToK1
 * @param {Array<Object>} jobs - server.history.list の result.jobs
 * @param {string} httpBase    - サムネイル用 "http://IP:PORT"
 * @returns {Array<Object>} parseRawHistoryEntry が解釈できる生履歴エントリ配列
 */
export function moonrakerHistoryToK1(jobs, httpBase) {
  if (!Array.isArray(jobs)) return [];
  return jobs
    .filter((j) => j && j.status !== "in_progress" && Number.isFinite(Number(j.start_time)))
    .map((j) => {
      const md = j.metadata || {};
      const thumb = pickLargestThumbnail(md.thumbnails);
      const thumbUrl = thumb ? buildMoonrakerThumbUrl(httpBase, j.filename, thumb.relative_path) : "";
      // 状態: completed → 成功(1) / それ以外(cancelled/error/klippy_*) → 失敗(0)
      const printfinish = j.status === "completed" ? 1 : 0;
      return {
        id: Math.floor(Number(j.start_time)),
        filename: j.filename,
        starttime: Math.floor(Number(j.start_time)),
        usagetime: Math.round(Number(j.print_duration || 0)),
        usagematerial: Math.round(Number(j.filament_used || 0)),
        printfinish,
        size: Number(md.size || 0) || undefined,
        thumbUrl,
        filamentType: md.filament_type || undefined,
        // ★ A: Moonraker のネイティブ ID を内部保持する（printId は start_time のまま）。
        //   制御は現在ジョブ対象でID不要だが、将来 server.history 個別操作(uid=job_id)に
        //   備えて実IDを保持。表示・dedup・フィラメント帰属には使わない。
        moonrakerJobId: j.job_id != null ? String(j.job_id) : undefined,
      };
    });
}

/**
 * Moonraker のファイル一覧＋メタ情報を、renderFileList が受け取れる解析済みエントリ配列へ変換する。
 * mtime は Date オブジェクトで返す(JSON を経由せず直接コールバックで渡す前提)。
 *
 * @function moonrakerFilesToEntries
 * @param {Array<{path:string,size:number,modified:number}>} files - server.files.list の結果
 * @param {Object<string,Object>} metaMap - path → server.files.metadata 結果
 * @param {string} httpBase - サムネイル用 "http://IP:PORT"
 * @returns {Array<Object>} renderFileList の entries 用配列
 */
export function moonrakerFilesToEntries(files, metaMap, httpBase) {
  if (!Array.isArray(files)) return [];
  const metas = metaMap || {};
  return files.map((f, i) => {
    const meta = metas[f.path] || {};
    const thumb = pickLargestThumbnail(meta.thumbnails);
    const thumbUrl = thumb ? buildMoonrakerThumbUrl(httpBase, f.path, thumb.relative_path) : "";
    // 総レイヤー: layer_count 優先、無ければ高さ/層厚から導出
    let layer = 0;
    if (Number.isFinite(Number(meta.layer_count)) && Number(meta.layer_count) > 0) {
      layer = Number(meta.layer_count);
    } else if (Number(meta.object_height) > 0 && Number(meta.layer_height) > 0) {
      const flh = Number.isFinite(Number(meta.first_layer_height)) ? Number(meta.first_layer_height) : Number(meta.layer_height);
      layer = Math.ceil((Number(meta.object_height) - flh) / Number(meta.layer_height)) + 1;
    }
    const estSec = Number.isFinite(Number(meta.estimated_time)) ? Math.round(Number(meta.estimated_time)) : 0;
    const filamentMm = Number.isFinite(Number(meta.filament_total)) ? Number(meta.filament_total) : null;
    return {
      number: i + 1,
      basename: String(f.path || "").split("/").pop(),
      size: Number(f.size || 0),
      layer: Number(layer || 0),
      mtime: new Date(Number(f.modified || 0) * 1000),
      expect: filamentMm != null ? filamentMm : null,
      thumbUrl,
      filename: f.path,            // gcodes ルートからの相対パス(印刷コマンドで使用)
      usagetime: estSec,
      usagematerial: filamentMm != null ? Math.round(filamentMm) : 0,
      filemd5: "",
      printCount: 0,
      _gcodeMeta: estSec ? { timeSec: estSec, layers: String(layer || ""), filamentMm } : undefined,
    };
  });
}

/* ==========================================================================
 * 操作コマンドの変換(K1 コマンド意図 → Moonraker RPC / gcode)
 * ======================================================================== */

/**
 * K1 系の操作コマンド(sendCommand の method/params)を、Moonraker で実行する
 * 一連の手順へ変換する。各手順は gcode 実行 か JSON-RPC 呼び出しのいずれか。
 *
 * 【詳細説明】
 * - 戻り値は手順配列。`{gcode:"..."}` は `printer.gcode.script` で実行、
 *   `{rpc:"method", params:{...}}` はその RPC をそのまま呼ぶ。
 * - 対応しない操作(K1 専用トグルや get 系の取得要求など)は空配列を返す。
 *   呼び出し側はログを出して no-op とする。
 *
 * @function translateK1CommandToMoonraker
 * @param {string} method - K1 コマンド名("set"/"print"/"autoHome"/"runGcode" 等)
 * @param {Object} [params] - K1 パラメータ
 * @returns {Array<({gcode:string}|{rpc:string,params:Object})>} 実行手順(未対応は [])
 */
export function translateK1CommandToMoonraker(method, params = {}) {
  const p = params || {};
  const round = (v) => Math.round(Number(v) || 0);

  switch (method) {
    case "print":
      return p.file ? [{ rpc: "printer.print.start", params: { filename: String(p.file) } }] : [];

    case "autoHome":
      return [{ gcode: "G28" }];

    case "autoLevel":
      // ベッドメッシュ較正(ホーム後)。機種により BED_MESH_CALIBRATE が標準。
      return [{ gcode: "G28" }, { gcode: "BED_MESH_CALIBRATE" }];

    case "runGcode":
      return p.cmd ? [{ gcode: String(p.cmd) }] : [];

    case "deleteFile":
      return p.path
        ? [{ rpc: "server.files.delete_file", params: { path: `gcodes/${String(p.path).replace(/^gcodes\//, "")}` } }]
        : [];

    case "set": {
      if ("stop" in p) return [{ rpc: "printer.print.cancel", params: {} }];
      if ("pause" in p) {
        return p.pause
          ? [{ rpc: "printer.print.pause", params: {} }]
          : [{ rpc: "printer.print.resume", params: {} }];
      }
      if ("gcodeCmd" in p && p.gcodeCmd) return [{ gcode: String(p.gcodeCmd) }];
      if ("nozzleTempControl" in p) return [{ gcode: `M104 S${round(p.nozzleTempControl)}` }];
      if ("targetNozzleTemp" in p) return [{ gcode: `M104 S${round(p.targetNozzleTemp)}` }];
      if ("bedTempControl" in p) return [{ gcode: `M140 S${round(p.bedTempControl?.val)}` }];
      if ("targetBedTemp0" in p) return [{ gcode: `M140 S${round(p.targetBedTemp0)}` }];
      if ("fan" in p) return [{ gcode: `M106 S${p.fan ? 255 : 0}` }];
      // 印刷速度(M220)/フロー率(M221): 既存UIは setFeedratePct / curFlowratePct で送る
      if ("setFeedratePct" in p) return [{ gcode: `M220 S${round(p.setFeedratePct)}` }];
      if ("curFeedratePct" in p) return [{ gcode: `M220 S${round(p.curFeedratePct)}` }];
      if ("setFlowratePct" in p) return [{ gcode: `M221 S${round(p.setFlowratePct)}` }];
      if ("curFlowratePct" in p) return [{ gcode: `M221 S${round(p.curFlowratePct)}` }];
      // 速度制限(Fluidd Printer Limits): SET_VELOCITY_LIMIT
      if ("velocityLimit" in p)      return [{ gcode: `SET_VELOCITY_LIMIT VELOCITY=${round(p.velocityLimit)}` }];
      if ("accelLimit" in p)         return [{ gcode: `SET_VELOCITY_LIMIT ACCEL=${round(p.accelLimit)}` }];
      if ("squareCornerVelocity" in p) return [{ gcode: `SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=${Number(p.squareCornerVelocity) || 0}` }];
      // cleanErr / K1専用トグル(fanCase/fanAuxiliary/lightSw/ai*)等は未対応
      return [];
    }

    // get(reqHistory/reqGcodeFile/状態取得)は Moonraker では購読/自動取得のため不要
    case "get":
    default:
      return [];
  }
}

/**
 * Moonraker WebSocket セッションを生成し、接続・購読・再接続を管理する。
 *
 * 【詳細説明】
 * - `ws://host/websocket`(または wss)へ接続し、JSON-RPC 2.0 で
 *   `printer.info`(ホスト名取得)→ `printer.objects.query configfile`(温度上限)→
 *   `printer.objects.subscribe`(状態購読)の順に初期化する。
 * - 初期スナップショットおよび `notify_status_update` を受信するたびに
 *   {@link mergeMoonrakerStatus} で全体状態を更新し、{@link translateMoonrakerStatus}
 *   で K1 形へ翻訳して `onData` コールバックに渡す。
 * - 切断時は指数バックオフで再接続する(`shouldReconnect` が true かつ上限未満のとき)。
 *   生 WebSocket は呼び出し側(connection.js)の ConnectionState には載せない設計のため、
 *   再接続はこのセッション内で完結させる。
 *
 * @function createMoonrakerSession
 * @param {Object} opts - セッション設定
 * @param {string} opts.url - 接続先 WebSocket URL("ws://IP:PORT/websocket")
 * @param {string} opts.fallbackHost - printer.info 失敗時に使うホスト名(通常 IP)
 * @param {function(string, string=):void} opts.onLog - ログ出力 (message, level)
 * @param {function("connecting"|"connected"|"waiting"|"disconnected"):void} opts.onState - 状態通知
 * @param {function(Object):void} opts.onData - 翻訳済み K1 形データの通知
 * @param {function(Object, string):void} [opts.onAux] - 履歴/ファイル一覧の通知
 *   (aux: {historyList?, fileEntries?, fileTotal?}, resolvedHost) を渡す。
 *   Date 等を保つため JSON を経由せず直接渡す。
 * @param {function(string, string):void} [opts.onGcode] - gcode コンソール行 (line, resolvedHost)
 * @param {string} [opts.httpBase] - サムネイル/ファイル取得用 "http://IP:PORT"
 * @param {function():boolean} opts.shouldReconnect - 再接続を許可するか判定する述語
 * @returns {{close: function():void, request: function(string, Object=):Promise<*>}}
 *   セッションハンドル(close で明示停止 / request で任意 RPC 実行)
 */
export function createMoonrakerSession(opts) {
  const {
    url,
    fallbackHost,
    onLog = () => {},
    onState = () => {},
    onData = () => {},
    onAux = () => {},
    onGcode = () => {},
    httpBase = "",
    shouldReconnect = () => false,
  } = opts || {};

  /** @type {MoonrakerTranslateContext} 翻訳コンテキスト(再接続後も維持) */
  const ctx = {
    hostname: fallbackHost,
    maxNozzleTemp: MOONRAKER_DEFAULT_MAX_NOZZLE,
    maxBedTemp: MOONRAKER_DEFAULT_MAX_BED,
    job: { startEpoch: null, filename: null },
  };

  /** @type {Object} 累積している Moonraker 全体状態 */
  let accStatus = {};
  /** @type {?string} 直近で gcode メタを取得済みのファイル名(再取得抑止) */
  let lastMetaFile = null;
  /** @type {WebSocket|null} */
  let ws = null;
  /** @type {boolean} close() による明示停止フラグ */
  let closed = false;
  /** @type {number} 再接続試行回数 */
  let reconnectCount = 0;
  /** @type {number|null} 再接続タイマー */
  let retryTimer = null;
  /** @type {number} JSON-RPC id 採番カウンタ */
  let rpcId = 0;

  /** RPC id → 用途("info"|"config"|"subscribe"|"meta") の対応 */
  const pending = new Map();

  /**
   * JSON-RPC リクエストを送信する。
   * @private
   * @param {string} method - メソッド名
   * @param {Object} params - パラメータ
   * @param {string} [tag]  - 応答識別タグ
   * @returns {void}
   */
  const send = (method, params, tag) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const id = ++rpcId;
    if (tag) pending.set(id, tag);
    try {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    } catch (e) {
      onLog(`[moonraker] 送信失敗: ${e.message}`, "error");
    }
  };

  /** RPC id → {resolve, reject}(Promise ベースの一発リクエスト用) */
  const pendingRpc = new Map();

  /**
   * JSON-RPC を Promise で投げる(履歴/ファイル取得などの取得系に使用)。
   * @private
   * @param {string} method - メソッド名
   * @param {Object} [params] - パラメータ
   * @returns {Promise<*>} result
   */
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error("ws not open")); return; }
    const id = ++rpcId;
    pendingRpc.set(id, { resolve, reject });
    try {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    } catch (e) {
      pendingRpc.delete(id);
      reject(e);
    }
  });

  /**
   * 現在の累積状態を翻訳して onData に渡す。
   * @private
   * @returns {void}
   */
  const emit = () => {
    try {
      const k1 = translateMoonrakerStatus(accStatus, ctx, Date.now());
      onData(k1);
    } catch (e) {
      onLog(`[moonraker] 翻訳エラー: ${e.message}`, "error");
    }
  };

  /**
   * 現在印刷中ファイルが変わったら gcode メタ(残時間/レイヤー算出用)を取得する。
   * ファイル名が変化したときのみ RPC を投げ、同一ファイルでは再取得しない。
   * @private
   * @returns {void}
   */
  const maybeFetchMeta = () => {
    const fn = accStatus.print_stats?.filename || "";
    if (!fn) return;
    if (fn === lastMetaFile) return;
    lastMetaFile = fn;
    ctx.meta = null; // 旧メタを破棄(取得完了まで線形推定にフォールバック)
    send("server.files.metadata", { filename: fn }, "meta");
  };

  /** ファイルメタ取得の上限(大量ファイル時の RPC 過多を防ぐ) */
  const FILE_META_CAP = 80;

  /**
   * 印刷履歴(server.history.list)を取得して K1 形へ変換し onAux 経由で通知する。
   * 進行中ジョブの開始 epoch をライブのジョブIDへ同期して、履歴と現在ジョブのIDを一致させる。
   * @private
   * @returns {Promise<void>}
   */
  const fetchHistory = async () => {
    try {
      const res = await rpc("server.history.list", { limit: 100, order: "desc" });
      const jobs = res?.jobs || [];
      // 進行中ジョブの start_time をライブのジョブIDに採用(履歴と現在ジョブのID整合)
      const inprog = jobs.find((j) => j && j.status === "in_progress" && Number.isFinite(Number(j.start_time)));
      if (inprog) ctx.job.startEpoch = Math.floor(Number(inprog.start_time));
      const historyList = moonrakerHistoryToK1(jobs, httpBase);
      onAux({ historyList }, ctx.hostname);
      onLog(`[moonraker] 履歴 ${historyList.length} 件を取得`, "info");
    } catch (e) {
      onLog(`[moonraker] 履歴取得失敗: ${e.message}`, "warn");
    }
  };

  /**
   * gcode ファイル一覧(server.files.list)＋各メタ情報を取得し、解析済みエントリへ変換して通知する。
   * @private
   * @returns {Promise<void>}
   */
  const fetchFiles = async () => {
    try {
      const res = await rpc("server.files.list", { root: "gcodes" });
      const files = Array.isArray(res) ? res : (res?.files || []);
      const capped = files.slice(0, FILE_META_CAP);
      const metaMap = {};
      for (const f of capped) {
        try { metaMap[f.path] = await rpc("server.files.metadata", { filename: f.path }); }
        catch { /* 個別メタ失敗は無視(名前/サイズのみで描画) */ }
      }
      const fileEntries = moonrakerFilesToEntries(capped, metaMap, httpBase);
      onAux({ fileEntries, fileTotal: files.length }, ctx.hostname);
      onLog(`[moonraker] ファイル ${fileEntries.length}/${files.length} 件を取得`, "info");
    } catch (e) {
      onLog(`[moonraker] ファイル一覧取得失敗: ${e.message}`, "warn");
    }
  };

  /**
   * カメラ一覧(server.webcams.list)を取得し、絶対URLへ解決して onAux 経由で通知する。
   * K1 の固定URLと異なり Moonraker のカメラURLは可変なので機器申告値を使う(IR3 v2 対応)。
   * @private
   * @returns {Promise<void>}
   */
  const fetchWebcams = async () => {
    try {
      const res = await rpc("server.webcams.list", {});
      const webcams = moonrakerWebcamsToList(res, httpBase);
      onAux({ webcams }, ctx.hostname);
      onLog(`[moonraker] カメラ ${webcams.length} 件を取得`, webcams.length ? "info" : "warn");
    } catch (e) {
      onLog(`[moonraker] カメラ一覧取得失敗: ${e.message}`, "warn");
    }
  };

  /**
   * 受信メッセージを処理する。
   * @private
   * @param {MessageEvent} evt - WebSocket メッセージイベント
   * @returns {void}
   */
  const onMessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(typeof evt.data === "string" ? evt.data : "");
    } catch {
      return; // JSON 以外は無視
    }
    if (!msg || typeof msg !== "object") return;

    // --- Promise ベース RPC 応答(履歴/ファイル取得) ---
    if (msg.id != null && pendingRpc.has(msg.id)) {
      const { resolve, reject } = pendingRpc.get(msg.id);
      pendingRpc.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "rpc error"));
      else resolve(msg.result);
      return;
    }

    // --- RPC 応答(タグ方式: 初期化フロー) ---
    if (msg.id != null && pending.has(msg.id)) {
      const tag = pending.get(msg.id);
      pending.delete(msg.id);
      const result = msg.result;
      if (tag === "info" && result) {
        ctx.hostname = result.hostname || fallbackHost;
        onLog(`[moonraker] 機器ホスト名を取得: ${ctx.hostname}`, "info");
        // 温度上限取得 → 状態購読 の順に開始
        send("printer.objects.query", { objects: { configfile: ["settings"] } }, "config");
        send("printer.objects.subscribe", { objects: MOONRAKER_SUBSCRIBE_OBJECTS }, "subscribe");
      } else if (tag === "config" && result?.status?.configfile?.settings) {
        const st = result.status.configfile.settings;
        const en = Number(st?.extruder?.max_temp);
        const bn = Number(st?.heater_bed?.max_temp);
        if (Number.isFinite(en)) ctx.maxNozzleTemp = en;
        if (Number.isFinite(bn)) ctx.maxBedTemp = bn;
        onLog(`[moonraker] 温度上限 nozzle=${ctx.maxNozzleTemp} bed=${ctx.maxBedTemp}`, "info");
      } else if (tag === "subscribe" && result?.status) {
        // 初期スナップショット
        mergeMoonrakerStatus(accStatus, result.status);
        maybeFetchMeta();
        emit();
        // 状態購読が確立(=ホスト確定・パネル生成済み)した後に履歴/ファイル/カメラを取得
        fetchHistory();
        fetchFiles();
        fetchWebcams();
      } else if (tag === "meta" && result) {
        // gcode メタ(残時間/レイヤー算出用)を ctx へ格納
        ctx.meta = {
          estimatedTime: Number.isFinite(Number(result.estimated_time)) ? Number(result.estimated_time) : null,
          objectHeight: Number.isFinite(Number(result.object_height)) ? Number(result.object_height) : null,
          layerHeight: Number.isFinite(Number(result.layer_height)) ? Number(result.layer_height) : null,
          firstLayerHeight: Number.isFinite(Number(result.first_layer_height)) ? Number(result.first_layer_height) : null,
          layerCount: Number.isFinite(Number(result.layer_count)) ? Number(result.layer_count) : null,
        };
        onLog(`[moonraker] gcodeメタ取得: est=${ctx.meta.estimatedTime}s 高さ=${ctx.meta.objectHeight}mm 層=${ctx.meta.layerHeight}mm`, "info");
        emit();
      }
      return;
    }

    // --- 通知(method 付き) ---
    if (msg.method === "notify_status_update" && Array.isArray(msg.params)) {
      mergeMoonrakerStatus(accStatus, msg.params[0] || {});
      maybeFetchMeta();
      emit();
    } else if (msg.method === "notify_klippy_shutdown" || msg.method === "notify_klippy_disconnected") {
      // Klippy 異常 → webhooks.state を擬似的に落として翻訳に反映
      mergeMoonrakerStatus(accStatus, { webhooks: { state: "shutdown" } });
      emit();
      onLog("[moonraker] Klippy が停止/切断されました", "warn");
    } else if (msg.method === "notify_klippy_ready") {
      mergeMoonrakerStatus(accStatus, { webhooks: { state: "ready" } });
      emit();
      onLog("[moonraker] Klippy が ready になりました", "info");
    } else if (msg.method === "notify_history_changed") {
      // ジョブ追加/完了 → 履歴を再取得
      fetchHistory();
    } else if (msg.method === "notify_filelist_changed") {
      // ファイル追加/削除/更新 → ファイル一覧を再取得
      fetchFiles();
    } else if (msg.method === "notify_webcams_changed") {
      // カメラ構成変更 → カメラ一覧を再取得
      fetchWebcams();
    } else if (msg.method === "notify_gcode_response" && Array.isArray(msg.params)) {
      // リアルタイム gcode コンソール出力(温度自動報告/echo/M117/エラー応答等)
      for (const line of msg.params) {
        if (line != null && line !== "") onGcode(String(line), ctx.hostname);
      }
    }
  };

  /**
   * 切断時の再接続スケジューリング。
   * @private
   * @returns {void}
   */
  const scheduleReconnect = () => {
    if (closed || !shouldReconnect()) {
      onState("disconnected");
      return;
    }
    if (reconnectCount >= MOONRAKER_MAX_RECONNECT) {
      onState("disconnected");
      onLog(`[moonraker] 自動接続リトライが上限(${MOONRAKER_MAX_RECONNECT})に達しました。`, "error");
      return;
    }
    reconnectCount++;
    const delayMs = 2000 * Math.pow(2, reconnectCount - 1);
    onState("waiting");
    onLog(`[moonraker] 切断。${Math.ceil(delayMs / 1000)}秒後に再試行します...(${reconnectCount}/${MOONRAKER_MAX_RECONNECT})`, "warn");
    retryTimer = setTimeout(open, delayMs);
  };

  /**
   * WebSocket 接続を開く。
   * @private
   * @returns {void}
   */
  function open() {
    if (closed) return;
    onState("connecting");
    try {
      ws = new WebSocket(url);
    } catch (e) {
      onLog(`[moonraker] WebSocket 生成失敗: ${e.message}`, "error");
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      reconnectCount = 0;
      accStatus = {};
      lastMetaFile = null; // 再接続時にメタ再取得を許可
      onState("connected");
      onLog(`[moonraker] 接続確立: ${url}`, "info");
      // まずホスト名を取得(その応答内で config 取得→購読を連鎖実行)
      send("printer.info", {}, "info");
    };
    ws.onmessage = onMessage;
    ws.onerror = () => {
      onLog("[moonraker] WebSocket エラー", "warn");
    };
    ws.onclose = () => {
      pending.clear();
      // 取得系の保留 Promise を解放(再接続後に再取得される)
      for (const { reject } of pendingRpc.values()) { try { reject(new Error("ws closed")); } catch { /* noop */ } }
      pendingRpc.clear();
      scheduleReconnect();
    };
  }

  /**
   * セッションを明示停止する(再接続も行わない)。
   * @returns {void}
   */
  const close = () => {
    closed = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    for (const { reject } of pendingRpc.values()) { try { reject(new Error("session closed")); } catch { /* noop */ } }
    pendingRpc.clear();
    if (ws) {
      try {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch { /* noop */ }
      ws = null;
    }
  };

  // 起動
  open();

  return {
    close,
    /**
     * 任意の JSON-RPC を実行する(操作コマンドの送出に使用)。
     * @param {string} method - メソッド名
     * @param {Object} [params] - パラメータ
     * @returns {Promise<*>} result
     */
    request: (method, params = {}) => rpc(method, params),
  };
}
