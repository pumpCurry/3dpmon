/**
 * @fileoverview 外部連携 / ItemKeeper (ik2) 連携モジュール
 *
 * 3dpmon が保持する印刷履歴を、印刷開始・完了/失敗時に ItemKeeper の受け口へ
 * Bearer 認証つき HTTP POST で送信する（製造実績の取り込み）。
 * 汎用通知 Webhook（dashboard_notification_manager.js）とは別チャネル。
 *
 * 仕様: docs/develop/itemkeeper-integration-specification.md（Phase1 / 第一弾 MVP）
 *  - 認証: Authorization: Bearer {clientId}.{secret}
 *  - ペイロード: 全件スナップショット（機器ごとの配列）, schema "3dpmon.ik.history.v1"
 *  - 冪等: 受信側がレコード単位(deviceKey + jobId)で重複排除
 *  - encoding は Phase1 では "none" 固定（aes-256-gcm は受信側 Phase4+ 予約）
 *  - 第一弾 MVP: 簡易インメモリ再送。IndexedDB 恒久アウトボックスは第二段で追加。
 *
 * また、本モジュールは接続設定モーダルの「🔌 外部連携」サブモーダル全体
 * （汎用Webhook節 ＋ ItemKeeper節 ＋ 対象機器テーブル）を構築する。
 * 編集はトランザクション方式（開いた時点の保存値から再構築、保存して戻る/破棄キャンセル）。
 *
 * @author pumpCurry
 * @license BSD-3-Clause
 */

"use strict";

/* グローバル（ブラウザ/Electron レンダラ・Node18+ ランタイム）: 認証ノンス・gzip 圧縮・カメラ画像取得で使用 */
/* global crypto, CompressionStream, Response, location */

import { monitorData } from "./dashboard_data.js";
import { saveUnifiedStorage } from "./dashboard_storage.js";
import { getSpoolById, getMaterialDensity, weightFromLength } from "./dashboard_spool.js";
import { attributedUsed, deriveSpoolRemaining } from "./dashboard_filament_ledger.js";
import { notificationManager } from "./dashboard_notification_manager.js";
import { showConfirmDialog } from "./dashboard_ui_confirm.js";

/** ペイロードスキーマ識別子 */
const IK_SCHEMA = "3dpmon.ik.history.v1";
/** ItemKeeper 既定の受け口パス */
const IK_DEFAULT_PATH = "/api/ingest/print-events";
/** 設定の保存キー（monitorData.appSettings 直下） */
const SETTINGS_KEY = "itemkeeper";
/** インメモリ再送の最大試行回数（MVP。恒久アウトボックスは第二段） */
const MAX_RETRY = 3;
/** カメラ画像取得の打ち切りタイムアウト[ms]（送信を不当に遅延させない） */
const CAMERA_CAPTURE_TIMEOUT_MS = 4500;

/** 既定設定 */
const DEFAULTS = Object.freeze({
  enabled: false,
  endpoint: "",
  clientId: "",
  secret: "",
  encoding: "none",      // Phase1 固定
  attachCamera: false,   // 各機の現在カメラ画像(Base64/JPEG)を device.camera に添付（既定OFF=下位互換）
  onStart: true,         // 印刷開始時に送信
  onFinish: true,        // 印刷終了(完了/失敗)時に送信
  onPause: true,         // 一時停止時に送信
  onInterval: false,     // 指定タイミング(intervalMin 分ごと)に送信
  intervalMin: 5,        // 指定タイミング間隔[分]（既定5）
  historyScope: "all"    // "all" | "recent:{n}"
});

/** 属性値エスケープ */
function escAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** テキストエスケープ */
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 外部連携 / ItemKeeper 連携マネージャ。
 * シングルトン `itemKeeperIntegration` として export する。
 */
export class ItemKeeperIntegration {
  constructor() {
    /** @type {{enabled:boolean,endpoint:string,clientId:string,secret:string,encoding:string,onStart:boolean,onFinish:boolean,onPause:boolean,onInterval:boolean,intervalMin:number,historyScope:string}} */
    this.settings = { ...DEFAULTS };
    /** @type {number|null} 指定タイミング送信タイマーID */
    this._intervalTimer = null;
    /** @type {boolean} 外部連携モーダル編集中に未保存変更があるか */
    this._dirty = false;
  }

  // ───────────────────────────── 設定 load/save ─────────────────────────────

  /**
   * 永続化済みの ItemKeeper 設定を読み込む。
   * @returns {void}
   */
  loadSettings() {
    const saved = monitorData.appSettings[SETTINGS_KEY];
    this.settings = { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
    this.settings.encoding = "none"; // Phase1 は none 固定
    this._restartIntervalTimer();
  }

  /**
   * 現在の設定を永続化する（即時フラッシュ）。
   * @returns {void}
   */
  persist() {
    monitorData.appSettings[SETTINGS_KEY] = { ...this.settings };
    saveUnifiedStorage(true);
    this._restartIntervalTimer();
  }

  // ───────────────────────────── ペイロード組立 ─────────────────────────────

  /**
   * 「接続先:ポート」や末尾欠落を完全 URL に正規化する。
   * 例: "itemkeeper.com" → "https://itemkeeper.com/api/ingest/print-events"
   * パスが指定済みならそれを尊重する。
   *
   * @param {string} input - 入力文字列
   * @returns {string} 正規化済み URL（空入力なら ""）
   */
  normalizeEndpoint(input) {
    let v = String(input ?? "").trim();
    if (!v) return "";
    if (!/^https?:\/\//i.test(v)) v = "https://" + v;
    try {
      const u = new URL(v);
      if (!u.pathname || u.pathname === "/") u.pathname = IK_DEFAULT_PATH;
      return u.toString();
    } catch {
      return v;
    }
  }

  /**
   * historyScope に従って履歴ジョブを選別する。
   * @private
   * @param {Array<object>} history - printStore.history
   * @param {string} [scopeOverride] - "all" / "recent:{n}" の上書き
   * @returns {Array<object>} 選別後のジョブ配列
   */
  _selectJobs(history, scopeOverride) {
    const scope = scopeOverride || this.settings.historyScope || "all";
    if (scope === "all") return history;
    const m = /^recent:(\d+)$/.exec(scope);
    if (m) {
      const n = parseInt(m[1], 10);
      return [...history].sort((a, b) => (Number(b?.id) || 0) - (Number(a?.id) || 0)).slice(0, n);
    }
    return history;
  }

  /**
   * 1 件の履歴レコード（filamentInfo[]）から filaments[] を組み立てる。
   * 真値は usedMm（mm）。usedGram は密度からの派生。spoolRemainMm は参考値。
   *
   * @param {object} job - printStore.history のレコード
   * @returns {Array<object>} filaments[]
   */
  buildFilaments(job) {
    const out = [];
    const fi = Array.isArray(job?.filamentInfo) ? job.filamentInfo : [];
    if (fi.length > 0) {
      for (const f of fi) {
        const spool = f?.spoolId ? getSpoolById(f.spoolId) : null;
        const usedMm = (f?.usedMm != null) ? Number(f.usedMm) : Number(attributedUsed(job, f?.spoolId) || 0);
        out.push(this._filamentEntry(f || {}, spool, usedMm, job));
      }
    } else {
      // filamentInfo 欠落の旧ジョブ: 単一スプール扱いでフォールバック
      const spoolId = job?.filamentId || null;
      const spool = spoolId ? getSpoolById(spoolId) : null;
      const usedMm = Number(job?.materialUsedMm || 0);
      if (spoolId || usedMm > 0) {
        out.push(this._filamentEntry(
          { spoolId, material: job?.filamentType, filamentColor: job?.filamentColor },
          spool, usedMm, job
        ));
      }
    }
    return out;
  }

  /**
   * filaments[] の 1 要素を生成する（スプール台帳で補完）。
   * @private
   */
  _filamentEntry(f, spool, usedMm, job) {
    const material = spool?.material || spool?.materialName || f.material || job?.filamentType || "";
    const colorHex = spool?.filamentColor || f.filamentColor || job?.filamentColor || "";
    const diameterMm = Number(spool?.filamentDiameter || 1.75);
    const density = Number(spool?.density || getMaterialDensity(material) || 1.24);
    const usedGram = (usedMm > 0)
      ? Math.round(weightFromLength(usedMm, density, diameterMm) * 100) / 100
      : 0;
    let spoolRemainMm = null;
    if (f.expectedRemain != null) {
      spoolRemainMm = Number(f.expectedRemain);
    } else if (f.spoolId) {
      try { spoolRemainMm = deriveSpoolRemaining(f.spoolId)?.remainingMm ?? null; } catch { /* noop */ }
    }
    return {
      spoolId: f.spoolId || spool?.id || "",
      serialNo: (f.serialNo != null) ? f.serialNo : (spool?.serialNo ?? null),
      material,
      colorName: f.colorName || spool?.colorName || "",
      colorHex,
      brand: spool?.brand || spool?.manufacturerName || "",
      diameterMm,
      density,
      usedMm: Number(usedMm) || 0,
      usedGram,
      spoolRemainMm
    };
  }

  /**
   * 履歴レコードを §4.2 のジョブ形式へ変換する。
   * @param {object} job - printStore.history のレコード
   * @returns {object|null}
   */
  buildJob(job) {
    if (!job || job.id == null) return null;
    const startMs = job.startTime ? Date.parse(job.startTime)
      : (job.startTimeSec ? Number(job.startTimeSec) * 1000 : NaN);
    const finishMs = job.finishTime ? Date.parse(job.finishTime) : NaN;
    const durationSec = (Number.isFinite(finishMs) && Number.isFinite(startMs) && finishMs > startMs)
      ? Math.round((finishMs - startMs) / 1000) : null;
    const state = job.finishTime ? "finished" : "printing";
    const pf = job.printfinish;
    const result = (state === "finished")
      ? (pf === 1 ? "success" : (pf === 0 ? "failed" : null))
      : null;
    const filename = job.filename
      || (job.rawFilename ? String(job.rawFilename).split(/[\\/]/).pop() : "");
    return {
      jobId: Number(job.id),
      filename,
      rawFilename: job.rawFilename || job.filename || "",
      filemd5: job.filemd5 || "",
      startTime: job.startTime || (Number.isFinite(startMs) ? new Date(startMs).toISOString() : null),
      finishTime: job.finishTime || null,
      durationSec,
      state,
      result,
      printfinish: (pf === 1 || pf === 0) ? pf : null,
      materialUsedMm: Number(job.materialUsedMm || 0),
      // ★ J: 観測フラグ＋区間時間（取れなかった軸は null）＋実機ネイティブID。
      //   observed: "live"(実測) / "partial"(途中参加) / "history"(履歴のみ=取れなかった)
      observed: job.observed || "history",
      preparationSec:     job.preparationTime     != null ? Number(job.preparationTime)     : null,
      firstLayerCheckSec: job.firstLayerCheckTime  != null ? Number(job.firstLayerCheckTime)  : null,
      pausedSec:          job.pauseTime            != null ? Number(job.pauseTime)            : null,
      postProcessingSec:  job.postProcessingTime   != null ? Number(job.postProcessingTime)   : null,
      ...(job.moonrakerJobId != null && { moonrakerJobId: String(job.moonrakerJobId) }),
      filaments: this.buildFilaments(job)
    };
  }

  /**
   * 全機器スナップショット（§4.1 エンベロープ）を組み立てる。
   *
   * @param {string} triggerEvent - "print.started" | "print.finished" | "ingest.test" 等
   * @param {string} [triggerHost] - トリガ元ホスト名（trigger.deviceKey/jobId に使用）
   * @param {string} [scopeOverride] - historyScope の上書き（413 縮小再送用）
   * @returns {{schema:string,sentAt:string,trigger:object,devices:Array<object>}}
   */
  buildSnapshot(triggerEvent, triggerHost, scopeOverride) {
    const targets = (monitorData.appSettings.connectionTargets || [])
      .filter(t => t && t.ikEnabled !== false); // 既定 ON、明示 false のみ除外
    const devices = [];
    let triggerDeviceKey = "";
    let triggerJobId = null;

    for (const t of targets) {
      const host = t.hostname || "";
      const machine = host ? monitorData.machines[host] : null;
      const history = machine?.printStore?.history || [];
      const jobs = this._selectJobs(history, scopeOverride).map(j => this.buildJob(j)).filter(Boolean);
      const deviceKey = t.ikDeviceAlias || t.label || host || t.dest;
      if (!deviceKey) continue;
      devices.push({
        deviceKey,
        device: {
          alias: t.ikDeviceAlias || t.label || host || "",
          hostname: host,
          ip: String(t.dest || "").split(":")[0] || "",
          mac: t.macAddress || "",
          model: machine?.storedData?.model?.rawValue || ""
        },
        jobs
      });
      if (host && host === triggerHost) {
        triggerDeviceKey = deviceKey;
        const cur = machine?.printStore?.current;
        triggerJobId = (cur?.id != null) ? Number(cur.id)
          : (jobs.length ? Math.max(...jobs.map(j => j.jobId)) : null);
      }
    }

    const trigger = { event: triggerEvent || "" };
    if (triggerDeviceKey) trigger.deviceKey = triggerDeviceKey;
    if (triggerJobId != null) trigger.jobId = triggerJobId;

    return { schema: IK_SCHEMA, sentAt: new Date().toISOString(), trigger, devices };
  }

  // ───────────────────────────── カメラ画像添付 ─────────────────────────────

  /**
   * Promise にタイムアウトを付与する（カメラ取得が送信を不当に遅延させないため）。
   * @private
   * @template T
   * @param {Promise<T>} promise
   * @param {number} ms
   * @returns {Promise<T>}
   */
  _withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      Promise.resolve(promise).then(
        v => { clearTimeout(t); resolve(v); },
        e => { clearTimeout(t); reject(e); }
      );
    });
  }

  /**
   * Blob を「data: プレフィックスを除いた生 Base64 文字列」へ変換する。
   * @private
   * @param {Blob} blob
   * @returns {Promise<string>} 失敗時は ""
   */
  _blobToBase64(blob) {
    return new Promise((resolve) => {
      try {
        const fr = new FileReader();
        fr.onload = () => {
          const s = String(fr.result || "");
          const i = s.indexOf(",");
          resolve(i >= 0 ? s.slice(i + 1) : "");
        };
        fr.onerror = () => resolve("");
        fr.readAsDataURL(blob);
      } catch { resolve(""); }
    });
  }

  /**
   * 1 ホストの「現在のカメラ画像」を取得し camera オブジェクトを返す。
   *
   * 取得経路（堅牢性の高い順にフォールバック）:
   *  1. Electron 親（本番）: `window.electronAPI.getCameraSnapshot(host)`
   *     親レンダラーは file:// オリジンのため CORS でプリンタ画像を直接読めない。
   *     メインプロセスが `_cameraEndpoints` allowlist 経由で1枚取得し Base64 で返す。
   *  2. リレー子 / 同一オリジン http: `/relay-camera/{host}/snapshot.jpg` を fetch。
   *     子は親(5313)と同一オリジンなので CORS なしで blob を読める。
   *
   * いずれも取得不能なら null（→ 呼び出し側は camera フィールドを省略＝下位互換）。
   *
   * @private
   * @param {string} host - プリンタホスト名
   * @returns {Promise<{mime:string,dataBase64:string,bytes:number,capturedAt:string}|null>}
   */
  async _captureCamera(host) {
    if (!host) return null;

    // 1) Electron 親: IPC 経由でメインプロセスが取得（CORS 回避・本番経路）
    try {
      if (typeof window !== "undefined" && window.electronAPI?.getCameraSnapshot) {
        const r = await this._withTimeout(window.electronAPI.getCameraSnapshot(host), CAMERA_CAPTURE_TIMEOUT_MS);
        if (r && r.dataBase64) {
          return {
            mime: r.mime || "image/jpeg",
            dataBase64: r.dataBase64,
            bytes: Number(r.bytes) || 0,
            capturedAt: new Date().toISOString()
          };
        }
        return null; // Electron 環境で取得不可なら他経路は無効（プリンタへ直接到達できない）
      }
    } catch { /* フォールバックへ */ }

    // 2) リレー子 / 同一オリジン http: 親プロキシを同一オリジン fetch
    try {
      if (typeof fetch === "function" && typeof location !== "undefined" && /^https?:$/.test(location.protocol)) {
        const url = `/relay-camera/${encodeURIComponent(host)}/snapshot.jpg?t=${Date.now()}`;
        const res = await this._withTimeout(fetch(url, { cache: "no-store" }), CAMERA_CAPTURE_TIMEOUT_MS);
        if (res && res.ok) {
          const blob = await res.blob();
          const b64 = await this._blobToBase64(blob);
          if (b64) {
            return {
              mime: blob.type || "image/jpeg",
              dataBase64: b64,
              bytes: Number(blob.size) || 0,
              capturedAt: new Date().toISOString()
            };
          }
        }
      }
    } catch { /* noop */ }

    return null;
  }

  /**
   * スナップショットの各 device に「現在のカメラ画像(Base64)」を添付する。
   * `settings.attachCamera` が ON のとき sendSnapshot から呼ばれる。
   *
   * - 機器別 `ikCamera === false` の機器は添付しない。
   * - 取得できない機器（カメラ無し/オフライン等）は省略する（JSON は valid のまま）。
   * - device.camera = { mime, dataBase64, bytes, capturedAt }。
   * - 全機器を並列取得し、送信の総待ち時間を抑える。
   *
   * @private
   * @param {{devices:Array<object>}} snap - buildSnapshot の結果（破壊的に変更）
   * @returns {Promise<void>}
   */
  async _attachCameras(snap) {
    const devices = snap?.devices || [];
    if (!devices.length) return;
    const targets = monitorData.appSettings.connectionTargets || [];
    await Promise.all(devices.map(async (d) => {
      const host = d?.device?.hostname;
      if (!host) return;
      const t = targets.find(x => x && x.hostname === host);
      if (t && t.ikCamera === false) return; // この機器はカメラ添付OFF
      try {
        const cam = await this._captureCamera(host);
        if (cam) d.camera = cam;
      } catch { /* 取得失敗は省略（下位互換） */ }
    }));
  }

  // ───────────────────────────── HTTP 送信 ─────────────────────────────

  /** @private ランダム UUID（フォールバックあり） */
  _uuid() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch { /* noop */ }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  /**
   * §5 のリクエストヘッダを構築する（Bearer・X-IK-*）。
   * @private
   * @param {string} trigger - X-IK-Trigger 値
   * @returns {Record<string,string>}
   */
  buildHeaders(trigger) {
    const s = this.settings;
    return {
      "Authorization": `Bearer ${s.clientId}.${s.secret}`,
      "Content-Type": "application/json",
      "X-IK-Trigger": trigger,
      "X-IK-Timestamp": String(Date.now()),
      "X-IK-Nonce": this._uuid(),
      "X-IK-Request-Id": this._uuid(),
      "X-IK-Encoding": "none"
    };
  }

  /**
   * gzip 圧縮を試みる（CompressionStream 非対応環境は無圧縮にフォールバック）。
   * @private
   * @param {string} jsonStr
   * @returns {Promise<{body:(ArrayBuffer|string), gzipped:boolean}>}
   */
  async _maybeGzip(jsonStr) {
    try {
      if (typeof CompressionStream === "function" && typeof Response === "function") {
        const cs = new CompressionStream("gzip");
        const stream = new Response(jsonStr).body.pipeThrough(cs);
        const buf = await new Response(stream).arrayBuffer();
        return { body: buf, gzipped: true };
      }
    } catch { /* fallback */ }
    return { body: jsonStr, gzipped: false };
  }

  /**
   * スナップショットを送信する（簡易再送つき）。fire-and-forget 用途。
   *
   * @param {{trigger:string, host?:string}} opts
   * @returns {Promise<{ok:boolean,status?:number,error?:string,skipped?:boolean}>}
   */
  async sendSnapshot({ trigger, host } = {}) {
    const s = this.settings;
    if (!s.enabled) return { ok: false, skipped: true };
    const endpoint = this.normalizeEndpoint(s.endpoint);
    if (!endpoint || !s.clientId || !s.secret) return { ok: false, skipped: true };
    const event = trigger || "";
    const snap = this.buildSnapshot(event, host);
    if (!snap.devices.length) return { ok: false, skipped: true };
    // カメラ画像(Base64)を各機に添付（ON時のみ）。取得失敗機は省略＝下位互換。
    // 413(サイズ超過)時は _post 内の縮小再送が buildSnapshot で組み直すため画像は自然に外れる。
    if (s.attachCamera) {
      try { await this._attachCameras(snap); } catch { /* 添付失敗は無視して履歴のみ送る */ }
    }
    return this._post(endpoint, event, snap, { host, retriesLeft: MAX_RETRY });
  }

  /**
   * 実際の POST とレスポンス分岐・再送（§7）。
   * @private
   */
  async _post(endpoint, trigger, payloadObj, opts = {}) {
    const retriesLeft = opts.retriesLeft ?? 0;
    const json = JSON.stringify(payloadObj);
    const headers = this.buildHeaders(trigger);
    let body = json;
    const g = await this._maybeGzip(json);
    if (g.gzipped) { body = g.body; headers["Content-Encoding"] = "gzip"; }

    let res;
    try {
      res = await fetch(endpoint, { method: "POST", headers, body });
    } catch (e) {
      if (retriesLeft > 0) return this._retry(endpoint, trigger, payloadObj, opts, `network: ${e.message}`);
      console.warn("[itemkeeper] network error:", e.message);
      this._lastError = `ネットワークエラー: ${e.message}`;
      return { ok: false, error: "network" };
    }

    if (res.ok) { this._lastError = null; return { ok: true, status: res.status }; }
    const status = res.status;
    if (status === 401 || status === 403) {
      this._lastError = `ItemKeeper 認証エラー (${status})`;
      console.warn("[itemkeeper]", this._lastError);
      return { ok: false, status };
    }
    if (status === 400) {
      this._lastError = "スキーマ不正 (400)";
      console.warn("[itemkeeper]", this._lastError);
      return { ok: false, status };
    }
    if (status === 413 && !opts._shrunk) {
      // サイズ超過 → historyScope を縮小して 1 回だけ再送
      const shrunk = this.buildSnapshot(trigger, opts.host, "recent:50");
      return this._post(endpoint, trigger, shrunk, { ...opts, _shrunk: true, retriesLeft: 0 });
    }
    if ((status === 429 || status >= 500) && retriesLeft > 0) {
      return this._retry(endpoint, trigger, payloadObj, opts, `HTTP ${status}`);
    }
    this._lastError = `HTTP ${status}`;
    console.warn("[itemkeeper]", this._lastError);
    return { ok: false, status };
  }

  /** @private 簡易バックオフ再送（インメモリ） */
  _retry(endpoint, trigger, payloadObj, opts, reason) {
    const retriesLeft = (opts.retriesLeft ?? 0) - 1;
    const attempt = MAX_RETRY - retriesLeft;
    console.warn(`[itemkeeper] retry #${attempt} (${reason})`);
    const delay = 1500 * attempt; // 1.5s, 3s, 4.5s …
    return new Promise(resolve => setTimeout(() => {
      resolve(this._post(endpoint, trigger, payloadObj, { ...opts, retriesLeft }));
    }, delay));
  }

  /**
   * 連携テスト送信（X-IK-Trigger: ingest.test、本文 devices:[]）。
   * 下書き（モーダルの現在値）でテストできるよう設定を引数で受け取る。
   *
   * @param {{endpoint:string,clientId:string,secret:string}} cfg
   * @param {(ok:boolean, msg:string)=>void} [onResult]
   * @returns {Promise<void>}
   */
  async testConnection(cfg, onResult) {
    const endpoint = this.normalizeEndpoint(cfg?.endpoint);
    if (!endpoint) { onResult?.(false, "接続先URLが未設定です"); return; }
    if (!cfg.clientId || !cfg.secret) { onResult?.(false, "クライアントID/暗号キーが未設定です"); return; }
    const payload = {
      schema: IK_SCHEMA, sentAt: new Date().toISOString(),
      trigger: { event: "ingest.test" }, devices: []
    };
    const headers = {
      "Authorization": `Bearer ${cfg.clientId}.${cfg.secret}`,
      "Content-Type": "application/json",
      "X-IK-Trigger": "ingest.test",
      "X-IK-Timestamp": String(Date.now()),
      "X-IK-Nonce": this._uuid(),
      "X-IK-Request-Id": this._uuid(),
      "X-IK-Encoding": "none"
    };
    try {
      const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
      if (res.ok) onResult?.(true, `OK (${res.status})`);
      else if (res.status === 401 || res.status === 403) onResult?.(false, `認証エラー (${res.status})`);
      else onResult?.(false, `HTTP ${res.status}`);
    } catch (e) {
      onResult?.(false, e.message);
    }
  }

  /**
   * 汎用Webhook の下書き URL 群へテスト送信する（保存前の値でテスト可能）。
   * @param {string[]} urls
   * @param {(url:string, ok:boolean, msg:(string|null))=>void} [onResult]
   * @returns {Promise<void>}
   */
  async testWebhookUrls(urls, onResult) {
    const list = (urls || []).filter(u => u);
    if (!list.length) { onResult?.("", false, "URL が設定されていません"); return; }
    const now = new Date();
    const payload = {
      text: "3dpmon Webhook テスト送信", event: "webhookTest", hostname: "3dpmon",
      timestamp: now.toISOString(), timestamp_epoch: now.getTime(),
      timestamp_local: now.toLocaleString(), timezone_offset_min: now.getTimezoneOffset(),
      data: { message: "この通知はテスト送信です" }
    };
    const json = JSON.stringify(payload);
    for (const url of list) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
        onResult?.(url, res.ok, res.ok ? null : `HTTP ${res.status}`);
      } catch (e) {
        onResult?.(url, false, e.message);
      }
    }
  }

  // ───────────────────────────── 印刷イベントフック ─────────────────────────────

  /**
   * 印刷イベント発火時に呼ばれ、条件を満たせばスナップショットを送る。
   * dashboard_msg_handler.js のトリガ箇所から呼び出す。
   *
   * @param {string} host - イベント発生ホスト名
   * @param {"started"|"finished"|"paused"} kind - イベント種別
   * @returns {void}
   */
  onPrintEvent(host, kind) {
    const s = this.settings;
    if (!s.enabled) return;
    if (kind === "started" && !s.onStart) return;
    if (kind === "finished" && !s.onFinish) return;
    if (kind === "paused" && !s.onPause) return;
    const t = (monitorData.appSettings.connectionTargets || [])
      .find(x => x && (x.hostname === host || x.dest === host));
    if (t && t.ikEnabled === false) return; // この機器は連携対象外
    const trigger = kind === "started" ? "print.started"
      : kind === "paused" ? "print.paused"
        : "print.finished";
    this.sendSnapshot({ trigger, host })
      .catch(e => console.warn("[itemkeeper] sendSnapshot failed:", e?.message || e));
  }

  /**
   * 指定タイミング（intervalMin 分ごと）の定期送信タイマーを再構築する。
   * enabled かつ onInterval のときのみ作動。設定の読込・変更のたびに呼ぶ。
   * @private
   * @returns {void}
   */
  _restartIntervalTimer() {
    if (this._intervalTimer) { clearInterval(this._intervalTimer); this._intervalTimer = null; }
    const s = this.settings;
    if (!s.enabled || !s.onInterval) return;
    const min = (Number(s.intervalMin) > 0) ? Number(s.intervalMin) : 5;
    this._intervalTimer = setInterval(() => {
      this.sendSnapshot({ trigger: "snapshot.interval" })
        .catch(e => console.warn("[itemkeeper] interval send failed:", e?.message || e));
    }, min * 60 * 1000);
  }

  // ───────────────────────────── モーダル UI ─────────────────────────────

  /**
   * 外部連携モーダルの本体を構築する（汎用Webhook節＋ItemKeeper節＋対象機器テーブル）。
   * トランザクション編集: 開いた時点の保存値からフォームを再構築し、
   * 「保存して戻る」で確定、それ以外（キャンセル/×/枠外/Esc）は破棄。
   *
   * @param {HTMLElement} container - #external-modal-body 等の差し込み先
   * @returns {void}
   */
  initModalUI(container) {
    if (!container) return;
    const s = this.settings;
    const urls = (notificationManager.getWebhookUrls?.() || []).join(",");
    const whIndep = !!notificationManager.getWebhookIndependent?.();
    const snapEnabled = !!notificationManager.statusSnapshotEnabled;
    const snapInterval = Number(notificationManager.statusSnapshotIntervalSec || 30);
    const targets = monitorData.appSettings.connectionTargets || [];

    const deviceRows = targets.map(t => {
      const dest = escAttr(t.dest || "");
      const name = escHtml(t.label || t.hostname || t.dest || "(未解決)");
      const alias = escAttr(t.ikDeviceAlias || "");
      const ikEnabled = t.ikEnabled !== false;
      const ikCamera = t.ikCamera !== false;
      return `<tr>
        <td style="padding:2px 6px;white-space:nowrap;">${name}</td>
        <td style="padding:2px 6px;"><input type="text" data-ik-alias="${dest}" value="${alias}"
            placeholder="${escAttr(t.hostname || "")}" style="width:10em;font-size:12px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;"></td>
        <td style="padding:2px 6px;text-align:center;"><input type="checkbox" data-ik-enabled="${dest}" ${ikEnabled ? "checked" : ""}></td>
        <td style="padding:2px 6px;text-align:center;"><input type="checkbox" data-ik-camera="${dest}" ${ikCamera ? "checked" : ""}></td>
      </tr>`;
    }).join("");

    container.innerHTML = `
      <div style="padding:14px 16px;font-size:13px;display:flex;flex-direction:column;gap:16px;">

        <!-- ===== §A 汎用 Webhook Push ===== -->
        <section style="border:1px solid #d8e0ea;border-radius:6px;padding:10px 12px;background:#fafcff;">
          <div style="font-weight:bold;margin-bottom:6px;">📡 汎用 Webhook Push</div>
          <div style="font-size:11px;color:#667;margin-bottom:8px;">
            印刷・温度・フィラメント等のイベントを構造化JSONで外部URLへ送信します（Slack/Discord/IFTTT/n8n 等）。
          </div>
          <label style="display:block;margin-bottom:6px;">Webhook URLs（カンマ区切り）
            <textarea data-role="wh-urls" rows="2" style="width:100%;font-size:12px;box-sizing:border-box;">${escHtml(urls)}</textarea>
          </label>
          <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <input type="checkbox" data-role="wh-independent" ${whIndep ? "checked" : ""}>
            通知設定（画面/TTS）が OFF でも Webhook を送信する（独立 push）
          </label>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
            <label style="display:flex;align-items:center;gap:4px;">
              <input type="checkbox" data-role="wh-snap-enabled" ${snapEnabled ? "checked" : ""}>
              ステータス定期送信
            </label>
            <label>間隔(秒) <input type="number" data-role="wh-snap-interval" min="5" max="300" step="5"
                value="${snapInterval}" style="width:5em;font-size:12px;padding:2px 4px;"></label>
          </div>
          <div>
            <button type="button" data-role="wh-test" style="font-size:12px;padding:3px 12px;">Webhook テスト送信</button>
            <span data-role="wh-test-result" style="margin-left:8px;font-size:12px;"></span>
          </div>
        </section>

        <!-- ===== §B ItemKeeper 連携（OFF時は折りたたみ）===== -->
        <section style="border:1px solid #d8e0ea;border-radius:6px;padding:10px 12px;background:#fffdfa;">
          <div data-role="ik-header" style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;">
            <span data-role="ik-chevron" style="font-size:12px;color:#667;width:1em;text-align:center;">${s.enabled ? "▾" : "▸"}</span>
            <span style="font-weight:bold;">📦 ItemKeeper 連携</span>
            <span data-role="ik-hint" style="font-size:11px;color:#999;">${s.enabled ? "" : "（未使用 / クリックで展開）"}</span>
          </div>
          <div data-role="ik-body" style="${s.enabled ? "" : "display:none;"}margin-top:8px;">
            <div style="font-size:11px;color:#667;margin-bottom:8px;">
              印刷開始・完了/失敗時に印刷履歴の全件スナップショットを ItemKeeper(ik2) へ Bearer 認証で送信します（利用には ItemKeeper アカウントが必要）。
            </div>
            <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-weight:bold;">
              <input type="checkbox" data-role="ik-enabled" ${s.enabled ? "checked" : ""}>
              この連携を有効化する
            </label>
            <label style="display:block;margin-bottom:6px;">接続先 URL
              <input type="text" data-role="ik-endpoint" value="${escAttr(s.endpoint)}"
                placeholder="itemkeeper.com（自動で https://…/api/ingest/print-events へ正規化）"
                style="width:100%;font-size:12px;box-sizing:border-box;padding:3px 6px;border:1px solid #ccc;border-radius:3px;">
            </label>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
              <label style="flex:1;min-width:12em;">クライアント ID
                <input type="text" data-role="ik-clientid" value="${escAttr(s.clientId)}" autocomplete="off"
                  style="width:100%;font-size:12px;box-sizing:border-box;padding:3px 6px;border:1px solid #ccc;border-radius:3px;">
              </label>
              <label style="flex:1;min-width:12em;">暗号キー（鍵）
                <input type="password" data-role="ik-secret" value="${escAttr(s.secret)}" autocomplete="off"
                  style="width:100%;font-size:12px;box-sizing:border-box;padding:3px 6px;border:1px solid #ccc;border-radius:3px;">
              </label>
            </div>
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
              <label>暗号化
                <select data-role="ik-encoding" style="font-size:12px;padding:2px 4px;">
                  <option value="none" selected>none（平文・Bearer認証）</option>
                  <option value="aes-256-gcm" disabled>aes-256-gcm（受信側 Phase4+・未対応）</option>
                </select>
              </label>
              <label>履歴範囲
                <select data-role="ik-scope" style="font-size:12px;padding:2px 4px;">
                  <option value="all" ${s.historyScope === "all" ? "selected" : ""}>全件</option>
                  <option value="recent:200" ${s.historyScope === "recent:200" ? "selected" : ""}>直近200件</option>
                  <option value="recent:500" ${s.historyScope === "recent:500" ? "selected" : ""}>直近500件</option>
                </select>
              </label>
            </div>

            <div style="margin:8px 0 4px;font-weight:bold;font-size:12px;">連携タイミング</div>
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
              <label style="display:flex;align-items:center;gap:4px;">
                <input type="checkbox" data-role="ik-onstart" ${s.onStart ? "checked" : ""}>印刷開始時
              </label>
              <label style="display:flex;align-items:center;gap:4px;">
                <input type="checkbox" data-role="ik-onfinish" ${s.onFinish ? "checked" : ""}>印刷終了時
              </label>
              <label style="display:flex;align-items:center;gap:4px;">
                <input type="checkbox" data-role="ik-onpause" ${s.onPause ? "checked" : ""}>一時停止時
              </label>
              <label style="display:flex;align-items:center;gap:4px;">
                <input type="checkbox" data-role="ik-oninterval" ${s.onInterval ? "checked" : ""}>指定タイミング
              </label>
              <label style="display:flex;align-items:center;gap:4px;">(分)
                <input type="number" data-role="ik-intervalmin" min="1" max="1440" step="1" value="${Number(s.intervalMin) || 5}"
                  style="width:4.5em;font-size:12px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;">
              </label>
            </div>

            <div style="margin:8px 0 4px;font-weight:bold;font-size:12px;">カメラ画像の添付</div>
            <label style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
              <input type="checkbox" data-role="ik-attach-camera" ${s.attachCamera ? "checked" : ""}>
              現在のカメラ画像を各機ごとに添付する（Base64・JPEG）
            </label>
            <div style="font-size:11px;color:#999;margin:0 0 6px 22px;">
              ※送信のたびに各機のスナップショットを取得し <code>device.camera</code> に付与します。カメラ無し/オフラインの機器は省略されます（下位互換）。機器ごとのON-OFFは下表の「カメラ」列で調整できます。
            </div>

            <div style="margin:8px 0 4px;font-weight:bold;font-size:12px;">対象機器（機器エイリアス / 連携ON-OFF / カメラ添付）</div>
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
              <thead><tr style="color:#667;text-align:left;">
                <th style="padding:2px 6px;">機器</th><th style="padding:2px 6px;">エイリアス（ItemKeeper側の安定名）</th><th style="padding:2px 6px;">連携</th><th style="padding:2px 6px;">カメラ</th>
              </tr></thead>
              <tbody data-role="ik-devices">${deviceRows || `<tr><td colspan="4" style="padding:6px;color:#999;">接続先がありません</td></tr>`}</tbody>
            </table>

            <div style="margin-top:8px;">
              <button type="button" data-role="ik-test" style="font-size:12px;padding:3px 12px;">連携テスト送信</button>
              <span data-role="ik-test-result" style="margin-left:8px;font-size:12px;"></span>
            </div>
          </div>
        </section>

        <!-- ===== フッター（保存/キャンセル）===== -->
        <div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #e0e0e0;padding-top:10px;">
          <button type="button" data-role="ext-cancel" style="font-size:13px;padding:5px 14px;">変更を破棄してキャンセル</button>
          <button type="button" data-role="ext-save" class="primary" style="font-size:13px;padding:5px 16px;font-weight:bold;">保存して戻る</button>
        </div>
      </div>`;

    this._bindModalHandlers(container);
  }

  /** @private モーダルのイベントを束ねる */
  _bindModalHandlers(container) {
    const q = sel => container.querySelector(sel);

    // 編集中の未保存検知（枠外クリック等での誤破棄を確認ダイアログで防ぐ）
    this._dirty = false;
    const markDirty = () => { this._dirty = true; };
    container.addEventListener("input", markDirty);
    container.addEventListener("change", markDirty);

    // ItemKeeper 節の折りたたみ（未使用の人には項目を見せない。OFFなら初期折りたたみ）
    const ikHeader = q('[data-role="ik-header"]');
    const ikBody = q('[data-role="ik-body"]');
    const ikChevron = q('[data-role="ik-chevron"]');
    const ikHint = q('[data-role="ik-hint"]');
    if (ikHeader && ikBody) {
      ikHeader.addEventListener("click", () => {
        const willShow = ikBody.style.display === "none";
        ikBody.style.display = willShow ? "" : "none";
        if (ikChevron) ikChevron.textContent = willShow ? "▾" : "▸";
        if (ikHint) ikHint.textContent = willShow ? "" : "（未使用 / クリックで展開）";
      });
    }

    // 汎用Webhook テスト送信（下書きの URL でテスト）
    const whTest = q('[data-role="wh-test"]');
    if (whTest) {
      whTest.addEventListener("click", () => {
        const result = q('[data-role="wh-test-result"]');
        const urls = (q('[data-role="wh-urls"]')?.value || "").split(",").map(u => u.trim()).filter(Boolean);
        if (result) { result.textContent = "送信中…"; result.style.color = "#667"; }
        let okCount = 0, total = urls.length;
        this.testWebhookUrls(urls, (url, ok, msg) => {
          if (ok) okCount++;
          if (result) {
            result.textContent = ok ? `OK (${okCount}/${total})` : `失敗: ${msg || ""}`;
            result.style.color = ok ? "#2a7" : "#c33";
          }
        });
      });
    }

    // ItemKeeper テスト送信（下書きの接続情報でテスト）
    const ikTest = q('[data-role="ik-test"]');
    if (ikTest) {
      ikTest.addEventListener("click", () => {
        const result = q('[data-role="ik-test-result"]');
        const cfg = {
          endpoint: q('[data-role="ik-endpoint"]')?.value || "",
          clientId: q('[data-role="ik-clientid"]')?.value || "",
          secret: q('[data-role="ik-secret"]')?.value || ""
        };
        if (result) { result.textContent = "送信中…"; result.style.color = "#667"; }
        this.testConnection(cfg, (ok, msg) => {
          if (result) { result.textContent = (ok ? "✓ " : "✗ ") + msg; result.style.color = ok ? "#2a7" : "#c33"; }
        });
      });
    }

    // 保存して戻る
    const saveBtn = q('[data-role="ext-save"]');
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        this._commitModal(container);
        this._dirty = false;
        this._closeModal();
      });
    }
    // 変更を破棄してキャンセル（明示操作なので確認なしで即破棄）
    const cancelBtn = q('[data-role="ext-cancel"]');
    if (cancelBtn) cancelBtn.addEventListener("click", () => { this._dirty = false; this._closeModal(); });
  }

  /** @private モーダルの DOM 値を確定し永続化する（保存して戻る） */
  _commitModal(container) {
    const q = sel => container.querySelector(sel);

    // ── 汎用Webhook（notificationManager に反映）──
    const urls = (q('[data-role="wh-urls"]')?.value || "").split(",").map(u => u.trim()).filter(Boolean);
    notificationManager.setWebhookUrls(urls);
    notificationManager.setWebhookIndependent(!!q('[data-role="wh-independent"]')?.checked);
    const snapEnabled = !!q('[data-role="wh-snap-enabled"]')?.checked;
    const snapInterval = parseInt(q('[data-role="wh-snap-interval"]')?.value, 10);
    notificationManager.setStatusSnapshot(snapEnabled, Number.isFinite(snapInterval) ? snapInterval : undefined);

    // ── ItemKeeper 設定 ──
    this.settings.enabled = !!q('[data-role="ik-enabled"]')?.checked;
    this.settings.endpoint = (q('[data-role="ik-endpoint"]')?.value || "").trim();
    this.settings.clientId = (q('[data-role="ik-clientid"]')?.value || "").trim();
    this.settings.secret = q('[data-role="ik-secret"]')?.value || "";
    this.settings.encoding = "none";
    this.settings.attachCamera = !!q('[data-role="ik-attach-camera"]')?.checked;
    this.settings.historyScope = q('[data-role="ik-scope"]')?.value || "all";
    this.settings.onStart = !!q('[data-role="ik-onstart"]')?.checked;
    this.settings.onFinish = !!q('[data-role="ik-onfinish"]')?.checked;
    this.settings.onPause = !!q('[data-role="ik-onpause"]')?.checked;
    this.settings.onInterval = !!q('[data-role="ik-oninterval"]')?.checked;
    const _im = parseInt(q('[data-role="ik-intervalmin"]')?.value, 10);
    this.settings.intervalMin = (Number.isFinite(_im) && _im > 0) ? _im : 5;

    // ── 対象機器（connectionTargets に反映）──
    const targets = monitorData.appSettings.connectionTargets || [];
    container.querySelectorAll('[data-ik-alias]').forEach(inp => {
      const dest = inp.getAttribute("data-ik-alias");
      const t = targets.find(x => x && x.dest === dest);
      if (t) t.ikDeviceAlias = inp.value.trim();
    });
    container.querySelectorAll('[data-ik-enabled]').forEach(chk => {
      const dest = chk.getAttribute("data-ik-enabled");
      const t = targets.find(x => x && x.dest === dest);
      if (t) t.ikEnabled = chk.checked;
    });
    container.querySelectorAll('[data-ik-camera]').forEach(chk => {
      const dest = chk.getAttribute("data-ik-camera");
      const t = targets.find(x => x && x.dest === dest);
      if (t) t.ikCamera = chk.checked;
    });

    // 永続化（即時フラッシュ＝即反映）
    this.persist();
  }

  /**
   * 外部連携モーダルを閉じる要求（枠外クリック/Esc/×から呼ぶ）。
   * 未保存の変更があれば共通の確認ダイアログで破棄可否を尋ね、許可時のみ閉じる。
   * @returns {Promise<void>}
   */
  async requestCloseExternal() {
    if (!this._dirty) { this._closeModal(); return; }
    const discard = await showConfirmDialog({
      level: "warn",
      title: "変更を破棄しますか？",
      message: "外部連携の編集内容は保存されていません。破棄して閉じますか？（「保存して戻る」で保存できます）",
      confirmText: "破棄して閉じる",
      cancelText: "編集に戻る"
    });
    if (discard) { this._dirty = false; this._closeModal(); }
  }

  /** @private 外部連携モーダルを閉じる */
  _closeModal() {
    const overlay = document.getElementById("external-modal-overlay");
    if (overlay) overlay.classList.remove("open");
  }
}

/** シングルトンインスタンス */
export const itemKeeperIntegration = new ItemKeeperIntegration();
