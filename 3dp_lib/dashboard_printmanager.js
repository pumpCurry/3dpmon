/**
 * @fileoverview
 * 印刷履歴および現在の印刷ジョブの管理モジュール (v1.328 改訂版)
 *
 * - 機能構成:
 *   - parseRawHistoryList(): 生履歴から内部モデルを構築
 *   - load/save: localStorage との永続化
 *   - render: HTMLへの反映（containerID指定により柔軟な描画が可能）
 *   - refreshHistory: 外部データ(fetchStoredData)を元に再描画
 *
 * - Template処理と分離の準備:
 *   - renderTemplates オブジェクトにHTML生成処理をまとめ、将来的に外部ファイル化に備える構成とした。
 *
 * @module dashboard_printManager
 */
"use strict";

import {
  loadPrintCurrent,
  savePrintCurrent,
  loadPrintHistory,
  savePrintHistory
} from "./dashboard_storage.js";

import { formatEpochToDateTime } from "./dashboard_utils.js";
import { pushLog } from "./dashboard_log_util.js";
import { showConfirmDialog, showInputDialog } from "./dashboard_ui_confirm.js";
import { monitorData } from "./dashboard_data.js"; // filament残量取得用
import { sendCommand, fetchStoredData, getDeviceIp } from "./dashboard_connection.js";

/** 履歴の最大件数 */
export const MAX_HISTORY = 150;

// 最後に保存した JSON 文字列のキャッシュ（差分チェック用）
let _lastSavedJson = "";

/*
 * サムネイル URL を生成（メーカー仕様: downloads/humbnail/{basename}.png）
 * @param {string} baseUrl    サーバーのベース URL (例: "http://192.168.1.5")
 * @param {number} id         履歴エントリの ID
 * @param {string} filemd5    ファイルの MD5 ハッシュ
 * @param {string} rawFilename   履歴エントリの filename フルパス
 * @returns {string}
 */
function makeThumbUrl(baseUrl, rawFilename) {
  // パスからファイル名部分だけ取り出し (例: ".../foo.gcode" → "foo.gcode")
  const fname = rawFilename.split("/").pop() || "";
  // 拡張子を取り除く (例: "foo.gcode" → "foo")
  const base  = fname.replace(/\.[^/.]+$/, "");
  // メーカー仕様フォルダ名は "humbnail"
  return `${baseUrl}/downloads/humbnail/${base}.png`;
}


/**
 * 生の履歴エントリをモデル化
 * @param {Object} raw           - 元データ
 * @param {string} baseUrl       - サムネイル取得用ベース URL
 * @returns {{id:number,filename:string,startTime:string,finishTime?:string|null,materialUsedMm:number,thumbUrl:string}}
 */
export function parseRawHistoryEntry(raw, baseUrl) {
  const id             = raw.id;
  const filename       = raw.filename?.split("/").pop() || "(不明)";
  const startSec       = raw.starttime || 0;
  const useTimeSec     = raw.usagetime || 0;
  const startTime      = new Date(startSec * 1000).toISOString();
  const finishTime     = useTimeSec > 0
    ? new Date((startSec + useTimeSec) * 1000).toISOString()
    : null;
  // 材料使用量は小数第2位で切り上げ
  const materialUsedMm = Math.ceil((raw.usagematerial || 0) * 100) / 100;

  // raw.filename に基づくサムネイル生成
  const thumbUrl       = makeThumbUrl(baseUrl, raw.filename);


  return { id, filename, startTime, finishTime, materialUsedMm, thumbUrl };
}

/**
 * 生配列からフィルタ・ソート・制限をかけた履歴リストを返す
 * @param {Array<Object>} rawArray - 元データ配列
 * @param {string} baseUrl         - サムネイル取得用ベース URL
 * @returns {Array<ReturnType<typeof parseRawHistoryEntry>>}
 */
export function parseRawHistoryList(rawArray, baseUrl) {
  return rawArray
    .filter(r => typeof r.filename === "string" && r.filename.length > 0)
    .map(r => parseRawHistoryEntry(r, baseUrl))
    .sort((a, b) => b.id - a.id)
    .slice(0, MAX_HISTORY);
}

// ---------------------- ストレージ操作 ----------------------

/**
 * 現在印刷中ジョブをロード
 * @returns {Object|null}
 */
export function loadCurrent() {
  return loadPrintCurrent();
}

/**
 * 現在印刷中ジョブを保存
 * @param {Object|null} job
 */
export function saveCurrent(job) {
  savePrintCurrent(job);
}

/**
 * 履歴一覧をロード
 * @returns {Array<Object>}
 */
export function loadHistory() {
  return loadPrintHistory();
}

/**
 * 印刷履歴データを保存する。
 *
 * - `parseRawHistoryList()` などから生成された履歴配列を受け取り、
 *   前回と同一でなければ localStorage に保存を行う。
 * - 差分がなければ保存をスキップして無駄な write を抑制する。
 * - 保存時には info ログを出力する。
 *
 * @param {Array<Object>} jobs - parseRawHistoryList により構成された履歴モデル配列
 * @returns {void}
 */
export function saveHistory(jobs) {
  const json = JSON.stringify(jobs);
  if (json === _lastSavedJson) {
    // 変更なしならスキップ
    return;
  }
  _lastSavedJson = json;
  savePrintHistory(jobs);
  pushLog("[saveHistory] 印刷履歴を保存しました", "info");
}

/**
 * 保存済みジョブ配列を履歴テーブル用の簡易 raw 形式に変換します。
 *
 * @param {Array<Object>} jobs - loadHistory() で取得した履歴配列
 * @returns {Array<Object>} テーブル描画用のオブジェクト配列
 */
export function jobsToRaw(jobs) {
  return jobs.map(job => {
    const startEpoch = job.startTime ? Date.parse(job.startTime) / 1000 : 0;
    const finishEpoch = job.finishTime ? Date.parse(job.finishTime) / 1000 : 0;
    return {
      id:            job.id,
      filename:      job.filename,
      startway:      null,
      size:          0,
      ctime:         startEpoch,
      starttime:     startEpoch,
      usagetime:     finishEpoch ? finishEpoch - startEpoch : 0,
      usagematerial: job.materialUsedMm,
      printfinish:   finishEpoch ? 1 : 0,
      filemd5:       "",
      ...(job.preparationTime      !== undefined && { preparationTime:      job.preparationTime }),
      ...(job.firstLayerCheckTime   !== undefined && { firstLayerCheckTime:   job.firstLayerCheckTime }),
      ...(job.pauseTime             !== undefined && { pauseTime:             job.pauseTime }),
      ...(job.filamentId            !== undefined && { filamentId:            job.filamentId }),
      ...(job.filamentColor         !== undefined && { filamentColor:         job.filamentColor }),
      ...(job.filamentType          !== undefined && { filamentType:          job.filamentType })
    };
  });
}

// ---------------------- 描画テンプレート ----------------------

/**
 * ISO8601 文字列を「YYYY-MM-DD hh:mm:ss」に整形
 * @param {string|null} iso
 * @returns {string}
 */
function fmtISO(iso) {
  return iso
    ? iso.replace("T", " ").replace(/\.\d+Z$/, "")
    : "—";
}

export const renderTemplates = {
 /**
  * 現在印刷中 & 直前印刷用 大サムネイル表示テンプレート
  * @param job
  * @param {string} baseUrl 例: "http://192.168.54.151"
  */
  current(job, baseUrl) {
    const fmt = iso => iso ? formatEpochToDateTime(iso) : "—";
    // 大サムネイル URL
    const currentUrl = `${baseUrl}/downloads/original/current_print_image.png`;
    const prevUrl    = `${baseUrl}/downloads/original/temp_image.png`;
    // フォールバック画像
    const fallback   = `${baseUrl}/downloads/defData/file_print_photo.png`;
    return `
      <div class="current-print">
        <img
          class="print-job-thumb--large"
          src="${currentUrl}"
          onerror="this.onerror=null;this.src='${fallback}'"
          alt="現在印刷中"
        />
        <div class="print-job-info">
          <div class="filename"><strong>現在:</strong> ${job.filename}</div>
          <div class="times">開始: ${fmt(job.startTime)}</div>
          <div class="material-used">使用: ${job.materialUsedMm.toLocaleString()} mm</div>
        </div>
      </div>
      <div class="prev-print" style="margin-top:1em;">
        <img
          class="print-job-thumb--large"
          src="${prevUrl}"
          onerror="this.onerror=null;this.src='${fallback}'"
          alt="直前印刷"
        />
        <div class="print-job-info">
           <div class="filename"><strong>直前:</strong> ${job.filename}</div>
           <div class="times">完了: ${ job.finishTime ? fmt(job.finishTime) : "—" }</div>
        </div>
      </div>
    `;
  },

  /**
   * 履歴リスト用 小サムネイル表示テンプレート
   * @param job
   * @param {string} baseUrl
   */
  historyItem(job, baseUrl) {
    const thumbUrl = makeThumbUrl(baseUrl, job.rawFilename || job.filename);
    const fallback = `${baseUrl}/downloads/defData/file_icon.png`;
    const fmt = iso => iso ? formatEpochToDateTime(iso) : "—";
    return `
      <img
        class="print-job-thumb"
        src="${thumbUrl}"
        onerror="this.onerror=null;this.src='${fallback}'"
        alt="${job.filename}"
      />
      <div class="print-job-info">
        <div class="filename">${job.filename}</div>
        <div class="times">
          開始: ${fmt(job.startTime)}
          ${job.finishTime ? `<br>完了: ${fmt(job.finishTime)}` : ""}
        </div>
        <div class="material-used">
          使用: ${job.materialUsedMm.toLocaleString()} mm
        </div>
      </div>
    `;
  }
}; // ← renderTemplates 終了




// ---------------------- DOM 描画 ----------------------

/**
 * 現在印刷中ジョブを指定コンテナに描画
 * @param {HTMLElement} containerEl
 */
export function renderPrintCurrent(containerEl) {
  containerEl.innerHTML = "";
  const job = loadCurrent();
  const ip = getDeviceIp();
  const baseUrl = `http://${ip}`;


  if (!job) {
    containerEl.innerHTML = "<p>現在印刷中のジョブはありません。</p>";
    return;
  } else {
    containerEl.innerHTML = renderTemplates.current(job, baseUrl);
  }
}


/**
 * 印刷履歴リストを指定コンテナ（ul または div）に描画
 * @param {HTMLElement} containerEl
 */
export function renderPrintHistory(containerEl) {
  const jobs = loadHistory();
  const ip = getDeviceIp();
  const baseUrl = `http://${ip}`;

  containerEl.innerHTML = "";
  if (!jobs.length) {
    containerEl.innerHTML = "<li>履歴がありません。</li>";
    return;
  }
  for (const job of jobs) {
    const li = document.createElement("li");
    li.className = "print-job-item";
    // rawFilename を渡せるように、履歴保存時に保持しておくと良いです
    li.innerHTML = renderTemplates.historyItem(job, baseUrl);
    containerEl.appendChild(li);
  }
}


/**
 * WebSocket から取得したデータを元に履歴を更新し再描画
 * @param {() => Promise<Object>} fetchStoredData - サーバーデータ取得関数
 * @param {string} baseUrl - サムネイル URL のベース
 * @param {string} [currentContainerId="print-current-container"]
 * @param {string} [historyContainerId="print-history-list"]
 */
export async function refreshHistory(
  fetchStoredData,
  baseUrl,
  currentContainerId = "print-current-container",
  historyContainerId = "print-history-list"
) {
  // 生データ取得
  const sd  = await fetchStoredData();
  const raw = Array.isArray(sd.historyList) ? sd.historyList : [];

  // パース → 永続化（既存データとマージ）
  const newJobs = parseRawHistoryList(raw, baseUrl);
  const oldJobs = loadHistory();
  const mergedMap = new Map();
  newJobs.forEach(j => mergedMap.set(j.id, j));
  oldJobs.forEach(j => {
    if (!mergedMap.has(j.id)) mergedMap.set(j.id, j);
  });
  const jobs = Array.from(mergedMap.values())
    .sort((a, b) => b.id - a.id)
    .slice(0, MAX_HISTORY);
  saveHistory(jobs);

  // 現在印刷中ジョブの更新があれば再描画
  const prev = loadCurrent();
  if (jobs[0]?.id !== prev?.id) {
    saveCurrent(jobs[0]);
    renderPrintCurrent(document.getElementById(currentContainerId));
  }

  // --- テーブル描画 ---
  const rawMap = new Map(raw.map(r => [r.id, r]));
  jobs.forEach(j => {
    if (!rawMap.has(j.id)) {
      rawMap.set(j.id, jobsToRaw([j])[0]);
    }
  });
  const mergedRaw = Array.from(rawMap.values())
    .sort((a, b) => b.id - a.id)
    .slice(0, MAX_HISTORY);
  renderHistoryTable(mergedRaw, baseUrl);
}

/**
 * rawArray の各エントリを HTML テーブルに描画し、
 * 操作ボタンにイベントをバインドします。
 *
 * @param {Array<Object>} rawArray - プリンタから受信した生履歴データ配列
 * @param {string} baseUrl         - サムネイル取得用のサーバーベース URL
 */
export function renderHistoryTable(rawArray, baseUrl) {
  const tbody = document.querySelector("#print-history-table tbody");
  const fmt = iso => iso ? formatEpochToDateTime(iso) : "—";
  const startwayMap = {
    1:  "機器操作経由",
    11: "外部操作経由",
    9:  "クラウド経由"
  };
  
  if (!tbody) return;

  tbody.innerHTML = "";

  rawArray.forEach((raw, index) => {
    const name     = raw.filename.split("/").pop();
    const thumbUrl = makeThumbUrl(baseUrl, raw.filename);
    const fallback = `${baseUrl}/downloads/defData/file_icon.png`;

    // テーブル行を作成
    const startwayLabel =
      raw.startway !== undefined
        ? (startwayMap[raw.startway] || raw.startway)
        : "—";
    const size      = raw.size != null ? raw.size.toLocaleString() : "—";
    const ctime     = raw.ctime ? fmt(raw.ctime) : "—";
    const stime     = raw.starttime ? fmt(raw.starttime) : "—";
    const utime     = raw.usagetime != null ? raw.usagetime : "—";
    const umaterial =
      raw.usagematerial != null
        ? (Math.ceil(raw.usagematerial * 100) / 100).toLocaleString()
        : "—";
    const finish    = raw.printfinish ? "✔︎" : "";
    const md5       = raw.filemd5 || "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <button class="cmd-print">印刷</button>
        <button class="cmd-rename">名前変更</button>
        <button class="cmd-delete">削除</button>
      </td>
      <td>${index + 1}</td>
      <td>${raw.id}</td>
      <td>
        <img
          src="${thumbUrl}"
          alt="${name}"
          style="width:50px"
          onerror="this.onerror=null;this.src='${fallback}'"
        />
      </td>
      <td>${name}</td>
      <td data-key="startway">${startwayLabel}</td>
      <td>${size}</td>
      <td>${ctime}</td>
      <td>${stime}</td>
      <td>${utime}</td>
      <td>${umaterial}</td>
      <td>${finish}</td>
      <td>${md5}</td>
    `;
    tbody.appendChild(tr);

    // ボタンごとにクリックハンドラを登録
    tr.querySelector(".cmd-print")?.addEventListener("click", () => {
      handlePrintClick(raw, thumbUrl);
    });
    tr.querySelector(".cmd-rename")?.addEventListener("click", () => {
      handleRenameClick(raw);
    });
    tr.querySelector(".cmd-delete")?.addEventListener("click", () => {
      handleDeleteClick(raw);
    });
  });

  // ソート用リスナ追加
  document.querySelectorAll("#print-history-table th").forEach(th => {
    th.addEventListener("click", () => sortTable("#print-history-table", th.dataset.key));
  });

}

/**
 * 印刷実行ボタン押下時の処理。
 * 残フィラメント量を計算し、確認ダイアログを表示後、送信します。
 *
 * @param {Object} raw     - 行データ
 * @param {string} thumbUrl - サムネイル画像の URL
 */
async function handlePrintClick(raw, thumbUrl) {
  const usedSec          = raw.usagetime;
  const expectedFinish   = new Date(Date.now() + usedSec * 1000).toLocaleString();
  const materialNeeded   = Math.ceil(raw.usagematerial * 100) / 100;
  const machine          = monitorData.machines[monitorData.currentHostname] || {};
  const remaining        = machine.settings?.filamentRemainingMm ?? 0;
  const afterRemaining   = Math.max(0, remaining - materialNeeded).toLocaleString();

  const html = `
    <img src="${thumbUrl}" style="width:80px; float:left; margin:0 12px 12px 0">
    <div><strong>${raw.filename.split("/").pop()}</strong></div>
    <div>所要時間: ${usedSec}s → 完了見込: ${expectedFinish}</div>
    <div>フィラメント: ${remaining} − ${materialNeeded} ＝ ${afterRemaining} mm</div>
  `;

  const ok = await showConfirmDialog({
    level:       "info",
    title:       "印刷実行の確認",
    // messageは 空,
    html:        html,
    confirmText: "印刷する",
    cancelText:  "キャンセル"
  });
  if (!ok) return;

  // 実際にプリントコマンドを送信
  sendCommand("set", {
    opGcodeFile: `printprt:${raw.filename}`
  });
}

/**
 * 削除ボタン押下時の処理。
 * 確認ダイアログ後に削除コマンドを送信します。
 *
 * @param {Object} raw - 行データ
 */
async function handleDeleteClick(raw) {
  const name = raw.filename.split("/").pop();

  const html = `削除すると元に戻せません。本当によろしいですか? <br>ファイル: ${name}`;

  const ok = await showConfirmDialog({
    level:       "error",
    title:       "ファイル削除の確認",
    // messageは 空,
    html:        html,
    confirmText: "削除",
    cancelText:  "キャンセル"
  });
  if (!ok) return;

  sendCommand("set", {
    opGcodeFile: `deleteprt:${raw.filename}`
  });
}

/**
 * 名前変更ボタン押下時の処理。
 * prompt で新名称を入力後、確認ダイアログ、送信を行います。
 *
 * @param {Object} raw - 行データ
 */
async function handleRenameClick(raw) {
  const oldName = raw.filename.split("/").pop();

  const newName = await showInputDialog({
    level:        "warn",                         // 警告レベル
    title:        "ファイル名変更の確認",         // ダイアログタイトル
    message:      "新しいファイル名を入力してください", // プレーンテキスト本文
    // html:       "...",                        // 必要ならここに HTML を入れられます
    defaultValue: oldName,                       // 初期入力値
    confirmText:  "変更する",                     // OK ボタンのラベル
    cancelText:   "キャンセル"                    // キャンセルボタンのラベル
  });

  // newName が null → キャンセル、空文字 → 何も変更しない
  if (newName == null || newName === oldName) return;

  const ok = await showConfirmDialog({
    level:       "warn",
    title:       "ファイル名変更の確認",
    message:     "以下のように変更します。よろしいですか?",
    html:        `変更前: ${oldName}<br>変更後: ${newName}`,
    confirmText: "変更する",
    cancelText:  "キャンセル"
  });
  if (!ok) return;

  // 元ディレクトリを維持してフルパスを組み立て
  const dir = raw.filename.slice(0, raw.filename.lastIndexOf("/"));
  sendCommand("set", {
    opGcodeFile: `renameprt:${raw.filename}:${dir}/${newName}`
  });
}

/**
 * GCode ファイルから埋め込み PNG サムネを抜き出す
 * @param {File} file
 * @returns {Promise<string|null>} data:image/png;base64,...  or null
 */
async function extractThumbnailFromFile(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*;\s*png begin/.test(l));
  const end   = lines.findIndex(l => /^\s*;\s*png end/.test(l), start+1);
  if (start < 0 || end < 0) return null;
  const b64 = lines.slice(start+1, end)
                   .map(l => l.replace(/^\s*;\s*/, ""))
                   .join("");
  return `data:image/png;base64,${b64}`;
}

/** アップロード UI の初期化 */
export function setupUploadUI() {
  const btn        = document.getElementById("gcode-upload-btn");
  const input      = document.getElementById("gcode-upload-input");
  const progress   = document.getElementById("gcode-upload-progress");
  const percentEl  = document.getElementById("gcode-upload-percent");
  const dropLayer  = document.getElementById("drop-overlay");
  if (!btn || !input || !progress || !percentEl || !dropLayer) return;

  let currentFile = null;

  function updateProgress(loaded, total) {
    if (!total) { percentEl.textContent = "0%"; return; }
    const pct = Math.floor((loaded / total) * 100);
    const remain = total - loaded;
    const remainMb = (remain / (1024 * 1024)).toFixed(1);
    percentEl.textContent = `${pct}% (残り ${remainMb}MB)`;
  }

  function showProgress() { progress.classList.remove("hidden"); }
  function hideProgress() { progress.classList.add("hidden"); updateProgress(0,0); }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = e => {
        if (e.lengthComputable) updateProgress(e.loaded, e.total);
      };
      reader.onerror = () => reject(new Error("read error"));
      reader.onload = () => resolve(reader.result);
      reader.readAsText(file);
    });
  }

  function extractThumb(text) {
    const lines = text.split(/\r?\n/);
    const s = lines.findIndex(l => /^\s*;\s*png begin/.test(l));
    const e = lines.findIndex(l => /^\s*;\s*png end/.test(l), s + 1);
    if (s < 0 || e < 0) return null;
    const b64 = lines.slice(s + 1, e).map(l => l.replace(/^\s*;\s*/, "")).join("");
    return `data:image/png;base64,${b64}`;
  }

  async function prepareAndConfirm(file) {
    currentFile = file;
    btn.disabled = true;
    showProgress();
    try {
      const text = await readFile(file);
      updateProgress(file.size, file.size);
      let thumb = extractThumb(text);
      if (!thumb) {
        const ip = getDeviceIp();
        thumb = `http://${ip}/downloads/defData/file_icon.png`;
      }
      hideProgress();
      btn.disabled = false;
      const html = `
        <img src="${thumb}" style="width:100px; display:block; margin-bottom:8px">
        <div><strong>${file.name}</strong> をアップロードしますか？</div>`;
      const ok = await showConfirmDialog({
        level: "info",
        title: "ファイルアップロードの確認",
        html,
        confirmText: "アップロード",
        cancelText: "キャンセル"
      });
      if (ok) uploadFile(file);
    } catch (e) {
      hideProgress();
      btn.disabled = false;
      console.error(e);
      showConfirmDialog({
        level: "error",
        title: "ファイル読み込み失敗",
        message: e.message,
        confirmText: "OK"
      });
    }
  }

  function uploadFile(file) {
    btn.disabled = true;
    showProgress();
    updateProgress(0, file.size);

    const ip  = getDeviceIp();
    const url = `http://${ip}/upload/${encodeURIComponent(file.name)}`;
    const form = new FormData();
    form.append("file", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) updateProgress(e.loaded, e.total);
    };
    xhr.onload = async () => {
      hideProgress();
      btn.disabled = false;
      if (xhr.status === 200) {
        await showConfirmDialog({
          level: "success",
          title: "アップロード完了",
          message: `${file.name} を正常にアップロードしました。`,
          confirmText: "OK"
        });
        currentFile = null;
        input.value = "";
      } else {
        await showConfirmDialog({
          level: "error",
          title: "アップロード失敗",
          message: `エラー: ${xhr.status} ${xhr.statusText}`,
          confirmText: "OK"
        });
      }
    };
    const handleError = async () => {
      hideProgress();
      btn.disabled = false;
      await showConfirmDialog({
        level: "error",
        title: "アップロード失敗",
        message: "ネットワークエラー",
        confirmText: "OK"
      });
    };
    xhr.onerror = handleError;
    xhr.onabort = handleError;
    xhr.ontimeout = handleError;
    xhr.send(form);
  }

  input.addEventListener("change", () => {
    if (input.files?.length) prepareAndConfirm(input.files[0]);
  });

  btn.addEventListener("click", () => {
    if (currentFile) {
      uploadFile(currentFile);
    } else if (input.files?.length) {
      prepareAndConfirm(input.files[0]);
    } else {
      alert("まず .gcode ファイルを選択してください");
    }
  });

  document.addEventListener("dragover", e => {
    e.preventDefault();
    dropLayer.classList.remove("hidden");
  });
  document.addEventListener("dragleave", e => {
    if (e.target === document || e.target === dropLayer) {
      dropLayer.classList.add("hidden");
    }
  });
  document.addEventListener("drop", e => {
    e.preventDefault();
    dropLayer.classList.add("hidden");
    if (e.dataTransfer?.files?.length) {
      prepareAndConfirm(e.dataTransfer.files[0]);
    }
  });
}

/** --- 1) タブ切り替えの初期設定 --- */
export function initHistoryTabs() {
  const btnH = document.getElementById("tab-print-history");
  const btnF = document.getElementById("tab-file-list");
  const pH = document.getElementById("panel-print-history-tab");
  const pF = document.getElementById("panel-file-list");
  btnH.addEventListener("click", () => {
    btnH.classList.add("active"); btnF.classList.remove("active");
    pH.classList.remove("hidden"); pF.classList.add("hidden");
  });
  btnF.addEventListener("click", () => {
    btnF.classList.add("active"); btnH.classList.remove("active");
    pF.classList.remove("hidden"); pH.classList.add("hidden");
  });
}

/** --- 2) fileInfo テキストをパースして配列に --- */
function parseFileInfo(text, baseUrl) {
  // 各ファイル情報は「;」区切り
  return text.split(";").filter(s=>s).map((entry, idx) => {
    const [path,filename, size, layer, mtime, expect, thumb] = entry.split(":");
    const fullPath  = `${path}/${filename}`;
    const thumbUrl  = makeThumbUrl(baseUrl, thumb);
    return {
      // --- テーブル描画に必要なフィールド ---
      number:       idx + 1,
      basename:     filename,                    // 表示用のファイル名
      size:         Number(size),
      layer:        Number(layer),
      mtime:        new Date(Number(mtime) * 1000),
      expect:       Number(expect),
      thumbUrl:     thumbUrl,

      // --- 履歴(raw) と同じインターフェース ---
      filename:     fullPath,                    // raw.filename
      usagetime:    0,                           // ファイル一覧では不明なので 0 or 適宜
      usagematerial: Number(expect) || 0         // raw.usagematerial 相当
    };
  });
}

/** --- 3) ファイル一覧描画 --- */
export function renderFileList(info, baseUrl) {
  // parseFileInfo で揃えたキー群をもつオブジェクト配列を得る
  const arr = parseFileInfo(info.fileInfo, baseUrl);

  // 総数表示
  document.getElementById("file-list-total").textContent = info.totalNum;

  const tbody = document.querySelector("#file-list-table tbody");
  tbody.innerHTML = "";

  arr.forEach(item => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <button class="cmd-print">印刷</button>
        <button class="cmd-rename">名前変更</button>
        <button class="cmd-delete">削除</button>
      </td>
      <td data-key="number">${item.number}</td>
      <td data-key="thumb">
        <img
          src="${item.thumbUrl}"
          alt="${item.basename}"
          style="width:40px"
          onerror="this.onerror=null;this.src='${baseUrl}/downloads/defData/file_icon.png'"
        >
      </td>
      <td data-key="filename">${item.basename}</td>
      <td data-key="layer">${item.layer.toLocaleString()}</td>
      <td data-key="size">${item.size.toLocaleString()}</td>
      <td data-key="mtime">${item.mtime.toLocaleString()}</td>
      <td data-key="expect">${item.expect.toLocaleString()}</td>
    `;
    tbody.appendChild(tr);

    // 印刷ボタン：raw オブジェクトと thumbUrl を渡す
    tr.querySelector(".cmd-print")?.addEventListener("click", () => {
      handlePrintClick(item, item.thumbUrl);
    });
    // 名前変更／削除：raw.filename（フルパス）や usagetime/usagematerial が item に含まれる
    tr.querySelector(".cmd-rename")?.addEventListener("click", () => {
      handleRenameClick(item);
    });
    tr.querySelector(".cmd-delete")?.addEventListener("click", () => {
      handleDeleteClick(item);
    });
  });

  // --- ソート機能登録 ---
  document.querySelectorAll("#file-list-table th").forEach(th => {
    th.addEventListener("click", () => {
      sortTable("#file-list-table", th.dataset.key);
    });
  });
}

/** --- 4) 汎用ソート関数 --- */
function sortTable(selector, key) {
  const table = document.querySelector(selector);
  const tbody = table.querySelector("tbody");
  const rows = Array.from(tbody.querySelectorAll("tr"));
  // 昇順<->降順トグル
  const asc = !table.dataset[ key + "_asc" ];
  table.dataset[ key + "_asc" ] = asc ? "1" : "";

  rows.sort((a, b) => {
    const va = a.querySelector(`td[data-key="${key}"]`)?.textContent || "";
    const vb = b.querySelector(`td[data-key="${key}"]`)?.textContent || "";
    // 数値 or 文字列
    const na = parseFloat(va.replace(/,/g,"")) || va;
    const nb = parseFloat(vb.replace(/,/g,"")) || vb;
    return asc ? (na > nb ? 1 : -1) : (na < nb ? 1 : -1);
  });
  rows.forEach(r => tbody.appendChild(r));
}
