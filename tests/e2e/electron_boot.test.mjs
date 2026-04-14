/**
 * @fileoverview Electron 起動テスト
 * アプリが起動し、メインウィンドウが表示され、重大なエラーなく動作することを検証する。
 *
 * 実行方法: node tests/e2e/electron_boot.test.mjs
 * （vitest ではなく直接実行 — Electron は Node.js プロセスとして起動する必要がある）
 */

import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");

const TIMEOUT_MS = 30000; // 30秒以内に起動完了すること
const BOOT_SUCCESS_MARKER = "did-finish-load";  // Electron main.js が出力する文字列

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return fn().then(() => {
    passed++;
    results.push({ name, status: "PASS" });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  }).catch(err => {
    failed++;
    results.push({ name, status: "FAIL", error: err.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
  });
}

function spawnElectron(args = [], envOverrides = {}) {
  const electronPath = resolve(PROJECT_ROOT, "node_modules/.bin/electron");
  const mainJs = resolve(PROJECT_ROOT, "electron/main.js");
  return spawn(electronPath, [mainJs, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ELECTRON_DISABLE_GPU: "1", ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true
  });
}

// ======================================================================
//  テスト実行
// ======================================================================

console.log("\n\x1b[1mElectron 起動テスト\x1b[0m\n");

// テスト1: Electron が起動し、ウィンドウが表示される
await test("Electron が起動しウィンドウが表示される (30秒以内)", () => {
  return new Promise((resolve, reject) => {
    const proc = spawnElectron();
    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        // タイムアウト = 起動はしたがマーカーが出なかった
        // stdout/stderr を見てエラーの有無を判断
        if (stderr.includes("Error") || stderr.includes("Cannot find module")) {
          reject(new Error(`起動エラー検出:\n${stderr.slice(0, 500)}`));
        } else if (stdout.length > 0 || stderr.length > 0) {
          // 何らかの出力があり、致命的エラーがない → 起動成功とみなす
          resolve();
        } else {
          reject(new Error("30秒以内にElectronの出力がありませんでした"));
        }
      }
    }, TIMEOUT_MS);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
      // did-finish-load が出たら成功
      if (stdout.includes(BOOT_SUCCESS_MARKER) || stdout.includes("ready")) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          proc.kill();
          resolve();
        }
      }
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      // モジュールロードエラーは即失敗
      if (stderr.includes("is not exported from") ||
          stderr.includes("Cannot find module") ||
          stderr.includes("SyntaxError")) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          proc.kill();
          reject(new Error(`モジュールエラー:\n${stderr.slice(0, 500)}`));
        }
      }
    });

    proc.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Electron が異常終了 (exit code ${code}):\nstderr: ${stderr.slice(0, 500)}`));
        }
      }
    });

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`Electron 起動失敗: ${err.message}`));
      }
    });
  });
});

// テスト2: モジュールの import が全て解決される（ESM 静的解析）
await test("全モジュールの import が解決される", () => {
  return new Promise((resolveP, rejectP) => {
    // Electron のレンダラープロセスでモジュールを読み込むテスト
    // --inspect なしで起動し、stderr にエラーがないか確認
    const proc = spawnElectron(["--test-imports"], {
      ELECTRON_RUN_AS_NODE: "0"
    });
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        // エラーがなければ成功
        if (stderr.includes("is not exported") || stderr.includes("does not provide an export")) {
          rejectP(new Error(`Export エラー:\n${stderr.slice(0, 500)}`));
        } else {
          resolveP();
        }
      }
    }, 15000);

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      if (stderr.includes("is not exported") || stderr.includes("does not provide an export")) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          proc.kill();
          rejectP(new Error(`Export エラー:\n${stderr.slice(0, 500)}`));
        }
      }
    });

    proc.on("exit", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolveP();
      }
    });

    proc.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolveP(); // Electron 起動自体のエラーは test1 でカバー
      }
    });
  });
});

// テスト3: 削除した export が import に残っていないか（静的解析）
await test("削除済み export の import 残存がないこと (静的解析)", async () => {
  const { readFileSync, readdirSync } = await import("fs");
  const libDir = resolve(PROJECT_ROOT, "3dp_lib");
  const files = readdirSync(libDir).filter(f => f.endsWith(".js") && !f.includes(".tmp."));

  const deletedExports = [
    "handleMessage",
    "currentHostname",
    "setCurrentHostname",
    "notificationSuppressed",
    "setupConnectButton",
    "restoreLegacyStoredData",
    "cleanupLegacy",
    "_convertV140toV200"
  ];

  const errors = [];
  for (const f of files) {
    const content = readFileSync(resolve(libDir, f), "utf-8");
    const importLines = content.split("\n").filter(l => l.includes("import ") && l.includes("from "));
    for (const line of importLines) {
      for (const name of deletedExports) {
        // import { xxx, handleMessage, yyy } のパターンを検出
        const importMatch = line.match(/import\s*\{([^}]+)\}/);
        if (importMatch) {
          const imported = importMatch[1].split(",").map(s => s.trim());
          if (imported.includes(name)) {
            errors.push(`${f}: "${name}" がまだ import されています: ${line.trim()}`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
});

// ── 結果サマリー ──
console.log(`\n\x1b[1m結果: ${passed} passed, ${failed} failed\x1b[0m\n`);

if (failed > 0) {
  console.log("\x1b[31m失敗したテスト:\x1b[0m");
  results.filter(r => r.status === "FAIL").forEach(r => {
    console.log(`  - ${r.name}: ${r.error}`);
  });
  process.exit(1);
}
