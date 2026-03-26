/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 パネルブートストラップ モジュール
 * @file dashboard_panel_boot.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_panel_boot
 *
 * 【機能内容サマリ】
 * - GridStack パネルシステムの起動処理
 * - 既存 HTML 構造からパネルテンプレートを抽出
 * - 初回起動時のデフォルトレイアウトを構築
 * - 2回目以降は保存済みレイアウトを復元
 *
 * 【公開関数一覧】
 * - {@link bootPanelSystem}：パネルシステムを起動
 *
 * @version 1.390.783 (PR #366)
 * @since   1.390.783 (PR #366)
 * @lastModified 2026-03-10 21:00:00
 * -----------------------------------------------------------
 * @todo
 * - テンプレート抽出の自動化改善
 */

"use strict";

import { initGridStack, restoreLayout, updateAllPanelHeaders, toggleGlobalLock, unlockAllPanels } from "./dashboard_panel_factory.js";
import { initPanelMenu } from "./dashboard_panel_menu.js";
import { registerAllPanelInits } from "./dashboard_panel_init.js";
import { connectWs, updatePrinterListUI } from "./dashboard_connection.js";
import { monitorData } from "./dashboard_data.js";
import { notificationManager } from "./dashboard_notification_manager.js";
import { registerPrintManagerAccessor } from "./dashboard_spool.js";
import { getFileList, buildFileInsight } from "./dashboard_printmanager.js";

/**
 * パネルシステムモードが有効かどうか。
 * true の場合、既存の固定レイアウトを非表示にし GridStack で管理する。
 * false の場合、従来通りの固定レイアウトで動作する。
 *
 * @constant {boolean}
 */
const PANEL_MODE_ENABLED = true;

/**
 * パネルシステムを起動する。
 *
 * 【詳細説明】
 * - パネルモードが有効な場合:
 *   1. 既存のカード要素を非表示にする
 *   2. GridStack コンテナを DOM に挿入
 *   3. パネルテンプレートを既存カード要素から生成
 *   4. 保存済みレイアウトの復元、またはデフォルトレイアウトの構築
 *   5. パネル追加メニューを初期化
 * - パネルモードが無効な場合:
 *   何もしない（従来の固定レイアウトがそのまま使われる）
 *
 * @function bootPanelSystem
 * @returns {boolean} パネルシステムが起動した場合 true
 */
export function bootPanelSystem() {
  if (!PANEL_MODE_ENABLED) {
    console.info("bootPanelSystem: パネルモード無効、従来レイアウトで動作");
    return false;
  }

  /* (0) パネル初期化関数レジストリを登録 */
  registerAllPanelInits();

  /* (0a) printmanager アクセサを spool.js に登録（循環参照回避） */
  registerPrintManagerAccessor({ getFileList, buildFileInsight });

  /* (0b) 従来タイトルバーを非表示にし、トップメニューバーに置き換え */
  const titleBar = document.querySelector(".title-bar");
  if (titleBar) titleBar.style.display = "none";

  /* (1) 既存カード要素をテンプレート化 */
  _convertCardsToTemplates();

  /* (2) GridStack コンテナを DOM に挿入 */
  const gridContainer = document.createElement("div");
  gridContainer.className = "grid-stack";
  gridContainer.id = "panel-grid";

  /* トップメニューバーの直後に挿入 */
  const topMenuBar = document.getElementById("top-menu-bar");
  if (topMenuBar && topMenuBar.nextSibling) {
    topMenuBar.parentNode.insertBefore(gridContainer, topMenuBar.nextSibling);
  } else if (titleBar && titleBar.nextSibling) {
    titleBar.parentNode.insertBefore(gridContainer, titleBar.nextSibling);
  } else {
    document.body.appendChild(gridContainer);
  }

  /* (3) GridStack を初期化 */
  initGridStack("#panel-grid");

  /* (4) レイアウト復元
   *    保存済みレイアウトがあれば復元する。
   *    無い場合（初回起動等）はパネルを生成しない。
   *    接続先が確定した時点で _syncPanelsForHost() → ensureHostPanels()
   *    によってそのホスト用のパネルが自動生成される。 */
  restoreLayout();

  /* (5) パネルメニュー初期化 */
  initPanelMenu();

  /* (6) トップメニューバー・接続モーダルのイベントバインド */
  _initTopMenuBar();

  console.info("bootPanelSystem: パネルシステム起動完了");
  return true;
}

/* ─── 内部ヘルパー ─── */

/**
 * 既存 HTML のカード要素を <template> に変換する。
 *
 * 【詳細説明】
 * - 各カード要素を非表示にし、対応する <template> を body 末尾に追加
 * - 元のDOMは hidden にして残す（data-field バインディングの参照元として）
 * - テンプレートIDは PANEL_TYPES の templateId に一致させる
 *
 * @private
 * @function _convertCardsToTemplates
 * @returns {void}
 */
function _convertCardsToTemplates() {
  /**
   * カードセレクタとテンプレートIDの対応表
   * @type {Array<{selector: string, templateId: string, keepOriginal: boolean}>}
   */
  const cardMappings = [
    {
      selector: ".camera-card",
      templateId: "panel-tpl-camera",
      keepOriginal: false
    },
    {
      selector: ".preview-wrapper",
      templateId: "panel-tpl-head-preview",
      keepOriginal: false
    },
    {
      selector: ".info-wrapper .col1",
      templateId: "panel-tpl-status",
      keepOriginal: false
    },
    {
      selector: ".info-wrapper .col2",
      templateId: "panel-tpl-control-cmd",
      keepOriginal: false,
      splitControl: true
    },
    {
      selector: "#filament-preview-card",
      templateId: "panel-tpl-filament",
      keepOriginal: false
    },
    {
      selector: "#temp-graph-card",
      templateId: "panel-tpl-temp-graph",
      keepOriginal: false
    },
    {
      selector: ".info-card",
      templateId: "panel-tpl-machine-info",
      keepOriginal: false
    },
    {
      selector: ".log-card",
      templateId: "panel-tpl-log",
      keepOriginal: false
    },
    {
      selector: "#print-current-card",
      templateId: "panel-tpl-current-print",
      keepOriginal: false
    },
    /* settings-card は接続設定モーダルに統合済みのため、テンプレート抽出不要 */
    {
      selector: "#print-history-card",
      templateId: "panel-tpl-history",
      keepOriginal: false,
      splitHistory: true
    }
  ];

  for (const mapping of cardMappings) {
    const originalEl = document.querySelector(mapping.selector);
    if (!originalEl) {
      console.warn(`_convertCardsToTemplates: 要素が見つかりません: ${mapping.selector}`);
      continue;
    }

    if (mapping.splitControl) {
      /* 操作パネルを2つに分割:
         - control-cmd: ボタンのみ（cmd-group 要素群）
         - control-temp: 温度・ファン制御（.control-temp-area） */
      const clone = originalEl.cloneNode(true);

      /* テンプレート1: 操作ボタン */
      const tplCmd = document.createElement("template");
      tplCmd.id = "panel-tpl-control-cmd";
      const cmdWrapper = document.createElement("div");
      cmdWrapper.className = "col2 control-cmd-panel";
      const cmdGroups = clone.querySelectorAll(".cmd-group");
      cmdGroups.forEach(g => cmdWrapper.appendChild(g.cloneNode(true)));
      tplCmd.content.appendChild(cmdWrapper);
      document.body.appendChild(tplCmd);

      /* テンプレート2: 温度・ファン制御 */
      const tplTemp = document.createElement("template");
      tplTemp.id = "panel-tpl-control-temp";
      const tempWrapper = document.createElement("div");
      tempWrapper.className = "col2 control-temp-panel";
      const tempArea = clone.querySelector(".control-temp-area");
      if (tempArea) tempWrapper.appendChild(tempArea.cloneNode(true));
      tplTemp.content.appendChild(tempWrapper);
      document.body.appendChild(tplTemp);

      originalEl.remove();
      continue;
    }

    if (mapping.splitHistory) {
      /* 印刷履歴を2つの独立パネルに分割:
         - history: 印刷履歴テーブル
         - file-list: ファイル一覧テーブル + アップロード */
      const clone = originalEl.cloneNode(true);

      /* テンプレート1: 印刷履歴 */
      const tplHistory = document.createElement("template");
      tplHistory.id = "panel-tpl-history";
      const histSection = clone.querySelector("#panel-print-history-section");
      if (histSection) {
        const histWrapper = document.createElement("div");
        histWrapper.className = "print-history-card history-panel";
        histWrapper.appendChild(histSection.cloneNode(true));
        tplHistory.content.appendChild(histWrapper);
      }
      document.body.appendChild(tplHistory);

      /* テンプレート2: ファイル一覧 */
      const tplFileList = document.createElement("template");
      tplFileList.id = "panel-tpl-file-list";
      const fileSection = clone.querySelector("#panel-file-list-section");
      if (fileSection) {
        const fileWrapper = document.createElement("div");
        fileWrapper.className = "file-list-card file-list-panel";
        fileWrapper.appendChild(fileSection.cloneNode(true));
        tplFileList.content.appendChild(fileWrapper);
      }
      document.body.appendChild(tplFileList);

      originalEl.remove();
      continue;
    }

    /* 生産管理パネル: HTML由来ではなくJS動的生成 — 空テンプレートを登録 */
    if (!document.getElementById("panel-tpl-production")) {
      const tplProd = document.createElement("template");
      tplProd.id = "panel-tpl-production";
      const prodDiv = document.createElement("div");
      prodDiv.className = "production-panel-root";
      tplProd.content.appendChild(prodDiv);
      document.body.appendChild(tplProd);
    }

    /* テンプレートを生成 */
    const tpl = document.createElement("template");
    tpl.id = mapping.templateId;

    /* 元の要素の内容をテンプレートに複製 */
    tpl.content.appendChild(originalEl.cloneNode(true));

    /* テンプレートを body 末尾に追加 */
    document.body.appendChild(tpl);

    /* テンプレートに複製済みなので元の要素をDOMから除去する。
       display:none で残すと data-field の重複マッチが発生するため削除する。 */
    originalEl.remove();
  }

  /* 空になった親コンテナもDOMから除去する */
  const emptyContainers = [
    ".equip-status-card",
    ".monitor-row",
    "#graph-current-wrapper"
  ];
  for (const sel of emptyContainers) {
    const el = document.querySelector(sel);
    if (el) el.remove();
  }
}

/**
 * トップメニューバーと接続設定モーダルのイベントハンドラを設定する。
 *
 * @private
 * @function _initTopMenuBar
 * @returns {void}
 */
function _initTopMenuBar() {
  /* レイアウトロックボタン */
  const lockBtn = document.getElementById("top-layout-lock");
  if (lockBtn) {
    // 起動時にロック状態を復元
    if (monitorData.appSettings.layoutLocked) {
      toggleGlobalLock(true);
      lockBtn.textContent = "🔒 固定中";
      lockBtn.title = "レイアウト解除";
    }
    lockBtn.addEventListener("click", () => {
      const locked = toggleGlobalLock();
      lockBtn.textContent = locked ? "🔒 固定中" : "🔓 固定";
      lockBtn.title = locked ? "レイアウト解除" : "レイアウト固定";
    });
  }

  /* 接続設定ボタン → モーダル開閉 */
  const connBtn = document.getElementById("top-conn-btn");
  const overlay = document.getElementById("conn-modal-overlay");
  const closeBtn = document.getElementById("conn-modal-close");

  if (connBtn && overlay) {
    connBtn.addEventListener("click", () => {
      /* モーダル表示前にプリンタリストを最新化
         （保存済み未接続の接続先も正しく表示するため） */
      updatePrinterListUI();

      overlay.classList.add("open");
      /* 各設定をモーダルに同期 */
      const modalAuto = document.getElementById("conn-modal-auto-connect");
      if (modalAuto) modalAuto.checked = monitorData.appSettings.autoConnect;

      const modalHostTag = document.getElementById("conn-modal-show-host-tag");
      if (modalHostTag) modalHostTag.checked = monitorData.appSettings.showHostTag !== false;

      const camPort = document.getElementById("conn-modal-camera-port");
      if (camPort) camPort.value = monitorData.appSettings.cameraPort || 8080;

      /* 入力欄をクリア */
      const modalIp = document.getElementById("conn-modal-ip");
      if (modalIp) modalIp.value = "";
    });
  }
  /* モーダルを閉じる際に設定を保存・反映 */
  const _closeModal = () => {
    if (!overlay) return;
    overlay.classList.remove("open");
    _syncModalSettings();
  };
  if (closeBtn) closeBtn.addEventListener("click", _closeModal);
  if (overlay) {
    overlay.addEventListener("click", e => {
      if (e.target === overlay) _closeModal();
    });
  }

  /**
   * モーダル内の設定値を monitorData に同期し、パネルヘッダーを更新する。
   * @private
   */
  function _syncModalSettings() {
    const modalAuto = document.getElementById("conn-modal-auto-connect");
    if (modalAuto) monitorData.appSettings.autoConnect = modalAuto.checked;

    const modalHostTag = document.getElementById("conn-modal-show-host-tag");
    if (modalHostTag) {
      const prev = monitorData.appSettings.showHostTag;
      monitorData.appSettings.showHostTag = modalHostTag.checked;
      if (prev !== modalHostTag.checked) updateAllPanelHeaders();
    }

    const camPort = document.getElementById("conn-modal-camera-port");
    if (camPort && camPort.value) {
      monitorData.appSettings.cameraPort = parseInt(camPort.value, 10) || 8080;
    }
  }

  /* モーダル内の「接続追加」ボタン（統一パス） */
  const modalConnect = document.getElementById("conn-modal-connect");
  if (modalConnect) {
    modalConnect.addEventListener("click", () => {
      const ip = document.getElementById("conn-modal-ip")?.value.trim();
      if (!ip) return;

      /* 設定を同期 */
      _syncModalSettings();

      /* connectWs は内部で _addConnectionTarget を呼んで永続化する。
         wsDest は後方互換のためメイン接続先として保持する。 */
      if (!monitorData.appSettings.wsDest) {
        monitorData.appSettings.wsDest = ip;
      }
      connectWs(ip);

      /* 入力欄をクリア */
      const modalIpEl = document.getElementById("conn-modal-ip");
      if (modalIpEl) modalIpEl.value = "";
    });
  }

  /* ── 通知設定サブモーダル ── */
  const notifBtn     = document.getElementById("conn-modal-notif-btn");
  const notifOverlay = document.getElementById("notif-modal-overlay");
  const notifClose   = document.getElementById("notif-modal-close");
  const notifBody    = document.getElementById("notif-modal-body");

  if (notifBtn && notifOverlay) {
    /** @private 通知モーダルを初期化して開く */
    notifBtn.addEventListener("click", () => {
      notificationManager.initModalUI(notifBody);
      notifOverlay.classList.add("open");
    });
  }
  if (notifClose) {
    notifClose.addEventListener("click", () => {
      notifOverlay.classList.remove("open");
    });
  }
  if (notifOverlay) {
    notifOverlay.addEventListener("click", e => {
      if (e.target === notifOverlay) notifOverlay.classList.remove("open");
    });
  }

  // ストレージ設定サブモーダル
  const storageBtn = document.getElementById("conn-modal-storage-btn");
  const storageOverlay = document.getElementById("storage-modal-overlay");
  const storageClose = document.getElementById("storage-modal-close");
  if (storageBtn && storageOverlay) {
    storageBtn.addEventListener("click", () => {
      storageOverlay.classList.add("open");
    });
  }
  if (storageClose && storageOverlay) {
    storageClose.addEventListener("click", () => {
      storageOverlay.classList.remove("open");
    });
  }
  if (storageOverlay) {
    storageOverlay.addEventListener("click", e => {
      if (e.target === storageOverlay) storageOverlay.classList.remove("open");
    });
  }

  /* ─── オーディオ トグルボタン（トップバー） ─── */
  const soundBtn = document.getElementById("top-sound-btn");
  const ttsBtn = document.getElementById("top-tts-btn");

  /**
   * トップバーのオーディオボタン表示を更新する。
   * AudioManager の状態を反映し、テスト未完了/失敗/有効/無効を視覚化。
   */
  function _updateTopAudioButtons() {
    const am = window.audioManager;
    if (!am) return;

    if (soundBtn) {
      if (!am.Tm && !am.c) {
        // テスト未実行: タップ促し
        soundBtn.textContent = "🔇";
        soundBtn.title = "効果音: タップして有効化";
        soundBtn.classList.add("top-audio-untested");
        soundBtn.classList.remove("top-audio-off");
      } else if (!am.Tm) {
        // テスト失敗
        soundBtn.textContent = "🔇";
        soundBtn.title = "効果音: テスト失敗（タップで再テスト）";
        soundBtn.classList.add("top-audio-off");
        soundBtn.classList.remove("top-audio-untested");
      } else if (am.Am) {
        soundBtn.textContent = "🔊";
        soundBtn.title = "効果音: ON（クリックでOFF）";
        soundBtn.classList.remove("top-audio-off", "top-audio-untested");
      } else {
        soundBtn.textContent = "🔇";
        soundBtn.title = "効果音: OFF（クリックでON）";
        soundBtn.classList.add("top-audio-off");
        soundBtn.classList.remove("top-audio-untested");
      }
    }

    if (ttsBtn) {
      if (!am.Tv && !am.c) {
        ttsBtn.textContent = "🗣";
        ttsBtn.title = "読み上げ: タップして有効化";
        ttsBtn.classList.add("top-audio-untested");
        ttsBtn.classList.remove("top-audio-off");
      } else if (!am.Tv) {
        ttsBtn.textContent = "🗣";
        ttsBtn.title = "読み上げ: テスト失敗（タップで再テスト）";
        ttsBtn.classList.add("top-audio-off");
        ttsBtn.classList.remove("top-audio-untested");
      } else if (am.Av) {
        ttsBtn.textContent = "🗣";
        ttsBtn.title = "読み上げ: ON（クリックでOFF）";
        ttsBtn.classList.remove("top-audio-off", "top-audio-untested");
      } else {
        ttsBtn.textContent = "🗣";
        ttsBtn.title = "読み上げ: OFF（クリックでON）";
        ttsBtn.classList.add("top-audio-off");
        ttsBtn.classList.remove("top-audio-untested");
      }
    }
  }

  if (soundBtn) {
    soundBtn.addEventListener("click", () => {
      const am = window.audioManager;
      if (!am) return;
      // テスト未通過: テスト実行（ユーザージェスチャー内なのでautoplay解除される）
      if (!am.Tm) {
        am._testMusic().then(() => {
          am.c = true;
          am._updateButtons();
          _updateTopAudioButtons();
        });
      } else {
        am.Am = !am.Am;
        am._updateButtons();
        _updateTopAudioButtons();
      }
    });
  }

  if (ttsBtn) {
    ttsBtn.addEventListener("click", () => {
      const am = window.audioManager;
      if (!am) return;
      if (!am.Tv) {
        am._testVoice().then(() => {
          am.c = true;
          am._updateButtons();
          _updateTopAudioButtons();
        });
      } else {
        am.Av = !am.Av;
        am._updateButtons();
        _updateTopAudioButtons();
      }
    });
  }

  // 初回表示更新（AudioManager初期化後に実行されるため遅延）
  setTimeout(_updateTopAudioButtons, 1000);
  // AudioManagerのテスト完了後に再更新
  setTimeout(_updateTopAudioButtons, 9000);
}

/* _buildDefaultLayout は廃止。
 * 初回起動時はパネルを生成せず、接続確立時に
 * ensureHostPanels() がホスト名付きで自動生成する。 */
