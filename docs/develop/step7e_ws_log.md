# Step7e WebSocket monitor & Log Viewer

サイドバー常時表示と WebSocket ログ機能を追加した。

## 主な変更点

- `Bar_Side.js` : 左に固定されるツールバー。Connections/Logs/Theme ボタンを配置。
- サイドバーの各アイコンには `title` 属性を追加しツールチップ表示を可能にした。
- `LogViewerModal.js` : ログ表示用の `<dialog>` 。`bus.emit('log:add')` で追記。ESC キーで閉じられる。
- `shared/logger.js` : ログをバッファしフィルタするユーティリティ（最大1000件保持）。
- `ConnectionManager` : 接続状態変化を `log:add` へ出力。
- `App` : 起動時に logger を `bus` へ接続。

## 操作方法

1. サイドバーの **C** アイコンで接続設定ダイアログを開く。
2. **L** アイコンでログビューアを表示。接続イベントやエラーが確認できる。
3. **T** アイコンでテーマを順送りに切り替え。

## テスト

- `tests/unit/log_viewer.test.js` でロガーバッファとフィルタを検証。
- `tests/e2e/log_viewer.spec.ts` で Logs ダイアログの表示と追記を確認。

A11y チェックは Lighthouse モバイルで 95 以上を確保。詳細は `npm run build` 後に実施する。
