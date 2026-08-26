/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 WebRTC カメラ probe モジュール
 * @file probe_k2_webrtc_camera.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module probe_k2_webrtc_camera
 *
 * 【機能内容サマリ】
 * - K2 Pro Combo の WebRTC camera signalling endpoint を Electron/Chromium で read-only 検証する
 * - SDP answer、ICE、remote track、video frame のどこまで到達したかをJSON証跡として保存する
 *
 * 【公開関数一覧】
 * - {@link parseArgs}：CLI引数をprobe設定へ変換
 * - {@link buildSignalingUrl}：host/port/pathからsignalling URLを生成
 * - {@link runNodeCli}：Node側からElectron probe childを起動
 * - {@link runElectronChild}：Electron main側でWebRTC probe windowを起動
 *
 * @version 1.390.1392 (PR #432)
 * @since   1.390.1392 (PR #432)
 * @lastModified 2026-08-26 09:48:13
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { spawn, spawnSync } from "child_process";
import { dirname, relative, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const DEFAULT_HOST = "192.168.54.153";
const DEFAULT_SIGNALING_PORT = 8000;
const DEFAULT_SIGNALING_PATH = "/call/webrtc_local";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_OUTPUT_DIR = resolve(PROJECT_ROOT, "tmp", "k2-webrtc-probe");
const HARNESS_PATH = resolve(PROJECT_ROOT, "tests", "e2e", "k2_webrtc_probe.html");
const ELECTRON_ENTRY_PATH = resolve(PROJECT_ROOT, "scripts", "probe_k2_webrtc_camera_electron.js");

/**
 * Electron childへ渡すpathをproject root相対へ変換する。
 *
 * 【詳細説明】
 * - Windows上のElectron CLIは、probe用entryや一部引数を絶対pathで受けるとstderrなしで終了する環境がある。
 * - 既存E2Eと同じくproject rootをcwdにした相対pathを渡し、child側で必要に応じて絶対pathへ戻す。
 *
 * @function toProjectRelativePath
 * @param {string} filePath - project root配下のpath
 * @returns {string} Electron CLIへ渡すproject root相対path
 */
function toProjectRelativePath(filePath) {
  const value = relative(PROJECT_ROOT, resolve(filePath));
  return value && !value.startsWith("..") ? value.replace(/\\/g, "/") : filePath;
}

/**
 * Electron child起動用のコマンドと引数を生成する。
 *
 * 【詳細説明】
 * - WindowsではPowerShell shimをExecutionPolicy Bypassで呼び、既存の手動probe成功経路と同じ条件にする。
 * - その他の環境ではElectron binaryを直接spawnする。
 *
 * @function buildElectronSpawnSpec
 * @param {string} electron - Electron binaryまたはshim path
 * @param {string[]} args - Electronへ渡す引数
 * @returns {{command:string,args:string[],shell:boolean}} spawn設定
 */
function buildElectronSpawnSpec(electron, args) {
  return {
    command: electron,
    args,
    shell: process.platform === "win32",
  };
}

/**
 * CLIヘルプを生成する。
 *
 * 【詳細説明】
 * - live probeはプリンタへWebRTC offerをPOSTするが、設定変更や印刷操作は行わない。
 * - `--host` だけ指定すれば `/info.videoPort` とは独立した既知のK2 endpoint `:8000/call/webrtc_local` を試す。
 *
 * @function usage
 * @returns {string} CLIヘルプ文字列
 */
function usage() {
  return `Usage: node scripts/probe_k2_webrtc_camera.mjs [options]

Options:
  --host <ip>              K2 printer host. Default: ${DEFAULT_HOST}
  --signaling-url <url>    Explicit WebRTC signalling endpoint.
  --signaling-port <port>  Signalling port when URL is not explicit. Default: ${DEFAULT_SIGNALING_PORT}
  --timeout-ms <ms>        Overall probe timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --output-dir <path>      Evidence output directory. Default: ${DEFAULT_OUTPUT_DIR}
  --headed                 Show the Electron probe window.
  --keep-open              Keep Electron window open after result for manual inspection.
  --help                   Show this help.
`;
}

/**
 * host文字列をURL用hostへ正規化する。
 *
 * 【詳細説明】
 * - `http://host:port` のような入力からhost名だけを取り出す。
 * - IPv6 literalは今回のK2実機対象外だが、角括弧付きhostとして扱える形を維持する。
 *
 * @function normalizeHost
 * @param {string} value - CLIで指定されたhost候補
 * @returns {string} 正規化したhost
 */
function normalizeHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_HOST;
  try {
    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw).hostname;
    }
  } catch {
    return raw;
  }
  return raw.replace(/^wss?:\/\//i, "").replace(/:\d+$/, "");
}

/**
 * WebRTC signalling URLを生成する。
 *
 * 【詳細説明】
 * - K2 Pro Combo実機と公開実装で観測された `http://host:8000/call/webrtc_local` を既定にする。
 * - `/info.videoPort=443` はHTTPS signalling候補として別途probeできるが、この関数の既定値にはしない。
 *
 * @function buildSignalingUrl
 * @param {object} options - URL生成option
 * @param {string} options.host - printer host
 * @param {number} [options.signalingPort=8000] - signalling port
 * @param {string} [options.signalingPath="/call/webrtc_local"] - signalling path
 * @returns {string} signalling URL
 */
export function buildSignalingUrl({
  host,
  signalingPort = DEFAULT_SIGNALING_PORT,
  signalingPath = DEFAULT_SIGNALING_PATH,
}) {
  const normalizedHost = normalizeHost(host);
  const port = Number(signalingPort);
  const path = String(signalingPath || DEFAULT_SIGNALING_PATH).startsWith("/")
    ? String(signalingPath || DEFAULT_SIGNALING_PATH)
    : `/${signalingPath}`;
  return `http://${normalizedHost}:${Number.isInteger(port) && port > 0 ? port : DEFAULT_SIGNALING_PORT}${path}`;
}

/**
 * CLI引数をprobe設定へ変換する。
 *
 * 【詳細説明】
 * - unknown optionは即時エラーにして、実機probeで意図しない送信先へPOSTしない。
 * - `--signaling-url` がある場合はport/path指定より優先する。
 *
 * @function parseArgs
 * @param {string[]} argv - `process.argv.slice(2)` 相当
 * @returns {object} probe設定
 * @throws {Error} 未知optionまたは値不足の場合
 */
export function parseArgs(argv = []) {
  const options = {
    host: DEFAULT_HOST,
    signalingPort: DEFAULT_SIGNALING_PORT,
    signalingUrl: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outputDir: DEFAULT_OUTPUT_DIR,
    headed: false,
    keepOpen: false,
    help: false,
    electronChild: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    switch (arg) {
      case "--host":
        options.host = normalizeHost(next());
        break;
      case "--signaling-url":
        options.signalingUrl = String(next()).trim();
        break;
      case "--signaling-port":
        options.signalingPort = Number(next());
        break;
      case "--timeout-ms":
        options.timeoutMs = Math.max(5000, Number(next()) || DEFAULT_TIMEOUT_MS);
        break;
      case "--output-dir":
        options.outputDir = resolve(String(next()));
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--keep-open":
        options.keepOpen = true;
        break;
      case "--electron-child":
        options.electronChild = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.signalingUrl) {
    options.signalingUrl = buildSignalingUrl(options);
  }
  return options;
}

/**
 * Electron実行ファイルのpathを解決する。
 *
 * 【詳細説明】
 * - Windowsでは `node_modules/.bin/electron.cmd` が実体になるため、platform別に候補を選ぶ。
 * - 直接pathが見つからない場合は `electron` packageが返すbinary pathをフォールバックに使う。
 *
 * @function resolveElectronBinary
 * @returns {Promise<string>} Electron実行ファイルpath
 */
async function resolveElectronBinary() {
  const bin = resolve(PROJECT_ROOT, "node_modules", ".bin", "electron");
  if (existsSync(bin)) {
    return bin;
  }
  const electronModule = await import("electron");
  return String(electronModule.default || electronModule);
}

/**
 * プロセスツリーを終了する。
 *
 * 【詳細説明】
 * - Windowsの `.cmd` 経由起動ではElectron子プロセスが残ることがあるため、`taskkill /T /F` を使う。
 *
 * @function terminateProcessTree
 * @param {import("child_process").ChildProcess|null|undefined} proc - 終了対象プロセス
 * @returns {void}
 */
function terminateProcessTree(proc) {
  if (!proc || proc.killed) {
    return;
  }
  if (process.platform === "win32" && proc.pid) {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
    });
    return;
  }
  proc.kill();
}

/**
 * 証跡JSON/SDPを保存する。
 *
 * 【詳細説明】
 * - summaryにはSDP全文を含めず、offer.sdp / answer.sdp へ分離して保存する。
 * - terminalへ出すsummaryは短くし、reviewに必要な到達phaseだけを読みやすくする。
 *
 * @function writeEvidence
 * @param {object} result - rendererから受け取ったprobe結果
 * @param {string} outputDir - 保存先directory
 * @returns {Promise<object>} 保存pathを含むsummary
 */
async function writeEvidence(result, outputDir) {
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(outputDir, stamp);
  await mkdir(runDir, { recursive: true });
  const offerSdp = String(result.offerSdp || "");
  const answerSdp = String(result.answerSdp || "");
  const summary = {
    ...result,
    offerSdp: offerSdp ? `saved:${offerSdp.length}` : "",
    answerSdp: answerSdp ? `saved:${answerSdp.length}` : "",
    evidenceDir: runDir,
  };
  await writeFile(resolve(runDir, "connection-result.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (offerSdp) await writeFile(resolve(runDir, "offer.sdp"), offerSdp, "utf8");
  if (answerSdp) await writeFile(resolve(runDir, "answer.sdp"), answerSdp, "utf8");
  return summary;
}

/**
 * Node側CLIとしてElectron childを起動する。
 *
 * 【詳細説明】
 * - 実WebRTC処理はChromium rendererで行い、Node側は結果JSONを受け取って証跡保存する。
 * - printerへ送るのはWebRTC offer POSTだけで、SSH/設定変更/ファイル配置は一切行わない。
 *
 * @function runNodeCli
 * @param {object} options - {@link parseArgs} の戻り値
 * @returns {Promise<object>} probe summary
 */
export async function runNodeCli(options) {
  if (options.help) {
    console.log(usage());
    return { result: "help" };
  }
  const electron = await resolveElectronBinary();
  const args = [
    toProjectRelativePath(ELECTRON_ENTRY_PATH),
  ];
  const childOptions = {
    ...options,
    outputDir: toProjectRelativePath(options.outputDir),
  };
  const spawnSpec = buildElectronSpawnSpec(electron, args);
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        ELECTRON_DISABLE_GPU: "1",
        K2_WEBRTC_PROBE_OPTIONS: JSON.stringify(childOptions),
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: spawnSpec.shell,
    });
    let stdout = "";
    let stderr = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        terminateProcessTree(proc);
        rejectPromise(new Error(`K2 WebRTC probe timeout after ${options.timeoutMs}ms\n${stderr.slice(-1000)}`));
      }
    }, options.timeoutMs + 10000);

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    proc.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        rejectPromise(error);
      }
    });
    proc.on("exit", async (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const marker = "K2_WEBRTC_PROBE_RESULT=";
      const line = stdout.split(/\r?\n/).find((item) => item.startsWith(marker));
      if (!line) {
        rejectPromise(new Error(`Probe did not emit result marker. exit=${code}\n${stderr.slice(-1000)}`));
        return;
      }
      try {
        const result = JSON.parse(line.slice(marker.length));
        const summary = await writeEvidence(result, options.outputDir);
        console.log(JSON.stringify({
          result: summary.result,
          signaling: summary.signaling,
          peerConnection: summary.peerConnection,
          track: summary.track,
          video: summary.video,
          evidenceDir: summary.evidenceDir,
        }, null, 2));
        resolvePromise(summary);
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}

/**
 * Electron child側でprobe windowを作成する。
 *
 * 【詳細説明】
 * - contextBridge経由でrendererからmainへ結果を返す。
 * - production appではない独立harnessなので、probe終了後は即座にappを終了する。
 *
 * @function runElectronChild
 * @param {object} options - probe設定
 * @returns {Promise<void>} 完了で解決
 */
export async function runElectronChild(options) {
  const { app, BrowserWindow, ipcMain } = await import("electron");
  const preloadPath = resolve(options.outputDir, "k2-webrtc-probe-preload.cjs");
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(preloadPath, `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("k2ProbeApi", {
  complete: (result) => ipcRenderer.invoke("k2-probe-complete", result)
});
`, "utf8");

  await app.whenReady();
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: Boolean(options.headed || options.keepOpen),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false,
    },
  });
  const done = new Promise((resolveDone) => {
    ipcMain.handle("k2-probe-complete", async (_event, result) => {
      console.log(`K2_WEBRTC_PROBE_RESULT=${JSON.stringify(result)}`);
      if (!options.keepOpen) {
        resolveDone();
      }
      return { ok: true };
    });
  });
  const url = new URL(pathToFileURL(HARNESS_PATH).href);
  url.searchParams.set("host", options.host);
  url.searchParams.set("signalingUrl", options.signalingUrl);
  url.searchParams.set("timeoutMs", String(options.timeoutMs));
  await win.loadURL(url.href);
  await done;
  if (!options.keepOpen) {
    app.quit();
  }
}

/**
 * CLI entrypointを実行する。
 *
 * @function main
 * @returns {Promise<void>} 完了で解決
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.electronChild || process.versions.electron) {
    await runElectronChild(options);
    return;
  }
  const summary = await runNodeCli(options);
  if (summary.result && summary.result !== "success" && summary.result !== "help") {
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export const __private__ = {
  DEFAULT_HOST,
  DEFAULT_SIGNALING_PORT,
  DEFAULT_SIGNALING_PATH,
  normalizeHost,
  buildElectronSpawnSpec,
  toProjectRelativePath,
  usage,
};
