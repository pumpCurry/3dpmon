## ステップ⑤ ― HeadPreviewCard レビュー後タスク整理

`future.md` のステップ⑤で追加された HeadPreviewCard 実装は PR #257 にて基本機能が完了した。ここでは最終リリースへ向けて残されたタスクを整理する。

### 1. 背景
HeadPreviewCard は描画ループとイベントバス連携が動作しているが、アクセシビリティ面の操作性とパフォーマンス計測の自動化が未着手である。ユーザー体験と品質保証を高めるため、以下の作業を追加で実施する。

### 2. 追加タスク一覧
| ID | 必須度 | 内容 | 完了条件 |
| --- | --- | --- | --- |
| T5-I | ★ | **キーボードフォーカスとショートカット**<br>`tabindex="0"` をカード根要素へ付与し、`Space` でズームリセット、`?` でショートカットガイドを表示する。`aria-keyshortcuts="Space,?"` を追加 | Lighthouse Accessibility スコア 100 / README にキー一覧記載 |
| T5-J | ★ | **自動パフォーマンスベンチを CI に組込**<br>`npm run bench:head` 実行で 5 秒間の描画フレーム数を計測し、FPS が 28 以上なら成功とするワークフローを追加 | GitHub Actions `bench / headpreview` が緑になる |

### 3. 実装メモ
- キーボードショートカットは `keydown` イベントで処理し、`BaseCard.scale()` を利用して倍率を 1.0 に戻す。
- `nano-bench` を用いて FPS を計測する軽量ベンチマークスクリプトを `bench/headpreview.bench.js` として配置する。
- CI では optional ジョブとしてベンチを走らせ、失敗しても他ジョブには影響しないよう `continue-on-error: true` を指定する。
