/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 K2 WebRTC probe Electron bootstrap モジュール
 * @file probe_k2_webrtc_camera_electron.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module probe_k2_webrtc_camera_electron
 *
 * 【機能内容サマリ】
 * - Electron main process から ESM の K2 WebRTC probe 本体を起動する
 *
 * 【公開関数一覧】
 * - {@link main}：CLI引数をprobe設定に変換し、Electron child処理を開始
 *
 * @version 1.390.1392 (PR #432)
 * @since   1.390.1392 (PR #432)
 * @lastModified 2026-08-26 09:54:22
 * -----------------------------------------------------------
 * @todo
 * - none
 */

/**
 * Electron main process 用のprobe entrypointを実行する。
 *
 * 【詳細説明】
 * - Electron 33 + Windows の組み合わせで `.mjs` を直接main scriptに渡すと、stderrなしで終了する環境がある。
 * - 既存E2Eと同じCommonJS `.js` entrypointに揃え、実処理はESM本体へ委譲する。
 *
 * @function main
 * @returns {Promise<void>} probe完了で解決
 */
async function main() {
  const probe = await import("./probe_k2_webrtc_camera.mjs");
  const options = process.env.K2_WEBRTC_PROBE_OPTIONS
    ? JSON.parse(process.env.K2_WEBRTC_PROBE_OPTIONS)
    : probe.parseArgs(process.argv.slice(2));
  await probe.runElectronChild(options);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
