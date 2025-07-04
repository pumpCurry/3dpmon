# P-5 Residuals — Layout Backup

レイアウト管理機能の仕上げとして、設定カードからエクスポート / インポートを行える
よう実装する。自動バックアップ処理は IndexedDB に保存され、手動で JSON をDL可能。

## 1. 追加ファイル
- `src/core/backup.js`
- `tests/unit/backup.test.js`
- `tests/unit/settings_card.test.js`

## 2. 変更点
- `LayoutStore.importJson()` を追加。名前衝突時は `name (n)` 形式で追
  加する。
- `exportLayouts()` は接続設定も含む `{ connections, layouts }` を返す。
- `Card_Settings` ボタンに `title` 属性を付与。

## 3. テスト
- `layout_store.test.js` でインポート処理の重複解決を確認。
- 新規ユニットテストで `exportLayouts` と UI 属性を検証。
