/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 PR履歴自動生成スクリプト
 * @file pr_history_generator.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module pr_history_generator
 *
 * 【機能内容サマリ】
 * - git log からマージ済み PR 情報を抽出し Markdown 形式で出力
 *
 * 【公開関数一覧】
 * - {@link generateHistory} : PR 履歴を docs/develop/pr_history.md に書き出す
 *
 * @version 1.390.0 (PR #99999)
 * @since   1.390.0 (PR #99999)
 * @lastModified  2025-01-01 00:00:00
 * -----------------------------------------------------------
 * @todo
 * - 生成先パスのカスタマイズ
 * - コミットメッセージから PR タイトルを抽出する高度な解析
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/**
 * git log から PR 情報を抽出して Markdown へ保存する
 *
 * @function generateHistory
 * @returns {void}
 */
export function generateHistory() {
  // `git log` でマージコミットを対象に情報を取得
  const log = execSync(
    "git log --merges --grep 'pull request' --pretty=format:'%ad|%s' --date=short",
    { encoding: 'utf8' }
  );

  const lines = log.trim().split('\n');
  const rows = lines.map(line => {
    const [date, subject] = line.split('|');
    const match = subject.match(/#(\d+)/);
    const prNum = match ? `#${match[1]}` : 'N/A';
    // ブランチ名やタイトルに相当する部分を抽出
    const afterNum = subject
      .replace(/^Merge pull request #[0-9]+ from [^/]+\//, '')
      .trim();
    return `| ${date} | ${prNum} | ${afterNum} |`;
  });

  const header = '# PR History\n\n| Date | PR | Summary |\n| --- | --- | --- |\n';
  const content = header + rows.join('\n') + '\n';
  writeFileSync('docs/develop/pr_history.md', content);
}

// スクリプト実行時に直接呼び出す
if (import.meta.url === `file://${process.argv[1]}`) {
  generateHistory();
}
