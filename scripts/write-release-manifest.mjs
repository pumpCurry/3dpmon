/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 release artifact manifest 生成モジュール
 * @file write-release-manifest.mjs
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module write_release_manifest
 *
 * 【機能内容サマリ】
 * - `dist/` に生成された現在versionの配布成果物を列挙
 * - SHA256、サイズ、git commit、生成時刻をrelease manifestとして保存
 * - release前にreview済みheadと配布exeの対応を確認できる証跡を生成
 *
 * 【公開関数一覧】
 * - なし：Node.js CLI として実行する
 *
 * @version 1.390.1452 (PR #435)
 * @since   1.390.1450 (PR #435)
 * @lastModified 2026-08-28 14:28:57
 * -----------------------------------------------------------
 * @todo
 * - none
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/**
 * CLI引数から指定値を読み取る。
 *
 * 【詳細説明】
 * - `--dist <dir>` と `--out <file>` の単純なkey/valueだけを扱う。
 * - release scriptはビルド後のローカル確認用なので、複雑な引数parserは持たせない。
 *
 * @function readArgValue
 * @param {string} name - 取得する引数名
 * @param {string|null} fallback - 未指定時の値
 * @returns {string|null} 引数値
 */
function readArgValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1] || fallback;
}

/**
 * gitコマンドを実行し、失敗時はnullを返す。
 *
 * 【詳細説明】
 * - archiveやCI artifact上で `.git` が無い場合でもmanifest生成全体を止めない。
 * - git情報が得られない場合はmanifestの該当フィールドをnullにし、成果物hashは必ず残す。
 *
 * @function readGitValue
 * @param {string[]} args - gitへ渡す引数
 * @returns {string|null} コマンド出力
 */
function readGitValue(args) {
  try {
    return (
      execFileSync('git', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * 指定ファイルのSHA256を計算する。
 *
 * 【詳細説明】
 * - 配布exeやblockmapを後から照合できるよう、hex形式のdigestをmanifestへ保存する。
 *
 * @function hashFileSha256
 * @param {string} filePath - 対象ファイルパス
 * @returns {Promise<string>} sha256 hex digest
 */
async function hashFileSha256(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * package.jsonから現在のアプリversionを取得する。
 *
 * 【詳細説明】
 * - release manifestはpackage versionとartifact名を対応付けるため、package.jsonを単一のversion sourceとする。
 *
 * @function readPackageVersion
 * @returns {Promise<string>} package version
 * @throws {Error} package.jsonにversionが無い場合
 */
async function readPackageVersion() {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!version) {
    throw new Error('package.json version is missing');
  }
  return version;
}

/**
 * release manifestへ含めるartifact一覧を作る。
 *
 * 【詳細説明】
 * - electron-builderの成果物名 `3dpmon-${version}-...` だけを対象にし、古いdist残骸を混ぜない。
 * - manifest自身や無関係な一時ファイルは対象外にする。
 *
 * @function collectArtifacts
 * @param {string} distDir - dist directory
 * @param {string} version - package version
 * @returns {Promise<object[]>} artifact summary配列
 */
async function collectArtifacts(distDir, version) {
  const entries = await readdir(distDir, { withFileTypes: true });
  const prefix = `3dpmon-${version}-`;
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) {
      continue;
    }
    const filePath = path.join(distDir, entry.name);
    const info = await stat(filePath);
    artifacts.push({
      fileName: entry.name,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      sha256: await hashFileSha256(filePath),
    });
  }
  artifacts.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return artifacts;
}

/**
 * release manifest objectを生成する。
 *
 * 【詳細説明】
 * - test結果は自動実行結果そのものではなく、manifest生成時点の推奨確認コマンドとして残す。
 * - 実際のPASS結果はrelease notesまたはCI runへ紐付ける。
 *
 * @function createReleaseManifest
 * @param {object} options - 生成オプション
 * @param {string} options.distDir - dist directory
 * @returns {Promise<object>} manifest object
 */
async function createReleaseManifest({ distDir }) {
  const version = await readPackageVersion();
  const artifacts = await collectArtifacts(distDir, version);
  if (artifacts.length === 0) {
    throw new Error(`No release artifacts found for version ${version} in ${distDir}`);
  }
  return {
    schemaVersion: 1,
    product: '3dpmon',
    version,
    gitCommit: readGitValue(['rev-parse', 'HEAD']),
    gitBranch: readGitValue(['rev-parse', '--abbrev-ref', 'HEAD']),
    builtAt: new Date().toISOString(),
    artifacts,
    verificationCommands: [
      'npm run check:version-sync',
      'npm run test:all',
      'npm run build',
      'npm run release:manifest',
    ],
  };
}

/**
 * CLI entrypoint。
 *
 * 【詳細説明】
 * - 既定では `dist/release-manifest-${version}.json` へ保存する。
 * - `--dry-run` 指定時はstdoutへJSONを出し、ファイルは書かない。
 *
 * @function main
 * @returns {Promise<void>} 完了promise
 */
async function main() {
  const distDir = path.resolve(readArgValue('--dist', 'dist'));
  const dryRun = process.argv.includes('--dry-run');
  const manifest = await createReleaseManifest({ distDir });
  const outPath = path.resolve(readArgValue('--out', path.join(distDir, `release-manifest-${manifest.version}.json`)));
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (dryRun) {
    process.stdout.write(json);
    return;
  }
  await writeFile(outPath, json, 'utf8');
  console.log(`[release-manifest] wrote ${outPath}`);
}

await main();
