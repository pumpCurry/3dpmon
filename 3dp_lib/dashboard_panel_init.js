/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 パネルライフサイクル管理モジュール
 * @file dashboard_panel_init.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_panel_init
 *
 * 【機能内容サマリ】
 * - GridStack パネル生成後の初期化関数レジストリ
 * - パネル破棄前のクリーンアップ関数レジストリ
 * - パネル種別ごとに init/destroy 関数を登録・呼び出し
 *
 * 【設計意図】
 * bootPanelSystem() が <template> からパネルをクローン生成した後、
 * イベントリスナーやコンポーネント初期化が失われる問題を解決する。
 * パネル生成直後に initializePanel() を呼ぶことで、
 * クローンされた DOM 要素に対して正しくバインドし直す。
 *
 * 【公開関数一覧】
 * - {@link registerPanelInit}：パネル初期化関数の登録
 * - {@link registerPanelDestroy}：パネル破棄関数の登録
 * - {@link initializePanel}：パネル生成後の初期化実行
 * - {@link destroyPanel}：パネル破棄前のクリーンアップ実行
 * - {@link registerAllPanelInits}：全パネル種別の初期化関数を一括登録
 *
 * @version 1.390.1472 (PR #436)
 * @since   1.390.783 (PR #366)
 * @lastModified 2026-08-29 21:19:45
 * -----------------------------------------------------------
 */

"use strict";

import { initTemperatureGraph, resetTemperatureGraph, resetTemperatureGraphView, toggleChartInteractionLock, setChartWindowMinutes, setChartViewMinutes } from "./dashboard_chart.js";
import {
  registerCameraPanel,
  unregisterCameraPanel,
  startCameraStream,
  stopCameraStream
} from "./dashboard_camera_ctrl.js";
import {
  restoreXYPreviewState,
  initXYPreview,
  registerPreviewPanel,
  replayPreviewState,
  destroyPreviewPanel,
  setPrinterModel,
  setFlatView,
  setTilt45View,
  setObliqueView,
  toggleZSpin
} from "./dashboard_stage_preview.js";
import { createFilamentPreview } from "./dashboard_filament_view.js";
import { showFilamentChangeDialog } from "./dashboard_filament_change.js";
import { showFilamentManager } from "./dashboard_filament_manager.js";
import { initLogAutoScroll, initLogRenderer } from "./dashboard_log_util.js";
/* initStorageUIInPanel は設定パネル統合により不要 */
import { monitorData } from "./dashboard_data.js";
import { getCurrentSpool, setCurrentSpoolId, formatSpoolDisplayId } from "./dashboard_spool.js";
import { showAlert } from "./dashboard_notification_manager.js";
import { getDeviceIp, getDisplayBaseUrl, sendCommand, getPrinterType, getConnectionTarget, getConnectionState, getPrinterCoreV3RuntimeProbeSessionId, getPrinterCoreV3ConnectionGeneration } from "./dashboard_connection.js";
import * as printManager from "./dashboard_printmanager.js";
import {
  buildFleetSummary, buildDailyProductionReport, buildEstimateVsActual,
  buildJobCostReport, buildHostRanking, buildMaterialReport
} from "./dashboard_production.js";
import { weightFromLength } from "./dashboard_spool.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";
import { createEmptyState } from "./dashboard_ui_components.js";
import {
  initializeCommandPalette,
  initializeRateControls,
  initSendRawJson,
  initSendGcode,
  initTestRawJson,
  initPauseHome,
  initXYUnlock
} from "./dashboard_send_command.js";
import {
  createMaterialTopologyViewModel,
} from "./printer_core/dashboard_material_topology_view_model.js";
import {
  renderMaterialTopologyPanel,
} from "./printer_core/dashboard_material_topology_panel.js";
import {
  createCfsCertificationExportBundle,
  createCfsCertificationPanelViewModel,
  renderCfsCertificationPanel,
} from "./printer_core/dashboard_cfs_certification_panel.js";
import {
  createBoundCfsControlIntegration,
} from "./printer_core/dashboard_cfs_command_integration.js";
import {
  createBoundPrinterCommandDispatcher,
} from "./printer_core/dashboard_command_authority.js";
import {
  K2_CFS_SLOT_CONTROL_PRODUCTION_TRANSPORT_PROFILE,
  createK2CfsCommandTransportPlan,
  sendK2CfsCommandTransportPlan,
  validateRegisteredK2CfsSlotControlCertificationEvidence,
} from "./printer_core/dashboard_k2_cfs_command_transport.js";
import {
  MATERIAL_DISPLAY_MODE,
  resolveDisplayMaterialTopology,
  resolveMaterialDisplayMode,
  resolveMaterialTopologyViewOptions,
} from "./printer_core/dashboard_material_system_settings.js";

// ==============================
// レジストリ
// ==============================

/**
 * パネル種別 → 初期化関数のマップ
 * @type {Map<string, (panelBody: HTMLElement, hostname: string) => void>}
 */
const _initMap = new Map();

/**
 * パネル種別 → 破棄関数のマップ
 * @type {Map<string, (panelBody: HTMLElement, hostname: string) => void>}
 */
const _destroyMap = new Map();

/**
 * CFS/CFS-C 操作候補で扱うUI action一覧。
 *
 * 【詳細説明】
 * - material topology panel のボタン定義と同じaction名だけを通常パネル側から明示する。
 * - ここでは候補表示用であり、実送信の許可ではない。
 *
 * @constant {string[]}
 */
const CFS_CONTROL_UI_ACTIONS = Object.freeze(["select", "load", "unload", "feed", "retract"]);

/**
 * CFS/CFS-C UI action と Printer Core command kind の対応表。
 *
 * 【詳細説明】
 * - integration module内部にも同じ対応があるが、panel composition層ではtarget設定から
 *   認証済みcommand kindをaction許可へ戻す必要があるため、表示境界用に明示する。
 *
 * @constant {Object<string,string>}
 */
const CFS_CONTROL_ACTION_COMMAND_KIND = Object.freeze({
  select: "cfs-slot-select",
  load: "cfs-load",
  unload: "cfs-unload",
  feed: "cfs-feed",
  retract: "cfs-retract",
});

/**
 * production有効化前のCFS操作候補disabled理由。
 *
 * 【詳細説明】
 * - 通常UIへ操作候補hookを渡しても、実機certificationとadapter transport接続が終わるまで
 *   3dpmon側からのCFS操作は開かないことを利用者向けに示す。
 *
 * @constant {string}
 */
const CFS_CONTROL_DISABLED_REASON = "実機認証前のため3dpmonからのCFS/CFS-C操作は無効です";

/**
 * 配列/Set/map形式のcommand kind allow-listをSetへ正規化する。
 *
 * @private
 * @param {*} value - allow-list候補
 * @returns {Set<string>} 正規化済みcommand kind set
 */
function normalizeCertifiedCfsCommandSet(value) {
  if (value instanceof Set) {
    return new Set(Array.from(value).map((entry) => String(entry || "").trim()).filter(Boolean));
  }
  if (Array.isArray(value)) {
    return new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean));
  }
  if (value && typeof value === "object") {
    return new Set(Object.entries(value)
      .filter(([, enabled]) => enabled === true)
      .map(([commandKind]) => String(commandKind || "").trim())
      .filter(Boolean));
  }
  return new Set();
}

/**
 * connection targetに保存された`/info`証跡が現在起動中のre-probe結果か判定する。
 *
 * 【詳細説明】
 * - `printerCoreV3Info` はconnectionTargetsと一緒に永続化されるため、再起動前の値を
 *   command authorityの現在scopeとして使うと、re-probe前にCFS controlが復活してしまう。
 * - Gate 20では`dashboard_connection.js`が付与した現在のprobe session IDと一致する場合だけ採用する。
 *
 * @private
 * @function isCurrentPrinterCoreV3Info
 * @param {object|null|undefined} info - `printerCoreV3Info`候補
 * @param {object|null|undefined} target - 現在のconnection target
 * @returns {boolean} 現在起動中の`/info` probe証跡ならtrue
 */
function isCurrentPrinterCoreV3Info(info, target = null) {
  if (!info || typeof info !== "object") {
    return false;
  }
  if (String(info.probeSessionId || "") !== getPrinterCoreV3RuntimeProbeSessionId()) {
    return false;
  }
  const storedGeneration = Number(info.connectionGeneration) || 0;
  if (!storedGeneration) {
    return false;
  }
  const targetDest = String(target?.dest || "").trim();
  const infoDest = String(info.connectionDest || "").trim();
  if (targetDest && infoDest && targetDest !== infoDest) {
    return false;
  }
  const lookupKey = target?.hostname || target?.dest || info.connectionHost || info.connectionDest || "";
  const currentGeneration = getPrinterCoreV3ConnectionGeneration(lookupKey);
  return storedGeneration === currentGeneration;
}

/**
 * connection targetから現在起動中の`/info`証跡を選択する。
 *
 * 【詳細説明】
 * - `printerCoreV3Info`が永続化由来で古い場合でも、後続候補に現在probeのHTTP情報があればそれを採用する。
 * - どの候補も現在scopeに一致しない場合は空objectを返し、authority/表示の両方をfail-closedにする。
 *
 * @private
 * @function selectCurrentPrinterCoreV3Info
 * @param {object|null|undefined} target - 接続target設定
 * @returns {object} 現在起動中の`/info`証跡、または空object
 */
function selectCurrentPrinterCoreV3Info(target) {
  const candidates = [
    target?.printerCoreV3Info,
    target?.printerCoreV3HttpInfo,
    target?.httpInfo,
  ];
  return candidates.find((info) => isCurrentPrinterCoreV3Info(info, target)) || {};
}

/**
 * target/runtimeからCFS control certification用のscopeを作る。
 *
 * 【詳細説明】
 * - `/info` 由来のmodel/versionは、現在起動中のre-probeで観測したものだけを採用する。
 * - 永続identityやlegacy storedDataは古い可能性があるため、production command scopeには使わない。
 * - model/firmwareが現在観測できない環境では、validator側でproduction有効化を拒否する。
 *
 * @private
 * @param {object|null|undefined} target - 接続target設定
 * @returns {object} certification scope
 */
function createCfsControlCertificationScope(target) {
  const info = selectCurrentPrinterCoreV3Info(target);
  return {
    printerType: target?.printerType || null,
    model: info.model || info.reportedModel || null,
    firmwareVersion: info.version || info.firmwareVersion || null,
  };
}

/**
 * CFS control production設定を接続targetから読み取る。
 *
 * 【詳細説明】
 * - 既定では必ずnullを返し、既存ユーザーのCFS監視UIをread-onlyのまま保つ。
 * - `materialSystem.cfsControl.enabled === true`、認証済みcommand kind、certificationEvidenceが
 *   揃った場合だけ、composition層でbound dispatcherを生成する。
 *
 * @private
 * @param {object|null|undefined} target - 接続target設定
 * @returns {object|null} production CFS control設定、またはnull
 */
function resolveCfsControlProductionSettings(target) {
  const control = target?.materialSystem?.cfsControl;
  if (!control || control.enabled !== true) {
    return null;
  }
  if (target?.printerType !== "creality-k2") {
    return null;
  }
  const certifiedCommandKinds = normalizeCertifiedCfsCommandSet(
    control.certifiedCfsSlotControlCommands
  );
  const requestedActions = Array.isArray(control.allowedActions)
    ? control.allowedActions.map((action) => String(action || "").trim()).filter(Boolean)
    : CFS_CONTROL_UI_ACTIONS;
  const allowedActions = requestedActions.filter((action) => {
    const commandKind = CFS_CONTROL_ACTION_COMMAND_KIND[action];
    return commandKind && certifiedCommandKinds.has(commandKind);
  });
  const evidence = control.certificationEvidence;
  const scope = createCfsControlCertificationScope(target);
  const certifiedAllowedActions = allowedActions.filter((action) => {
    const commandKind = CFS_CONTROL_ACTION_COMMAND_KIND[action];
    const validation = validateRegisteredK2CfsSlotControlCertificationEvidence(evidence, commandKind, scope);
    return validation.ok;
  });
  if (certifiedAllowedActions.length === 0) {
    return null;
  }
  return {
    allowedActions: certifiedAllowedActions,
    certifiedCommandKinds: certifiedAllowedActions.map((action) => CFS_CONTROL_ACTION_COMMAND_KIND[action]),
    certificationEvidence: evidence,
    certificationScope: scope,
  };
}

/**
 * CFS command send-time用のmaterial topology summaryを生成する。
 *
 * @private
 * @param {object|null|undefined} topology - runtime material topology
 * @returns {object} command dispatcher用topology summary
 */
function createCfsControlSendTimeMaterialTopology(topology) {
  const sources = Array.isArray(topology?.sources) ? topology.sources : [];
  return {
    cfsConnected: topology?.cfs?.connected === true,
    topologyState: String(topology?.cfs?.topologyState || "unobserved"),
    sourceCount: sources.length,
    sources: sources.map((source) => ({
      sourceId: source?.sourceId || null,
      kind: source?.kind || null,
      boxId: source?.boxId ?? null,
      slotId: source?.slotId ?? source?.protocolSlotId ?? null,
      presence: source?.presence || source?.status?.presence || null,
      status: {
        presence: source?.status?.presence || null,
        stateCode: source?.status?.stateCode ?? source?.stateCode ?? null,
      },
      material: source?.material || null,
    })),
  };
}

/**
 * CFS command送信直前contextを現在runtimeから生成する。
 *
 * 【詳細説明】
 * - 保存済みlast-known fallbackは使わず、現在sessionのruntime topologyだけをauthority入力にする。
 * - `command.cfs-control` capabilityはproduction設定があるcompositionからのみ付与する。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @param {object} request - 送信直前に検証するcommand request
 * @returns {object} command authority send-time snapshot
 */
function createCfsControlSendTimeContext(hostname, request) {
  const currentTarget = getConnectionTarget(hostname);
  const machine = monitorData.machines[hostname] || {};
  const currentProductionSettings = resolveCfsControlProductionSettings(currentTarget);
  const commandKind = String(request?.commandKind || "").trim();
  if (!currentProductionSettings || !currentProductionSettings.certifiedCommandKinds.includes(commandKind)) {
    throw new Error("cfs-control-certification-revoked");
  }
  const shadowRecord = machine.runtimeData?.printerCoreV3Shadow || null;
  const runtimeTopology = shadowRecord?.lastState?.materials || null;
  const materialTopology = createCfsControlSendTimeMaterialTopology(runtimeTopology);
  const capabilities = [
    "material.cfs",
    "material.cfsTopology",
    "command.cfs-control",
  ];
  return {
    deviceId: shadowRecord?.deviceId || "",
    sessionId: shadowRecord?.sessionId || "",
    transportKind: "ws9999",
    active: getConnectionState(hostname) === "connected" && shadowRecord?.state !== "closed",
    capabilities,
    transportProfiles: [K2_CFS_SLOT_CONTROL_PRODUCTION_TRANSPORT_PROFILE],
    materialTopology,
    stateSequence: shadowRecord?.lastSequence ?? shadowRecord?.lastState?.source?.sequence ?? null,
    observedState: shadowRecord?.lastState || null,
    createdAt: new Date().toISOString(),
    certificationEvidence: currentProductionSettings.certificationEvidence,
    certificationScope: createCfsControlCertificationScope(currentTarget),
  };
}

/**
 * CFS command送信後の観測snapshotを返す。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @returns {object} command result用観測snapshot
 */
function observeCfsControlCommandState(hostname) {
  const shadowRecord = monitorData.machines[hostname]?.runtimeData?.printerCoreV3Shadow || null;
  return {
    observedState: shadowRecord?.lastState || null,
    observedSequence: shadowRecord?.lastSequence ?? shadowRecord?.lastState?.source?.sequence ?? null,
    observedSessionId: shadowRecord?.sessionId || "",
  };
}

/**
 * production CFS control用のbound dispatcherを生成する。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @returns {object} bound printer command dispatcher
 */
function createCfsControlDispatcher(hostname) {
  return createBoundPrinterCommandDispatcher({
    getSendTimeContext: (request) => createCfsControlSendTimeContext(hostname, request),
    sendTransport: async (request) => {
      const currentTarget = getConnectionTarget(hostname);
      const currentSettings = resolveCfsControlProductionSettings(currentTarget);
      if (!currentSettings || !currentSettings.certifiedCommandKinds.includes(String(request?.commandKind || "").trim())) {
        throw new Error("cfs-control-certification-revoked");
      }
      const plan = createK2CfsCommandTransportPlan(request, {
        certifiedCfsSlotControlCommands: currentSettings.certifiedCommandKinds,
        certificationEvidence: currentSettings.certificationEvidence,
        certificationScope: currentSettings.certificationScope,
      });
      if (!plan.ok) {
        throw new Error(`k2-cfs-control-plan-rejected:${plan.reason}`);
      }
      return sendK2CfsCommandTransportPlan(plan, async (frame, meta) => {
        await sendCommand(frame.method, frame.params, hostname);
        return {
          status: "submitted",
          frame,
          meta,
        };
      });
    },
    observeState: () => observeCfsControlCommandState(hostname),
  });
}

/**
 * CFS/CFS-C操作候補用のrenderer control optionを生成する。
 *
 * 【詳細説明】
 * - 通常フィラメントパネルからintegration scaffoldへのhook位置だけを固定する。
 * - `canSendCommands:false` と `dispatchCfsControlIntent(..., { enabled:false })` の二重ロックにより、
 *   production activation前にUI操作がtransportへ流れないようにする。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @returns {object} renderMaterialTopologyPanelへ渡すcontrol option
 */
function createCfsControlRenderOptions(hostname) {
  const target = getConnectionTarget(hostname);
  const machine = monitorData.machines[hostname] || {};
  const productionSettings = resolveCfsControlProductionSettings(target);
  if (productionSettings) {
    const dispatcher = createCfsControlDispatcher(hostname);
    const integration = createBoundCfsControlIntegration({
      enabled: true,
      allowedActions: productionSettings.allowedActions,
      dispatcher,
      getCommandContext: () => {
        const machine = monitorData.machines[hostname] || {};
        const shadowRecord = machine.runtimeData?.printerCoreV3Shadow || null;
        if (!shadowRecord?.deviceId || !shadowRecord?.sessionId) {
          throw new Error("missing-cfs-command-shadow-session");
        }
        return {
          deviceId: shadowRecord.deviceId,
          sessionId: shadowRecord.sessionId,
          transportKind: "ws9999",
          idempotencyKey: `cfs-control:${hostname}:${Date.now()}`,
          createdAt: new Date().toISOString(),
        };
      },
    });
    return {
      showControls: true,
      canSendCommands: true,
      allowedActions: productionSettings.allowedActions,
      disabledReason: null,
      validateCommandIntent(intent) {
        return validateCfsControlIntentFreshness(hostname, intent);
      },
      /**
       * production CFS/CFS-C操作intentをbound integrationへ渡す。
       *
       * 【詳細説明】
       * - 送信直前のsession/capability/topology再検証とtransport certification allow-listは
       *   bound dispatcher内部で再確認される。
       *
       * @param {object} intent - material topology panelが生成した操作intent
       * @returns {Promise<object>} dispatch結果
       */
      onCommand(intent) {
        return integration.onCommand(intent);
      },
    };
  }
  const integration = createBoundCfsControlIntegration({
    enabled: false,
    allowedActions: CFS_CONTROL_UI_ACTIONS,
  });
  return {
    showControls: true,
    canSendCommands: false,
    allowedActions: [...CFS_CONTROL_UI_ACTIONS],
    disabledReason: CFS_CONTROL_DISABLED_REASON,
    validateCommandIntent(intent) {
      return validateCfsControlIntentFreshness(hostname, intent);
    },
    /**
     * CFS/CFS-C操作候補intentをfail-closed integration scaffoldへ渡す。
     *
     * 【詳細説明】
     * - 現段階ではdisabled integration固定のため、直接呼ばれてもdispatcherへは到達しない。
     *
     * @param {object} intent - material topology panelが生成した操作intent
     * @returns {Promise<object>} fail-closed dispatch結果
     */
    onCommand(intent) {
      return integration.onCommand(intent);
    },
  };
}

/**
 * CFS操作intentがclick時点の最新topologyでも有効かを再確認する。
 *
 * 【詳細説明】
 * - 描画時点ではfreshだったslotが、再描画前にCFS切断/stale/slot変更される短い窓を閉じる。
 * - この検査はUX上の一次防御であり、最終authorityはbound dispatcherのsend-time validationへ委ねる。
 *
 * @private
 * @param {string} hostname - 対象ホスト名
 * @param {object} intent - material topology panelが生成した操作intent
 * @returns {string|null} 操作不可理由、またはnull
 */
function validateCfsControlIntentFreshness(hostname, intent) {
  try {
    const latestMachine = monitorData.machines[hostname] || {};
    const latestShadowRecord = latestMachine.runtimeData?.printerCoreV3Shadow || null;
    const latestTopology = resolveDisplayMaterialTopology({
      topology: latestShadowRecord?.lastState?.materials || null,
      shadowRecord: latestShadowRecord,
      observationStore: monitorData.materialSourceObservations || null,
      allowPersistentLastKnown: true,
      host: hostname,
    });
    const latestTarget = getConnectionTarget(hostname);
    const latestPrinterType = getPrinterType(hostname);
    const viewOptions = resolveMaterialTopologyViewOptions({
      target: latestTarget,
      printerType: latestPrinterType,
      topology: latestTopology,
    });
    const viewModel = createMaterialTopologyViewModel(latestTopology, viewOptions);
    if (viewModel?.summary?.topologyState !== "fresh") {
      return "CFS情報が最新ではないため操作できません";
    }
    const currentRows = (Array.isArray(viewModel?.units) ? viewModel.units : [])
      .flatMap((unit) => Array.isArray(unit?.slots) ? unit.slots : []);
    const currentRow = currentRows.find((row) => row?.sourceId && row.sourceId === intent?.sourceId);
    if (!currentRow) {
      return "対象CFSスロットを現在の情報で再確認できません";
    }
    if (currentRow.presence !== "loaded") {
      return "対象CFSスロットには現在フィラメントが装填されていません";
    }
    if (intent?.displaySlot && currentRow.displaySlot !== intent.displaySlot) {
      return "対象CFSスロットの表示位置が最新状態と一致しません";
    }
    return null;
  } catch {
    return "CFS情報の再確認に失敗したため操作できません";
  }
}

/**
 * registerPanelInit:
 *   パネル種別に対する初期化関数を登録する。
 *   パネル生成後（GridStack へ追加後）に呼ばれる。
 *
 * @param {string} panelType - パネル種別 ID（例: "camera", "temp-graph"）
 * @param {(panelBody: HTMLElement, hostname: string) => void} initFn - 初期化関数
 */
export function registerPanelInit(panelType, initFn) {
  _initMap.set(panelType, initFn);
}

/**
 * registerPanelDestroy:
 *   パネル種別に対する破棄関数を登録する。
 *   パネル削除前に呼ばれ、タイマー停止やリスナー解除を行う。
 *
 * @param {string} panelType - パネル種別 ID
 * @param {(panelBody: HTMLElement, hostname: string) => void} destroyFn - 破棄関数
 */
export function registerPanelDestroy(panelType, destroyFn) {
  _destroyMap.set(panelType, destroyFn);
}

/**
 * initializePanel:
 *   パネル生成後に呼び出す。登録された初期化関数を実行する。
 *
 * @param {string} panelType - パネル種別 ID
 * @param {HTMLElement} panelBody - パネル本体の DOM 要素（.panel-body）
 * @param {string} hostname - 対象ホスト名（共有パネルの場合は "shared"）
 */
export function initializePanel(panelType, panelBody, hostname) {
  const fn = _initMap.get(panelType);
  if (fn) {
    try {
      fn(panelBody, hostname);
    } catch (e) {
      console.error(`[panel-init] ${panelType} の初期化に失敗:`, e);
    }
  }
  // プリンタ種別に応じて機種専用 UI を出し分ける（全パネル共通）
  try {
    _applyMachineTypeVisibility(panelBody, hostname);
  } catch (e) {
    console.error(`[panel-init] machineType 可視性適用に失敗:`, e);
  }
}

/**
 * パネル内の `data-machine-type` 付き要素を、対象ホストのプリンタ種別に応じて
 * 表示/非表示にする。
 *
 * 【詳細説明】
 * - `data-machine-type="k1-only"`: Creality K1 系のみ表示（K2 / Moonraker 機では非表示）。
 *   箱内温度・側面/背面FAN・LED・AI 機能・K1 専用コマンドボタン等が対象。
 * - `data-machine-type="moonraker-only"`: Moonraker 機のみ表示。
 * - 属性なしの要素は常に表示（両機種共通 UI）。
 *
 * @private
 * @param {HTMLElement} panelBody - パネル本体要素
 * @param {string} hostname - 対象ホスト名
 * @returns {void}
 */
function _applyMachineTypeVisibility(panelBody, hostname) {
  if (!panelBody || !hostname || hostname === "shared") return;
  const type = getPrinterType(hostname);
  const isK1 = type === "creality-k1";
  const isMoonraker = type === "moonraker";
  panelBody.querySelectorAll('[data-machine-type="k1-only"]').forEach((el) => {
    el.classList.toggle("hidden", !isK1);
  });
  panelBody.querySelectorAll('[data-machine-type="moonraker-only"]').forEach((el) => {
    el.classList.toggle("hidden", !isMoonraker);
  });
}

/**
 * destroyPanel:
 *   パネル破棄前に呼び出す。登録されたクリーンアップ関数を実行する。
 *
 * @param {string} panelType - パネル種別 ID
 * @param {HTMLElement} panelBody - パネル本体の DOM 要素
 * @param {string} hostname - 対象ホスト名
 */
export function destroyPanel(panelType, panelBody, hostname) {
  const fn = _destroyMap.get(panelType);
  if (fn) {
    try {
      fn(panelBody, hostname);
    } catch (e) {
      console.error(`[panel-destroy] ${panelType} の破棄に失敗:`, e);
    }
  }
}

// ==============================
// 各パネルの初期化関数
// ==============================

/**
 * カメラパネルの初期化。
 * カメラレジストリに登録し、トグルスイッチやキャンセルボタンのイベントをバインドする。
 * ストリームの開始・停止・リトライは dashboard_camera_ctrl に委譲する。
 *
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initCameraPanel(body, hostname) {
  const img = body.querySelector("img");
  if (!img) return;

  /* トグルスイッチはパネルヘッダー内に生成されている */
  const panelWrapper = body.closest(".panel-wrapper");
  const toggle = panelWrapper?.querySelector(".panel-header-toggle input");

  /* カメラレジストリに登録（リトライ・UI更新は camera_ctrl が管理） */
  registerCameraPanel(hostname, img, body, toggle);

  /* トグルスイッチのイベント */
  if (toggle) {
    toggle.checked = !!(monitorData.hostCameraToggle[hostname] ?? monitorData.appSettings.cameraToggle);
    toggle.addEventListener("change", () => {
      monitorData.hostCameraToggle[hostname] = toggle.checked;
      saveUnifiedStorage(true); // ★ カメラON/OFFを即時保存
      if (toggle.checked) {
        startCameraStream(hostname);
      } else {
        stopCameraStream(hostname);
      }
    });
  }

  /* NO SIGNAL にホスト名・IPを表示 */
  _updateNoSignalInfo(body, hostname);

  /* パネル表示復元時: カメラONならストリーム開始 */
  if (monitorData.hostCameraToggle[hostname] ?? monitorData.appSettings.cameraToggle) {
    startCameraStream(hostname);
  }

  /* キャンセルボタン（ユーザ操作 → フル停止） */
  const cancelBtn = body.querySelector("[id$='camera-cancel-button']") ||
                    body.querySelector(".camera-cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      monitorData.hostCameraToggle[hostname] = false;
      saveUnifiedStorage(true); // ★ カメラOFF即時保存
      stopCameraStream(hostname);
    });
  }

  /* パネルの hostname を destroy 用に保持 */
  body._cameraHostname = hostname;
}

/**
 * NO SIGNAL 表示にホスト名とIPを反映する
 * @private
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function _updateNoSignalInfo(body, hostname) {
  const hostEl = body.querySelector("[id$='camera-no-signal-host']") || body.querySelector(".no-signal-host");
  const ipEl = body.querySelector("[id$='camera-no-signal-ip']") || body.querySelector(".no-signal-ip");
  const displayHost = (hostname && hostname !== "shared")
    ? hostname
    : "";
  const ip = getDeviceIp(displayHost) || "";
  if (hostEl) hostEl.textContent = displayHost || "";
  if (ipEl) ipEl.textContent = ip ? `(${ip})` : "";
}

/**
 * ヘッド位置プレビューパネルの初期化
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initHeadPreviewPanel(body, hostname) {
  /* パネル本体をプレビューモジュールに登録（per-host DOM参照） */
  registerPreviewPanel(body, hostname);

  /* localStorage から位置・モデル・回転状態を復元 */
  restoreXYPreviewState(hostname);

  const xyStage = body.querySelector("#xy-stage");
  if (xyStage) {
    initXYPreview(body, hostname);
  }

  /* processData がパネル生成前に到着済みの場合、
     キャッシュされた位置・モデル情報を DOM に反映する */
  replayPreviewState(hostname);

  // 回転ボタンのバインド
  const btnFlat = body.querySelector("#btn-stage-flat");
  const btn45 = body.querySelector("#btn-stage-45");
  const btnOblique = body.querySelector("#btn-stage-65-72");
  const btnSpin = body.querySelector("#btn-stage-spin");

  if (btnFlat) btnFlat.addEventListener("click", () => setFlatView(hostname));
  if (btn45) btn45.addEventListener("click", () => setTilt45View(hostname));
  if (btnOblique) btnOblique.addEventListener("click", () => setObliqueView(hostname));
  if (btnSpin) btnSpin.addEventListener("click", () => toggleZSpin(hostname));
}

/**
 * material topology view model からCFS slot行を平坦化する。
 *
 * 【詳細説明】
 * - CFS Debug / Certificationパネルのdry-run対象を選ぶため、表示済みの固定slot行を再利用する。
 * - 外部スプールはslot control対象ではないので、この関数ではCFS slotだけを返す。
 *
 * @private
 * @function flattenCfsCertificationSlots
 * @param {object|null|undefined} viewModel - material topology view model
 * @returns {Array<object>} CFS slot表示行
 */
function flattenCfsCertificationSlots(viewModel) {
  const units = Array.isArray(viewModel?.units) ? viewModel.units : [];
  return units.flatMap((unit) => Array.isArray(unit?.slots) ? unit.slots : [])
    .filter((row) => row?.kind === "cfs-slot" && row.sourceId);
}

/**
 * CFS Debug / Certificationパネルの対象slotを選ぶ。
 *
 * 【詳細説明】
 * - 現時点ではGUI上のslot pickerをまだ持たないため、現在selectedのCFS slotを第一候補にする。
 * - selectedが無ければloaded slot、さらに観測済みslotへfallbackし、dry-run plan生成可否をパネル上で確認できるようにする。
 *
 * @private
 * @function selectCfsCertificationTargetSource
 * @param {object|null|undefined} viewModel - material topology view model
 * @returns {object|null} 対象source row
 */
function selectCfsCertificationTargetSource(viewModel) {
  const rows = flattenCfsCertificationSlots(viewModel);
  return rows.find((row) => row.selected === true)
    || rows.find((row) => row.presence === "loaded")
    || rows[0]
    || null;
}

/**
 * CFS Debug / Certificationパネル用のdry-run transport planを生成する。
 *
 * 【詳細説明】
 * - `allowUncertifiedCfsSlotCommandCandidates:true` を明示し、未certified candidateを送信せずpayload previewだけに使う。
 * - sourceが未観測の場合は拒否plan風の表示objectを返し、rendererで原因を見えるようにする。
 *
 * @private
 * @function createCfsCertificationDryRunPlan
 * @param {object|null} targetSource - 対象source row
 * @param {object|null} shadowRecord - Printer Core v3 shadow runtime
 * @param {string} commandKind - command kind
 * @returns {object} dry-run transport plan
 */
function createCfsCertificationDryRunPlan(targetSource, shadowRecord, commandKind) {
  if (!targetSource?.sourceId) {
    return {
      ok: false,
      reason: "missing-cfs-certification-target-source",
      frames: [],
      details: {
        commandKind,
        semanticStatus: "uncertified",
      },
    };
  }
  return createK2CfsCommandTransportPlan({
    deviceId: shadowRecord?.deviceId || "",
    sessionId: shadowRecord?.sessionId || "",
    transportKind: "ws9999",
    commandKind,
    payload: {
      sourceId: targetSource.sourceId,
      displaySlot: targetSource.displaySlot,
      unitIndex: targetSource.unitIndex,
      slotIndex: targetSource.slotIndex,
      boxId: targetSource.boxId,
      protocolSlotId: targetSource.protocolSlotId,
    },
    createdAt: new Date().toISOString(),
  }, {
    allowUncertifiedCfsSlotCommandCandidates: true,
  });
}

/**
 * CFS Debug / Certificationパネル用の描画snapshotを生成する。
 *
 * 【詳細説明】
 * - 通常フィラメントパネルと同じMaterialTopology ViewModelを使い、監視UIとDebug UIで見ているslotがずれないようにする。
 * - LIVE送信可否はrendererへ渡すだけでなく、production dispatcher側でも別途send-time検証される。
 *
 * @private
 * @function createCfsCertificationRenderableState
 * @param {string} hostname - 対象ホスト名
 * @returns {object} Certification renderer state
 */
function createCfsCertificationRenderableState(hostname) {
  const machine = monitorData.machines[hostname] || {};
  const target = getConnectionTarget(hostname);
  const printerType = getPrinterType(hostname);
  const shadowRecord = machine.runtimeData?.printerCoreV3Shadow || null;
  const topology = resolveDisplayMaterialTopology({
    topology: shadowRecord?.lastState?.materials || null,
    shadowRecord,
    observationStore: monitorData.materialSourceObservations || null,
    allowPersistentLastKnown: true,
    host: hostname,
  });
  const viewOptions = resolveMaterialTopologyViewOptions({
    target,
    printerType,
    topology,
  });
  const materialViewModel = createMaterialTopologyViewModel(topology, {
    ...viewOptions,
    observation: {
      lastObservedAt: shadowRecord?.materialProviderLastObservedAt || topology?.provider?.lastObservedAt || null,
      request: shadowRecord?.materialProviderRequest || null,
      nowMs: Date.now(),
    },
  });
  const targetSource = selectCfsCertificationTargetSource(materialViewModel);
  const commandKind = target?.materialSystem?.cfsCertification?.commandKind || "cfs-load";
  const dryRunPlan = createCfsCertificationDryRunPlan(targetSource, shadowRecord, commandKind);
  const currentInfo = selectCurrentPrinterCoreV3Info(target);
  const viewModel = createCfsCertificationPanelViewModel({
    printer: {
      displayName: hostname,
      model: currentInfo.model || currentInfo.reportedModel || "",
      firmwareVersion: currentInfo.version || currentInfo.firmwareVersion || "",
      deviceId: shadowRecord?.deviceId || "",
      sessionId: shadowRecord?.sessionId || "",
      transportKind: "ws9999",
      active: getConnectionState(hostname) === "connected" && shadowRecord?.state !== "closed",
      state: shadowRecord?.lastState?.status?.printState || shadowRecord?.lastState?.print?.state || "",
    },
    materialViewModel,
    targetSource,
    command: {
      commandKind,
      certificationStatus: dryRunPlan?.details?.semanticStatus || "uncertified",
    },
    dryRunPlan,
    execution: machine.runtimeData?.cfsCertificationExecution || {},
    evidence: machine.runtimeData?.cfsCertificationEvidence || {},
    export: {
      captureId: machine.runtimeData?.cfsCertificationCaptureId || "",
      fixtureId: machine.runtimeData?.cfsCertificationFixtureId || "",
    },
  });
  return {
    materialViewModel,
    targetSource,
    dryRunPlan,
    viewModel,
  };
}

/**
 * CFS Certificationパネルの再描画判定signatureを生成する。
 *
 * 【詳細説明】
 * - ViewModelの `generatedAt` はsnapshot生成時刻で毎秒変わるため、差分判定から除外して不要なDOM再描画を抑える。
 * - 通信中elapsedSecondsや観測値は `material.observation` / preflight側に残るため、利用者に必要な変化は保持される。
 *
 * @private
 * @function createCfsCertificationPanelSignature
 * @param {object} viewModel - Certificationパネル用ViewModel
 * @returns {string} 再描画判定signature
 */
function createCfsCertificationPanelSignature(viewModel) {
  return JSON.stringify({
    printer: viewModel?.printer,
    material: viewModel?.material,
    command: viewModel?.command,
    dryRun: viewModel?.dryRun,
    preflight: viewModel?.preflight,
    arm: viewModel?.arm,
    liveSend: viewModel?.liveSend,
    execution: viewModel?.execution,
    evidence: viewModel?.evidence,
    export: viewModel?.export,
  });
}

/**
 * Certification証跡bundleをファイルとして保存する。
 *
 * 【詳細説明】
 * - reviewerへ渡すJSON/NDJSONをUIから取り出せるようにする。ZIPは将来実装のため、この関数ではJSON系だけを扱う。
 *
 * @private
 * @function downloadCfsCertificationExportBundle
 * @param {string} hostname - 対象ホスト名
 * @param {string} format - export形式
 * @param {object} bundle - export bundle
 * @returns {void}
 */
function downloadCfsCertificationExportBundle(hostname, format, bundle) {
  if (format === "zip") {
    showAlert("ZIPエクスポートは未実装です。JSONまたはNDJSONを使用してください。", "info");
    return;
  }
  const safeHost = String(hostname || "printer").replace(/[^a-zA-Z0-9_-]+/g, "_");
  const payload = format === "ndjson"
    ? (Array.isArray(bundle?.events) ? bundle.events : []).map((event) => JSON.stringify(event)).join("\n")
    : JSON.stringify(bundle || {}, null, 2);
  const blob = new Blob([payload], { type: format === "ndjson" ? "application/x-ndjson" : "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeHost}-cfs-certification.${format === "ndjson" ? "ndjson" : "json"}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * CFS Debug / Certificationパネルを初期化する。
 *
 * 【詳細説明】
 * - B Hybrid案に従い、日常監視用フィラメントカードとは別に、read-only probe / dry-run / evidence exportを広く表示する。
 * - LIVE送信handlerは未接続のままにし、実機certification登録前に物理操作が走らない状態を維持する。
 *
 * @private
 * @function initCfsCertificationPanel
 * @param {HTMLElement} body - パネル本体
 * @param {string} hostname - 対象ホスト名
 * @returns {void}
 */
function initCfsCertificationPanel(body, hostname) {
  if (!body || !hostname) return;
  let container = body.querySelector(".cfs-cert-panel-root");
  if (!container) {
    container = document.createElement("div");
    container.className = "cfs-cert-panel-root";
    body.replaceChildren(container);
  }

  if (body._cfsCertificationRefreshTimer) {
    clearInterval(body._cfsCertificationRefreshTimer);
    body._cfsCertificationRefreshTimer = null;
  }
  body._cfsCertificationPanel?.destroy?.();
  body._cfsCertificationPanel = null;

  const renderOptions = {
    onProbeBoxsInfo: async () => {
      try {
        await sendCommand("get", { boxsInfo: 1 }, hostname);
        showAlert("boxsInfo取得を要求しました。応答は監視パネルへ反映されます。", "info");
      } catch (error) {
        showAlert(`boxsInfo取得に失敗しました: ${error?.message || error}`, "error");
      }
    },
    onProbeInfo: async () => {
      const baseUrl = getDisplayBaseUrl(hostname) || (getDeviceIp(hostname) ? `http://${getDeviceIp(hostname)}` : "");
      if (!baseUrl) {
        showAlert("/info取得先URLを解決できません。", "error");
        return;
      }
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/info`, { method: "GET" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        const machine = monitorData.machines[hostname] ||= {};
        machine.runtimeData ||= {};
        machine.runtimeData.cfsCertificationEvidence ||= {};
        machine.runtimeData.cfsCertificationEvidence.info = {
          observedAt: new Date().toISOString(),
          payload,
        };
        showAlert("/infoを取得しました。Certification証跡へ反映します。", "success");
      } catch (error) {
        showAlert(`/info取得に失敗しました: ${error?.message || error}`, "error");
      }
    },
    onExport: (format, bundle) => {
      downloadCfsCertificationExportBundle(hostname, format, bundle || createCfsCertificationExportBundle(
        createCfsCertificationRenderableState(hostname).viewModel
      ));
    },
  };

  const initialState = createCfsCertificationRenderableState(hostname);
  let signature = createCfsCertificationPanelSignature(initialState.viewModel);
  const panel = renderCfsCertificationPanel(container, initialState.viewModel, renderOptions);
  body._cfsCertificationPanel = panel;
  body._cfsCertificationRefreshTimer = setInterval(() => {
    try {
      const nextState = createCfsCertificationRenderableState(hostname);
      const nextSignature = createCfsCertificationPanelSignature(nextState.viewModel);
      if (nextSignature !== signature) {
        panel.update(nextState.viewModel);
        signature = nextSignature;
      }
    } catch (error) {
      console.warn("[panel-init] CFS certification panel 更新エラー:", error);
    }
  }, 1000);
}

/**
 * フィラメントプレビューパネルの初期化（プレビュー生成＋交換/一覧ボタンバインド）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initFilamentPanel(body, hostname) {
  const container = body.querySelector("#filament-preview");
  if (!container) return;

  if (body._materialTopologyModeListener) {
    window.removeEventListener("printer-core-v3-material-topology-updated", body._materialTopologyModeListener);
    body._materialTopologyModeListener = null;
  }
  if (body._materialTopologyRefreshTimer) {
    clearInterval(body._materialTopologyRefreshTimer);
    body._materialTopologyRefreshTimer = null;
  }
  body._materialTopologyPanel?.destroy?.();
  body._materialTopologyPanel = null;

  const machine = monitorData.machines[hostname] || {};
  const target = getConnectionTarget(hostname);
  const printerType = getPrinterType(hostname);
  const shadowRecord = machine.runtimeData?.printerCoreV3Shadow || null;
  const topology = resolveDisplayMaterialTopology({
    topology: shadowRecord?.lastState?.materials || null,
    shadowRecord,
    observationStore: monitorData.materialSourceObservations || null,
    allowPersistentLastKnown: true,
    host: hostname,
  });
  const materialDisplayMode = resolveMaterialDisplayMode({ target, printerType, topology });
  if (materialDisplayMode === MATERIAL_DISPLAY_MODE.MULTI_SLOT) {
    body.classList.add("filament-panel-cfs-mode");
    const createRenderablePanelState = () => {
      const latestMachine = monitorData.machines[hostname] || {};
      const latestShadowRecord = latestMachine.runtimeData?.printerCoreV3Shadow || null;
      const latestTopology = resolveDisplayMaterialTopology({
        topology: latestShadowRecord?.lastState?.materials || null,
        shadowRecord: latestShadowRecord,
        observationStore: monitorData.materialSourceObservations || null,
        allowPersistentLastKnown: true,
        host: hostname,
      });
      const latestTarget = getConnectionTarget(hostname);
      const viewOptions = resolveMaterialTopologyViewOptions({
        target: latestTarget,
        printerType,
        topology: latestTopology,
      });
      const cfsControlOptions = createCfsControlRenderOptions(hostname);
      const viewModel = createMaterialTopologyViewModel(latestTopology, {
        ...viewOptions,
        observation: {
          lastObservedAt: latestShadowRecord?.materialProviderLastObservedAt || latestTopology?.provider?.lastObservedAt || null,
          request: latestShadowRecord?.materialProviderRequest || null,
          nowMs: Date.now(),
        },
        commandAuthority: {
          canSendCommands: cfsControlOptions.canSendCommands === true,
          allowedActions: cfsControlOptions.allowedActions,
          reason: cfsControlOptions.disabledReason,
          sourceAuthority: cfsControlOptions.canSendCommands === true
            ? "printer-core-cfs-control-production-settings"
            : "printer-core-cfs-control-disabled",
        },
      });
      return { viewModel, controlOptions: cfsControlOptions };
    };
    const createSignature = (viewModel) => JSON.stringify({
      limits: viewModel.limits,
      cfs: viewModel.cfs,
      external: viewModel.external,
      units: viewModel.units,
      summary: viewModel.summary,
      authority: viewModel.authority,
      observation: viewModel.observation,
      diagnostics: viewModel.diagnostics,
    });
    const initialPanelState = createRenderablePanelState();
    let materialPanelSignature = createSignature(initialPanelState.viewModel);
    const materialPanel = renderMaterialTopologyPanel(container, initialPanelState.viewModel, {
      hostname,
      control: initialPanelState.controlOptions,
    });
    body._materialTopologyPanel = materialPanel;
    body._materialTopologyRefreshTimer = setInterval(() => {
      try {
        const nextPanelState = createRenderablePanelState();
        const nextSignature = createSignature(nextPanelState.viewModel);
        if (nextSignature !== materialPanelSignature) {
          materialPanel.update(nextPanelState.viewModel, {
            control: nextPanelState.controlOptions,
          });
          materialPanelSignature = nextSignature;
        }
      } catch (e) {
        console.warn("[panel-init] material topology 更新エラー:", e);
      }
    }, 1000);

    const changeBtn = body.querySelector("#filament-change-btn");
    if (changeBtn) {
      changeBtn.disabled = true;
      changeBtn.title = "CFS/CFS-C read-only表示ではスプール交換操作はまだ未対応です";
    }
    const removeBtn = body.querySelector("#filament-remove-btn");
    if (removeBtn) {
      removeBtn.disabled = true;
      removeBtn.title = "CFS/CFS-C read-only表示ではスプール取り外し操作はまだ未対応です";
    }
    const listBtn = body.querySelector("#filament-list-btn");
    if (listBtn) {
      listBtn.addEventListener("click", () => {
        try { showFilamentManager(0, hostname); } catch (e) {
          console.warn("[panel-init] filament manager エラー:", e);
        }
      });
    }
    return;
  }

  body.classList.remove("filament-panel-cfs-mode");

  body._materialTopologyModeListener = (event) => {
    const eventHost = event?.detail?.host;
    if (eventHost && eventHost !== hostname) {
      return;
    }
    const latestMachine = monitorData.machines[hostname] || {};
    const latestShadowRecord = latestMachine.runtimeData?.printerCoreV3Shadow || null;
    const latestTopology = resolveDisplayMaterialTopology({
      topology: latestShadowRecord?.lastState?.materials || null,
      shadowRecord: latestShadowRecord,
      observationStore: monitorData.materialSourceObservations || null,
      allowPersistentLastKnown: true,
      host: hostname,
    });
    const latestTarget = getConnectionTarget(hostname);
    const nextMode = resolveMaterialDisplayMode({
      target: latestTarget,
      printerType,
      topology: latestTopology,
    });
    if (nextMode === MATERIAL_DISPLAY_MODE.MULTI_SLOT) {
      initFilamentPanel(body, hostname);
    }
  };
  window.addEventListener("printer-core-v3-material-topology-updated", body._materialTopologyModeListener);

  // フィラメントプレビューを生成（per-host・スプール情報反映）
  /** @type {ReturnType<typeof createFilamentPreview>|null} */
  let preview = null;
  let autoRotateFooterButton = null;
  try {
    const spool = getCurrentSpool(hostname);
    // スプール未装着の場合はデフォルト満タン表示（0% 表示を防止）
    const defaultTotal = 330000;
    preview = createFilamentPreview(container, {
      filamentDiameter:         spool?.filamentDiameter ?? machine.settings?.filamentDiameterMm ?? 1.75,
      // スプール未装着時は storedData にフォールバックしない（再起動・リロード・取外し後のゴースト表示防止）
      filamentTotalLength:      spool ? (spool.totalLengthMm ?? defaultTotal) : defaultTotal,
      filamentCurrentLength:    spool ? (spool.remainingLengthMm ?? defaultTotal) : 0,
      filamentColor:            spool?.filamentColor ?? machine.settings?.filamentColor ?? "#22C55E",
      reelOuterDiameter:        spool?.reelOuterDiameter ?? 200,
      reelThickness:            spool?.reelThickness ?? 68,
      reelWindingInnerDiameter: spool?.reelWindingInnerDiameter ?? 95,
      reelCenterHoleDiameter:   spool?.reelCenterHoleDiameter ?? 54,
      widthPx:                  264,
      heightPx:                 264,
      showSlider:               false,
      isFilamentPresent:        !!spool,
      showUsedUpIndicator:      true,
      blinkingLightColor:       "#0EA5E9",
      showInfoLength:           false,
      showInfoPercent:          false,
      showInfoLayers:           false,
      showResetButton:          false,
      showProfileViewButton:    false,
      showSideViewButton:       false,
      showFrontViewButton:      false,
      showAutoRotateButton:     false,
      enableDrag:               true,
      enableClick:              false,
      onClick:                  null,
      disableInteraction:       true,
      showOverlayLength:        true,
      showOverlayPercent:       true,
      showLengthKg:             false,
      showReelName:             true,
      showReelSubName:          true,
      showMaterialName:         true,
      showMaterialColorName:    true,
      showMaterialColorCode:    true,
      showManufacturerName:     true,
      showOverlayBar:           true,
      showPurchaseButton:       true,
      onAutoRotateChange:       (enabled) => {
        autoRotateFooterButton?.classList.toggle("active", enabled);
        autoRotateFooterButton?.classList.toggle("dfv-btn-active", enabled);
      },
      reelName:                 spool?.name || "",
      reelSubName:              spool?.reelSubName || "",
      materialName:             spool?.materialName || spool?.material || "",
      materialColorName:        spool?.colorName || "",
      materialColorCode:        spool?.filamentColor || "",
      manufacturerName:         spool?.manufacturerName || spool?.brand || "",
    });
    /* per-host Map で管理（グローバル window.filamentPreview は廃止） */
    if (!window._filamentPreviews) window._filamentPreviews = new Map();
    window._filamentPreviews.set(hostname, preview);
    body._filamentPreview = preview;
  } catch (e) {
    console.warn("[panel-init] filament preview 生成エラー:", e);
  }

  // パネルリサイズ時にプレビューを拡縮
  if (preview) {
    const area = body.querySelector(".filament-preview-area");
    if (area) {
      const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) preview.resize(width, height);
        }
      });
      ro.observe(area);
      body._filamentResizeObserver = ro;
      // 初回サイズ適用
      requestAnimationFrame(() => {
        const rect = area.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) preview.resize(rect.width, rect.height);
      });
    }
  }

  // 交換・一覧ボタンのバインド
  const changeBtn = body.querySelector("#filament-change-btn");
  if (changeBtn) {
    changeBtn.addEventListener("click", async () => {
      try {
        await showFilamentChangeDialog(hostname);
      } catch (e) {
        console.error("[panel-init] filament change dialog エラー:", e);
      }
    });
  }
  const removeBtn = body.querySelector("#filament-remove-btn");
  if (removeBtn) {
    removeBtn.addEventListener("click", async () => {
      const spool = getCurrentSpool(hostname);
      if (!spool) {
        showAlert("スプールは装着されていません", "info");
        return;
      }
      const machineObj = monitorData.machines[hostname] || {};
      const displayHost = machineObj.storedData?.hostname?.rawValue
                       || machineObj.storedData?.model?.rawValue || hostname || "";
      const { showConfirmDialog } = await import("./dashboard_ui_confirm.js");
      const ok = await showConfirmDialog({
        level: "warn",
        title: "スプール取り外し",
        message: `${displayHost} から ${formatSpoolDisplayId(spool)} ${spool.name || ""} を取り外しますか？`,
        confirmText: "取り外す",
        cancelText: "キャンセル"
      });
      if (!ok) return;
      setCurrentSpoolId(null, hostname);
      // プレビューを未装着状態にリセット（全オーバーレイ属性をクリア）
      const hostPreview = window._filamentPreviews?.get(hostname);
      if (hostPreview) {
        hostPreview.setState({
          isFilamentPresent: false,
          filamentCurrentLength: spool.totalLengthMm || 330000,
          reelName: "", reelSubName: "",
          materialName: "", materialColorName: "",
          materialColorCode: "", manufacturerName: ""
        });
      }
    });
  }
  const listBtn = body.querySelector("#filament-list-btn");
  if (listBtn) {
    listBtn.addEventListener("click", () => {
      try { showFilamentManager(0, hostname); } catch (e) {
        console.warn("[panel-init] filament manager エラー:", e);
      }
    });
  }

  // 回転ボタンをフッターに統合 (CSS で dfv-controls を非表示にした代わり)
  // 操作ボタンと回転ボタンをそれぞれ nowrap グループに入れ、
  // セパレータは折り返し時に自動的に非表示になる
  if (preview) {
    const footer = body.querySelector(".filament-panel-footer");
    if (footer) {
      // 既存ボタンを操作グループで囲む
      const cmdGroup = document.createElement("span");
      cmdGroup.className = "fil-footer-group";
      while (footer.firstChild) cmdGroup.appendChild(footer.firstChild);
      footer.appendChild(cmdGroup);

      // セパレータ（折り返し時に CSS で非表示）
      const sep = document.createElement("span");
      sep.className = "fil-footer-sep";
      footer.appendChild(sep);

      // 回転ボタングループ
      const rotGroup = document.createElement("span");
      rotGroup.className = "fil-footer-group";
      const rotBtns = [
        { label: "⟲", title: "自動回転", action: () => preview.toggleAutoRotate(), auto: true },
        { label: "◐", title: "正面", action: () => preview.setFrontView() },
        { label: "◑", title: "横", action: () => preview.setSideView() },
        { label: "◉", title: "斜め", action: () => preview.setProfileView() },
      ];
      for (const { label, title, action, auto } of rotBtns) {
        const btn = document.createElement("button");
        btn.className = "btn fil-footer-rot-btn";
        btn.textContent = label;
        btn.title = title;
        if (auto) autoRotateFooterButton = btn;
        btn.addEventListener("click", action);
        rotGroup.appendChild(btn);
      }
      footer.appendChild(rotGroup);
    }
  }
}

/**
 * 温度グラフパネルの初期化
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initTempGraphPanel(body, hostname) {
  const canvas = body.querySelector("#temp-graph-canvas");
  if (!canvas) return;

  // 保持時間枠を保存設定（appSettings.chartWindowMin, 既定15分）から適用してから初期化
  setChartWindowMinutes(monitorData.appSettings.chartWindowMin ?? 15);

  // uPlot の初期化（per-host インスタンス）
  resetTemperatureGraph(hostname);
  initTemperatureGraph(body, hostname);

  // ★ M: リセット=「絞り込み(ドラッグズーム)解除」。データは破棄せず最新表示へ戻す。
  const resetBtn = body.querySelector("#temp-graph-reset-button");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetTemperatureGraphView(hostname);
    });
  }

  // ★ M: 現在の絞り込み範囲インジケータ（ロックボタンの右に表示）
  const rangeInd = body.querySelector(".temp-graph-toolbar")
    ? document.createElement("span") : null;
  if (rangeInd) {
    rangeInd.className = "temp-graph-range-ind";
    const setInd = (min) => { rangeInd.textContent = `範囲: 最新${min}分`; };
    setInd(Math.min(15, Math.round((monitorData.appSettings.chartWindowMin ?? 15))));
    body._tempGraphSetRangeInd = setInd;
  }

  // ★ M: 表示範囲（最新から N 分）絞り込みドロップダウン。選択でズーム解除＋スライド表示。
  const rangeSel = body.querySelector("#temp-graph-range");
  if (rangeSel) {
    rangeSel.value = String(Math.min(15, Math.round((monitorData.appSettings.chartWindowMin ?? 15))));
    rangeSel.addEventListener("change", () => {
      const eff = setChartViewMinutes(hostname, parseInt(rangeSel.value, 10));
      rangeSel.value = String(eff);
      body._tempGraphSetRangeInd?.(eff);
    });
  }

  // マウス操作ロックボタン（初期値: ロック=スクロール阻害防止）
  const lockBtn = document.createElement("button");
  lockBtn.className = "chart-interaction-lock locked temp-graph-btn";
  lockBtn.textContent = "🔒 操作ロック中";
  lockBtn.title = "グラフのズーム・パン操作を有効/無効にする";
  lockBtn.addEventListener("click", () => {
    const nowLocked = toggleChartInteractionLock(hostname);
    // ★ ロック解除時はドラッグで「絞り込み(ズーム)」できる状態 → ラベルを「絞込み可能」に
    lockBtn.textContent = nowLocked ? "🔒 操作ロック中" : "🔓 絞込み可能";
    lockBtn.classList.toggle("locked", nowLocked);
  });
  // 上部ツールバー（無ければリセットボタンの隣／canvas 前）へ配置
  const toolbar = body.querySelector(".temp-graph-toolbar");
  if (toolbar) {
    toolbar.appendChild(lockBtn);
    if (rangeInd) toolbar.appendChild(rangeInd);
  } else if (resetBtn?.parentElement) {
    resetBtn.parentElement.appendChild(lockBtn);
  } else {
    body.insertBefore(lockBtn, canvas);
  }
}

/**
 * 状態パネルの初期化（data-field バインディングのみ、追加初期化不要）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initStatusPanel(body, hostname) {
  // data-field 属性による自動バインディングのため、特別な初期化は不要
}

/**
 * 操作ボタンパネルの初期化（停止・一時停止等のボタンのみ）
 * initializeCommandPalette はグローバルに getElementById で探すため、
 * 温度パネル生成後にまとめて呼ぶ。ここではボタンのみに限定的にバインドする。
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initControlCmdPanel(body, hostname) {
  try {
    initializeCommandPalette(body, hostname);
    initSendRawJson(body, hostname);
    initSendGcode(body, hostname);
    initTestRawJson(body, hostname);
    initPauseHome(body, hostname);
    initXYUnlock(body, hostname);
  } catch (e) {
    console.warn("[panel-init] command palette 初期化エラー:", e);
  }
}

/**
 * 温度・ファン制御パネルの初期化
 * initializeCommandPalette を呼んでファン/温度/レート制御すべてをバインドする。
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initControlTempPanel(body, hostname) {
  try {
    initializeCommandPalette(body, hostname);
  } catch (e) {
    console.warn("[panel-init] command palette 初期化エラー:", e);
  }
}

/**
 * ログパネルの初期化
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initLogPanel(body, hostname) {
  const logBox = body.querySelector("#log");
  const notifBox = body.querySelector("#notification-history");

  if (logBox) {
    initLogAutoScroll(logBox);
    initLogRenderer(logBox, notifBox, hostname);
  }

  // タブ切り替え（受信ログ / 通知ログ / Gcode コンソール）
  const tabReceived = body.querySelector("#tab-received");
  const tabNotification = body.querySelector("#tab-notification");
  const tabGcode = body.querySelector("#tab-gcode");
  const gcodeBox = body.querySelector("#gcode-console");
  const tsReceivedEl = body.querySelector("#last-log-timestamp");
  const tsErrorEl = body.querySelector("#last-notification-timestamp");
  const logControlsEl = body.querySelector("#log-controls");
  const notifControlsEl = body.querySelector("#notification-controls");

  /**
   * 3 タブのうち 1 つを表示し、他を隠す。
   * @param {"received"|"notification"|"gcode"} which - 表示するタブ
   * @returns {void}
   */
  const selectLogTab = (which) => {
    const tabs = { received: tabReceived, notification: tabNotification, gcode: tabGcode };
    for (const [k, el] of Object.entries(tabs)) {
      if (el) el.classList.toggle("active", k === which);
    }
    if (logBox) logBox.classList.toggle("hidden", which !== "received");
    if (notifBox) notifBox.classList.toggle("hidden", which !== "notification");
    if (gcodeBox) gcodeBox.classList.toggle("hidden", which !== "gcode");
    if (tsReceivedEl) tsReceivedEl.classList.toggle("hidden", which !== "received");
    if (tsErrorEl) tsErrorEl.classList.toggle("hidden", which !== "notification");
    if (logControlsEl) logControlsEl.classList.toggle("hidden", which !== "received");
    if (notifControlsEl) notifControlsEl.classList.toggle("hidden", which !== "notification");
  };

  if (tabReceived) tabReceived.addEventListener("click", () => selectLogTab("received"));
  if (tabNotification) tabNotification.addEventListener("click", () => selectLogTab("notification"));
  if (tabGcode) tabGcode.addEventListener("click", () => selectLogTab("gcode"));

  // コピーボタン（HTML上のID: copy-all-button, copy-last-50-button, copy-storeddata-button,
  //   copy-all-notification-button, copy-last-50-notification-button）
  const copyAll = body.querySelector("#copy-all-button");
  if (copyAll) {
    copyAll.addEventListener("click", () => {
      const el = logBox || body.querySelector("#log");
      if (el) navigator.clipboard.writeText(el.innerText).catch(() => {});
    });
  }
  const copyLast50 = body.querySelector("#copy-last-50-button");
  if (copyLast50) {
    copyLast50.addEventListener("click", () => {
      const el = logBox || body.querySelector("#log");
      if (el) {
        const lines = el.innerText.split("\n");
        navigator.clipboard.writeText(lines.slice(-50).join("\n")).catch(() => {});
      }
    });
  }
  const copyStoredData = body.querySelector("#copy-storeddata-button");
  if (copyStoredData) {
    copyStoredData.addEventListener("click", () => {
      const hn = hostname === "shared" ? "" : hostname;
      const machine = monitorData.machines[hn];
      if (machine?.storedData) {
        navigator.clipboard.writeText(JSON.stringify(machine.storedData, null, 2)).catch(() => {});
      }
    });
  }
  // 通知ログ用コピーボタン
  const copyAllNotif = body.querySelector("#copy-all-notification-button");
  if (copyAllNotif) {
    copyAllNotif.addEventListener("click", () => {
      const el = notifBox || body.querySelector("#notification-history");
      if (el) navigator.clipboard.writeText(el.innerText).catch(() => {});
    });
  }
  const copyLast50Notif = body.querySelector("#copy-last-50-notification-button");
  if (copyLast50Notif) {
    copyLast50Notif.addEventListener("click", () => {
      const el = notifBox || body.querySelector("#notification-history");
      if (el) {
        const lines = el.innerText.split("\n");
        navigator.clipboard.writeText(lines.slice(-50).join("\n")).catch(() => {});
      }
    });
  }
  // 通知ログクリアボタン
  const clearNotif = body.querySelector("#clear-notification-logs-button");
  if (clearNotif) {
    clearNotif.addEventListener("click", () => {
      const el = notifBox || body.querySelector("#notification-history");
      if (el) el.innerHTML = "";
    });
  }
  // ※ コントロール(コピー/消去)ボタンの表示切替は selectLogTab() に統合済み。
}

/**
 * 現在の印刷パネルの初期化
 * パネルサイズに応じて横長/縦長レイアウトを切り替える。
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initCurrentPrintPanel(body, hostname) {
  const container = body.querySelector("#print-current-container");
  if (container) {
    printManager.renderPrintCurrent(container, hostname);
  }

  // パネルリサイズ時にコンテナに横長/縦長クラスを付与
  // （renderPrintCurrent で innerHTML が再生成されても維持される）
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      const portrait = height > width || (width > 600 && height > width * 0.35);
      body.classList.toggle("cp-portrait", portrait);
    }
  });
  ro.observe(body);
}

/**
 * 印刷履歴パネルの初期化（独立パネル、タブなし）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initHistoryPanel(body, hostname) {
  // 履歴再読み込みボタン（印刷履歴: reqHistory）
  const refreshBtn = body.querySelector("#history-refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      sendCommand("get", { reqHistory: 1 }, hostname);
    });
  }

  // 使用量 単位トグル（m/mm、全パネル共通・即時保存）
  const unitToggle = body.querySelector("#history-unit-toggle");
  if (unitToggle) {
    unitToggle.addEventListener("click", () => {
      const next = printManager.getFilamentUnit() === "m" ? "mm" : "m";
      printManager.setFilamentUnit(next);
    });
  }

  // 保存済み履歴を表示
  try {
    const jobs = printManager.loadHistory(hostname);
    if (jobs.length) {
      const baseUrl = getDisplayBaseUrl(hostname);
      const raw = printManager.jobsToRaw(jobs);
      printManager.renderHistoryTable(raw, baseUrl, hostname);
    }
  } catch (e) {
    console.warn("[panel-init] history render エラー:", e);
  }

  // 現在の単位設定をこのパネルのヘッダー/ボタン/セルへ反映
  try { printManager.applyFilamentUnitToUI(); } catch { /* 無視 */ }
}

/**
 * ファイル一覧パネルの初期化（独立パネル）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initFileListPanel(body, hostname) {
  // アップロードUIの初期化
  try {
    printManager.setupUploadUI(body, hostname);
  } catch (e) {
    console.warn("[panel-init] upload UI 初期化エラー:", e);
  }

  // ファイル一覧再読み込みボタン（ファイル一覧: reqGcodeFile）
  const refreshBtn = body.querySelector("#filelist-refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      sendCommand("get", { reqGcodeFile: 1 }, hostname);
    });
  }

  // 予定量 単位トグル（m/mm、全パネル共通・即時保存）
  const unitToggle = body.querySelector("#filelist-unit-toggle");
  if (unitToggle) {
    unitToggle.addEventListener("click", () => {
      const next = printManager.getFilamentUnit() === "m" ? "mm" : "m";
      printManager.setFilamentUnit(next);
    });
  }

  // キャッシュ済みファイル一覧を表示（パネル生成前にデータ受信済みの場合）
  try {
    const machine = monitorData.machines[hostname];
    if (machine?._cachedFileInfo) {
      const baseUrl = getDisplayBaseUrl(hostname);
      printManager.renderFileList(machine._cachedFileInfo, baseUrl, hostname);
    }
  } catch (e) {
    console.warn("[panel-init] file list render エラー:", e);
  }

  // 現在の単位設定をこのパネルのヘッダー/ボタン/セルへ反映
  try { printManager.applyFilamentUnitToUI(); } catch { /* 無視 */ }
}

/**
 * 機器情報パネルの初期化（data-field バインディングのみ）
 * @param {HTMLElement} body - パネル本体要素
 * @param {string} hostname - ホスト名
 */
function initMachineInfoPanel(body, hostname) {
  // data-field 属性による自動バインディングのため、特別な初期化は不要
}

/* initSettingsPanel は接続設定モーダルに統合済みのため削除 */

// ==============================
// 一括登録
// ==============================

/**
 * registerAllPanelInits:
 *   全パネル種別の初期化関数を一括登録する。
 *   bootPanelSystem() の初期段階で1度だけ呼び出す。
 */
export function registerAllPanelInits() {
  registerPanelInit("camera", initCameraPanel);
  registerPanelInit("head-preview", initHeadPreviewPanel);
  registerPanelInit("filament", initFilamentPanel);
  registerPanelInit("cfs-certification", initCfsCertificationPanel);
  registerPanelInit("status", initStatusPanel);
  registerPanelInit("control-cmd", initControlCmdPanel);
  registerPanelInit("control-temp", initControlTempPanel);
  registerPanelInit("temp-graph", initTempGraphPanel);
  registerPanelInit("machine-info", initMachineInfoPanel);
  registerPanelInit("log", initLogPanel);
  registerPanelInit("current-print", initCurrentPrintPanel);
  registerPanelInit("history", initHistoryPanel);
  registerPanelInit("file-list", initFileListPanel);
  registerPanelInit("production", initProductionPanel);
  registerPanelInit("job-cost", initJobCostPanel);
  registerPanelInit("host-ranking", initHostRankingPanel);
  registerPanelInit("material-report", initMaterialReportPanel);
  /* settings パネルは接続設定モーダルに統合済み */

  // 破棄関数
  registerPanelDestroy("camera", (body) => {
    /* パネル非表示時はレジストリから解除しストリームを停止する。
       cameraToggle はユーザが明示的にOFFにしない限り維持する。 */
    const hostname = body._cameraHostname;
    if (hostname) {
      unregisterCameraPanel(hostname);
    } else {
      /* フォールバック: レジストリ未登録の場合は直接クリア */
      const img = body.querySelector("img");
      if (img) {
        img.onload = null;
        img.onerror = null;
        img.removeAttribute("src");
        img.classList.add("off");
      }
    }
  });
  registerPanelDestroy("filament", (body, hostname) => {
    if (body._materialTopologyModeListener) {
      window.removeEventListener("printer-core-v3-material-topology-updated", body._materialTopologyModeListener);
      body._materialTopologyModeListener = null;
    }
    if (body._materialTopologyRefreshTimer) {
      clearInterval(body._materialTopologyRefreshTimer);
      body._materialTopologyRefreshTimer = null;
    }
    body._materialTopologyPanel?.destroy?.();
    body._materialTopologyPanel = null;
    if (body._filamentResizeObserver) {
      body._filamentResizeObserver.disconnect();
      body._filamentResizeObserver = null;
    }
    const preview = body._filamentPreview || window._filamentPreviews?.get(hostname);
    preview?.destroy?.();
    if (window._filamentPreviews) window._filamentPreviews.delete(hostname);
    body._filamentPreview = null;
  });
  registerPanelDestroy("cfs-certification", (body) => {
    if (body._cfsCertificationRefreshTimer) {
      clearInterval(body._cfsCertificationRefreshTimer);
      body._cfsCertificationRefreshTimer = null;
    }
    body._cfsCertificationPanel?.destroy?.();
    body._cfsCertificationPanel = null;
  });
  registerPanelDestroy("file-list", (body, hostname) => {
    /* アップロード UI レジストリから解除し detached DOM 参照を残さない */
    try { printManager.unregisterUploadPanel(hostname); } catch { /* 無視 */ }
  });
  registerPanelDestroy("head-preview", (body, hostname) => {
    destroyPreviewPanel(hostname);
  });
  registerPanelDestroy("temp-graph", (body, hostname) => {
    resetTemperatureGraph(hostname);
  });
  registerPanelDestroy("production", (body) => {
    if (body._productionTimer) {
      clearInterval(body._productionTimer);
      body._productionTimer = null;
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   生産管理パネル (Phase 3)
   ═══════════════════════════════════════════════════════════════ */

/**
 * 時間をHH:MM:SS形式にフォーマットする。
 * @param {number} sec - 秒
 * @returns {string}
 */
function _fmtTime(sec) {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ======================================================================
//  統計パネル — Phase 3: 印刷物コスト / 機器ランキング / 素材消費
// ======================================================================

/**
 * 印刷物コストパネル:
 * ファイル名ごとの成功率・平均時間・コスト・1個あたり真のコストを表示。
 */
function initJobCostPanel(body) {
  body.classList.add("stats-panel", "job-cost-panel");
  const container = document.createElement("div");
  container.className = "stats-panel-inner";
  const emptyMsg = createEmptyState({ icon: "📊", title: "印刷データなし", message: "印刷履歴が蓄積されるとコスト分析が表示されます" });
  emptyMsg.style.display = "none";
  body.append(emptyMsg, container);

  function update() {
    const report = buildJobCostReport();
    if (report.length === 0) {
      emptyMsg.style.display = "";
      container.style.display = "none";
      return;
    }
    emptyMsg.style.display = "none";
    container.style.display = "";
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "prod-section-title";
    title.textContent = "印刷物コスト分析";
    container.appendChild(title);

    const table = document.createElement("table");
    table.className = "registered-table stats-cost-table";
    table.innerHTML = `<thead><tr>
      <th scope="col">ファイル名</th>
      <th scope="col" class="text-right">回数</th>
      <th scope="col" class="text-right">成功率</th>
      <th scope="col" class="text-right">平均時間</th>
      <th scope="col" class="text-right">平均コスト</th>
      <th scope="col" class="text-right">1個あたり</th>
      <th scope="col" class="text-right">失敗ロス</th>
    </tr></thead><tbody></tbody>`;
    container.appendChild(table);

    const tbody = table.querySelector("tbody");
    for (const job of report.slice(0, 30)) {
      const tr = document.createElement("tr");
      const rateClass = job.successRate >= 0.9 ? "text-success" : job.successRate < 0.7 ? "text-danger" : "";
      const name = job.filename.length > 28 ? job.filename.slice(0, 25) + "…" : job.filename;
      tr.innerHTML =
        `<td title="${job.filename}">${name}</td>` +
        `<td class="text-right">${job.printCount}</td>` +
        `<td class="text-right ${rateClass}">${(job.successRate * 100).toFixed(0)}%</td>` +
        `<td class="text-right">${job.avgTimeSec > 0 ? _fmtTime(job.avgTimeSec) : "—"}</td>` +
        `<td class="text-right">${job.avgCostYen > 0 ? `¥${job.avgCostYen.toFixed(0)}` : "—"}</td>` +
        `<td class="text-right">${job.costPerSuccess > 0 ? `¥${job.costPerSuccess.toFixed(0)}` : "—"}</td>` +
        `<td class="text-right">${job.wastedCostYen > 0 ? `<span class="text-danger">¥${job.wastedCostYen.toFixed(0)}</span>` : "—"}</td>`;
      tbody.appendChild(tr);
    }
  }

  update();
  // 60秒ごとに更新
  const timer = setInterval(update, 60000);
  body._statsCleanup = () => clearInterval(timer);
}

/**
 * 機器ランキングパネル:
 * 各プリンタの稼働率・成功率・コスト効率をランキング表示。
 */
function initHostRankingPanel(body) {
  body.classList.add("stats-panel", "host-ranking-panel");
  const container = document.createElement("div");
  container.className = "stats-panel-inner";
  const emptyMsg = createEmptyState({ icon: "🏆", title: "機器データなし", message: "プリンタを接続すると稼働ランキングが表示されます" });
  emptyMsg.style.display = "none";
  body.append(emptyMsg, container);

  function update() {
    const ranking = buildHostRanking();
    if (ranking.length === 0) {
      emptyMsg.style.display = "";
      container.style.display = "none";
      return;
    }
    emptyMsg.style.display = "none";
    container.style.display = "";
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "prod-section-title";
    title.textContent = "機器ランキング";
    container.appendChild(title);

    for (const host of ranking) {
      const card = document.createElement("div");
      card.className = "stat-host-rank-card";
      const rateClass = host.successRate >= 0.9 ? "text-success" : host.successRate < 0.7 ? "text-danger" : "";
      const filamentM = (host.totalMaterialMm / 1000).toFixed(1);
      card.innerHTML =
        `<div class="rank-badge">#${host.rank}</div>` +
        `<div class="rank-host-info">` +
          `<div class="rank-host-name">${host.displayName}</div>` +
          `<div class="rank-host-stats">` +
            `<span>稼働率 <strong>${host.utilizationPct}%</strong></span>` +
            `<span class="${rateClass}">成功率 <strong>${(host.successRate * 100).toFixed(0)}%</strong></span>` +
            `<span>印刷 <strong>${host.totalPrintCount}回</strong></span>` +
            `<span>消費 <strong>${filamentM}m</strong></span>` +
            (host.totalCostYen > 0 ? `<span>コスト <strong>¥${host.totalCostYen.toFixed(0)}</strong></span>` : "") +
            (host.costPerSuccessPrint > 0 ? `<span>1回あたり <strong>¥${host.costPerSuccessPrint.toFixed(0)}</strong></span>` : "") +
          `</div>` +
        `</div>` +
        `<div class="rank-util-bar"><div class="rank-util-fill" style="width:${host.utilizationPct}%"></div></div>`;
      container.appendChild(card);
    }
  }

  update();
  const timer = setInterval(update, 60000);
  body._statsCleanup = () => clearInterval(timer);
}

/**
 * 素材消費レポートパネル:
 * プリセット別の消費量・コスト・月別推移を表示。
 */
function initMaterialReportPanel(body) {
  body.classList.add("stats-panel", "material-report-panel");
  const container = document.createElement("div");
  container.className = "stats-panel-inner";
  const emptyMsg = createEmptyState({ icon: "🎨", title: "素材データなし", message: "フィラメントを使用すると素材別レポートが表示されます" });
  emptyMsg.style.display = "none";
  body.append(emptyMsg, container);

  function update() {
    const report = buildMaterialReport();
    if (report.length === 0) {
      emptyMsg.style.display = "";
      container.style.display = "none";
      return;
    }
    emptyMsg.style.display = "none";
    container.style.display = "";
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "prod-section-title";
    title.textContent = "素材消費レポート";
    container.appendChild(title);

    for (const mat of report) {
      const card = document.createElement("div");
      card.className = "stat-material-card";
      const consumedM = (mat.totalConsumedMm / 1000).toFixed(1);
      // 月別推移の簡易バー（直近6ヶ月）
      const recentMonths = mat.monthlyTrend.slice(-6);
      const maxMm = Math.max(...recentMonths.map(m => m.consumedMm), 1);
      let trendHtml = "";
      if (recentMonths.length > 0) {
        trendHtml = `<div class="material-trend">` +
          recentMonths.map(m => {
            const pct = Math.round(m.consumedMm / maxMm * 100);
            const label = m.month.slice(5); // "04" etc
            return `<div class="trend-bar-col"><div class="trend-bar" style="height:${pct}%" title="${m.month}: ${(m.consumedMm/1000).toFixed(1)}m / ¥${m.costYen.toFixed(0)}"></div><div class="trend-label">${label}</div></div>`;
          }).join("") +
          `</div>`;
      }

      card.innerHTML =
        `<div class="material-header">` +
          `<span class="material-color-dot" style="background:${mat.filamentColor}"></span>` +
          `<span class="material-name">${mat.brand} ${mat.material} ${mat.colorName}</span>` +
        `</div>` +
        `<div class="material-stats">` +
          `<span>消費 <strong>${consumedM}m</strong></span>` +
          `<span>スプール <strong>${mat.spoolCount}本</strong></span>` +
          `<span>印刷 <strong>${mat.printCount}回</strong></span>` +
          (mat.totalCostYen > 0 ? `<span>累計 <strong>¥${mat.totalCostYen.toFixed(0)}</strong></span>` : "") +
        `</div>` +
        trendHtml;
      container.appendChild(card);
    }
  }

  update();
  const timer = setInterval(update, 60000);
  body._statsCleanup = () => clearInterval(timer);
}

/**
 * 生産管理パネルを初期化する。
 * フリート全体の稼働率、日次レポート、予定vs実績を表示。
 *
 * @param {HTMLElement} body - パネル本体の DOM 要素
 */
function initProductionPanel(body) {
  body.classList.add("production-panel");

  // 固定コンテナ（初回のみ作成、更新時は中身だけ差し替え）
  const summaryContainer = document.createElement("div");
  summaryContainer.className = "stat-cards";

  const hostContainer = document.createElement("div");
  hostContainer.className = "prod-host-section";

  const dailyContainer = document.createElement("div");
  dailyContainer.className = "prod-daily-section";

  const evaContainer = document.createElement("div");
  evaContainer.className = "prod-eva-section";

  // 空状態メッセージ（統一コンポーネント）
  const emptyMsg = createEmptyState({
    icon: "🖨️",
    title: "プリンタ未接続",
    message: "接続設定からプリンタを追加してください"
  });
  emptyMsg.style.display = "none";

  body.append(emptyMsg, summaryContainer, hostContainer, dailyContainer, evaContainer);

  /**
   * データ取得 → 各コンテナの中身を差し替え。
   * スクロール位置・フォーカスを保持するため body.innerHTML は使わない。
   */
  function update() {
    const fleet = buildFleetSummary();
    const daily = buildDailyProductionReport({ days: 7 });

    // 空状態チェック
    if (fleet.totalHosts === 0) {
      emptyMsg.style.display = "";
      summaryContainer.style.display = "none";
      hostContainer.style.display = "none";
      dailyContainer.style.display = "none";
      evaContainer.style.display = "none";
      return;
    }
    emptyMsg.style.display = "none";
    summaryContainer.style.display = "";
    hostContainer.style.display = "";

    // ── 1) フリートサマリーカード（中身だけ差し替え）──
    summaryContainer.innerHTML = "";
    [
      { label: "接続台数", value: `${fleet.activeHosts}/${fleet.totalHosts}台`, sub: `${fleet.printingHosts}台印刷中` },
      { label: "フリート稼働率", value: `${fleet.fleetUtilizationPct}%` },
      { label: "本日の印刷数", value: `${fleet.totalPrintCount}回`, sub: `成功${fleet.totalSuccessCount} / 失敗${fleet.totalFailCount}` },
      { label: "合計印刷時間", value: _fmtTime(fleet.totalPrintTimeMs / 1000) }
    ].forEach(c => {
      const card = document.createElement("div");
      card.className = "stat-card";
      card.innerHTML = `<div class="stat-card-label">${c.label}</div><div class="stat-card-value">${c.value}</div>${c.sub ? `<div class="stat-card-sub">${c.sub}</div>` : ""}`;
      summaryContainer.appendChild(card);
    });

    // ── 2) per-host 稼働率バー ──
    hostContainer.innerHTML = "";
    if (fleet.hosts.length > 0) {
      const hostTitle = document.createElement("div");
      hostTitle.className = "prod-section-title";
      hostTitle.textContent = "機器別稼働率 (24h)";
      hostContainer.appendChild(hostTitle);

      for (const h of fleet.hosts) {
        const row = document.createElement("div");
        row.className = "prod-host-row";
        const nameSpan = document.createElement("span");
        nameSpan.className = "prod-host-name";
        nameSpan.textContent = h.displayName;

        const barWrap = document.createElement("div");
        barWrap.className = "prod-util-bar-wrap";
        const bar = document.createElement("div");
        bar.className = "prod-util-bar";
        const fill = document.createElement("div");
        fill.className = `prod-util-bar-fill${h.isPrinting ? " printing" : ""}`;
        fill.style.width = `${h.utilizationPct}%`;
        bar.appendChild(fill);
        barWrap.appendChild(bar);

        const pctLabel = document.createElement("span");
        pctLabel.className = "prod-util-pct";
        pctLabel.textContent = `${h.utilizationPct}%`;

        const statusSpan = document.createElement("span");
        statusSpan.className = `prod-host-status${h.isPrinting ? " active" : ""}`;
        statusSpan.textContent = h.isPrinting
          ? `🖨 ${h.currentJobProgress}%`
          : `${h.printCount}回完了`;

        row.append(nameSpan, barWrap, pctLabel, statusSpan);
        hostContainer.appendChild(row);
      }
    }

    // ── 3) 日次生産テーブル（tbodyのみ差し替え）──
    if (daily.length > 0) {
      dailyContainer.style.display = "";
      // 初回のみヘッダ構築
      if (!dailyContainer.querySelector("table")) {
        const dailyTitle = document.createElement("div");
        dailyTitle.className = "prod-section-title";
        dailyTitle.textContent = "日次生産レポート (7日間)";
        const table = document.createElement("table");
        table.className = "registered-table prod-daily-table";
        table.innerHTML = `<thead><tr>
          <th scope="col">日付</th>
          <th scope="col" class="text-right">印刷数</th>
          <th scope="col" class="text-right">成功</th>
          <th scope="col" class="text-right">失敗</th>
          <th scope="col" class="text-right">合計時間</th>
          <th scope="col" class="text-right">消費量</th>
        </tr></thead><tbody></tbody>`;
        dailyContainer.append(dailyTitle, table);
      }
      const tbody = dailyContainer.querySelector("tbody");
      tbody.innerHTML = "";
      for (const day of daily) {
        const tr = document.createElement("tr");
        const filFmt = day.totalFilamentMm > 0 ? `${(day.totalFilamentMm / 1000).toFixed(1)}m` : "—";
        tr.innerHTML =
          `<td>${day.date}</td>` +
          `<td class="text-right">${day.printCount}</td>` +
          `<td class="text-right">${day.successCount}</td>` +
          `<td class="text-right">${day.failCount > 0 ? `<span class="text-danger">${day.failCount}</span>` : "0"}</td>` +
          `<td class="text-right">${_fmtTime(day.totalPrintTimeSec)}</td>` +
          `<td class="text-right">${filFmt}</td>`;
        tbody.appendChild(tr);
      }
    } else {
      dailyContainer.style.display = "none";
    }

    // ── 4) 予定vs実績（tbodyのみ差し替え）──
    const allEstVsAct = [];
    for (const h of fleet.hosts) {
      const items = buildEstimateVsActual(h.hostname);
      items.forEach(i => { i._host = h.displayName; });
      allEstVsAct.push(...items);
    }
    allEstVsAct.sort((a, b) => b.printCount - a.printCount);
    const top10 = allEstVsAct.slice(0, 10);

    if (top10.length > 0) {
      evaContainer.style.display = "";
      // 初回のみヘッダ構築
      if (!evaContainer.querySelector("table")) {
        const evaTitle = document.createElement("div");
        evaTitle.className = "prod-section-title";
        evaTitle.textContent = "予定 vs 実績 (Top 10)";
        const evaTable = document.createElement("table");
        evaTable.className = "registered-table prod-eva-table";
        evaTable.innerHTML = `<thead><tr>
          <th scope="col">ファイル</th>
          <th scope="col" class="text-right">回数</th>
          <th scope="col" class="text-right">見積</th>
          <th scope="col" class="text-right">実績平均</th>
          <th scope="col" class="text-right">差異</th>
        </tr></thead><tbody></tbody>`;
        evaContainer.append(evaTitle, evaTable);
      }
      const evaTbody = evaContainer.querySelector("tbody");
      evaTbody.innerHTML = "";
      for (const item of top10) {
        const tr = document.createElement("tr");
        const diffClass = item.diffPct > 10 ? "text-danger" :
                          item.diffPct < -10 ? "text-success" : "";
        const diffSign = item.diffPct > 0 ? "+" : "";
        tr.innerHTML =
          `<td title="${item.filename}">${item.filename.length > 30 ? item.filename.slice(0, 27) + "…" : item.filename}</td>` +
          `<td class="text-right">${item.printCount}回</td>` +
          `<td class="text-right">${item.estimatedSec > 0 ? _fmtTime(item.estimatedSec) : "—"}</td>` +
          `<td class="text-right">${_fmtTime(item.actualAvgSec)}</td>` +
          `<td class="text-right ${diffClass}">${item.estimatedSec > 0 ? `${diffSign}${item.diffPct}%` : "—"}</td>`;
        evaTbody.appendChild(tr);
      }
    } else {
      evaContainer.style.display = "none";
    }
  }

  update();
  // 30秒ごとに差分更新（スクロール位置を維持）
  body._productionTimer = setInterval(update, 30000);
}
