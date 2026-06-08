/**
 * @fileoverview バージョン同期スクリプト
 * package.json の version を「単一の真実」として、
 * HTML/メタタグ、その他バージョン表記箇所を自動更新する。
 *
 * 実行: node scripts/sync-version.js
 * ビルド前 (npm run build) に自動実行される。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const VERSION = pkg.version;

console.log(`[sync-version] package.json version = ${VERSION}`);

const targets = [
  {
    file: "3dp_monitor.html",
    pattern: /<meta name="app-version" content="[^"]*"\s*\/?>/,
    replace: `<meta name="app-version" content="${VERSION}" />`,
    label: "HTML meta tag"
  },
  {
    // ★ CI の「HTML title version check」が v${VERSION} を grep する。
    //   静的タイトルにもバージョンを反映する（実行時に JS が再設定するが、
    //   静的検証・初期表示のため v 付きで埋め込む）。
    file: "3dp_monitor.html",
    pattern: /<title>3dpmon - 3Dプリンタ監視ダッシュボード(?: v[\d.]+)?<\/title>/,
    replace: `<title>3dpmon - 3Dプリンタ監視ダッシュボード v${VERSION}</title>`,
    label: "HTML title"
  }
];

let updated = 0;
for (const t of targets) {
  const filePath = path.join(ROOT, t.file);
  if (!fs.existsSync(filePath)) {
    console.warn(`[sync-version] スキップ: ${t.file} (見つかりません)`);
    continue;
  }
  const orig = fs.readFileSync(filePath, "utf-8");
  if (!t.pattern.test(orig)) {
    console.warn(`[sync-version] パターン未検出: ${t.file} (${t.label})`);
    continue;
  }
  const next = orig.replace(t.pattern, t.replace);
  if (next === orig) {
    console.log(`[sync-version] 変更なし: ${t.file} (${t.label})`);
    continue;
  }
  fs.writeFileSync(filePath, next, "utf-8");
  updated++;
  console.log(`[sync-version] 更新: ${t.file} (${t.label}) → ${VERSION}`);
}

// ─── package-lock.json: ルート version を同期（バージョンドリフト再発防止） ───
// lockfileVersion 3 では先頭2件の "version"（ルート と packages[""]）のみがパッケージ
// 本体のバージョン。依存パッケージの version を壊さぬよう、先頭2件に限定して置換する。
// （従来 sync-version は package-lock を対象外としており、リリースのたびに lock の
//   version だけ取り残されてドリフトしていた。本処理で恒久的に同期する。）
const lockFile = path.join(ROOT, "package-lock.json");
if (fs.existsSync(lockFile)) {
  const orig = fs.readFileSync(lockFile, "utf-8");
  let n = 0;
  const next = orig.replace(/"version": "[^"]*"/g, (m) => (n++ < 2 ? `"version": "${VERSION}"` : m));
  if (next !== orig) {
    fs.writeFileSync(lockFile, next, "utf-8");
    updated++;
    console.log(`[sync-version] 更新: package-lock.json (root version) → ${VERSION}`);
  } else {
    console.log(`[sync-version] 変更なし: package-lock.json (root version)`);
  }
} else {
  console.warn(`[sync-version] スキップ: package-lock.json (見つかりません)`);
}

console.log(`[sync-version] 完了: ${updated} ファイル更新`);
