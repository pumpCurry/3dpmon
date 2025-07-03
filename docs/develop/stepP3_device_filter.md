# P-3 ― デバイスフィルタ & グローバルバッジ

本ステップでは接続中デバイスをチップ形式で表示し、カードをデバイス毎に絞り込む機能を追加する。

## 1. 追加ファイル
- `src/widgets/DeviceFilterBar.js`
- `src/core/CardContainer.js`
- `styles/device_filter.scss`
- `tests/unit/device_filter.test.js`
- `tests/e2e/device_filter.spec.ts`

## 2. 機能概要
- Dashboard 右上にデバイスフィルタバーを表示する。
- 選択したチップに対応しないカードは `opacity:0.2` かつ `pointer-events:none` となる。
- 選択状態は `LayoutStore` の `current.filter` として保存され、再読み込み後も復元される。

## 3. 使い方
1. 接続ダイアログからプリンタを追加するとフィルタバーへチップが挿入される。
2. チップをクリックすると `filter:change` イベントが発火し `CardContainer` がカードの表示を更新する。
3. 選択状態はレイアウト保存時に保持される。

## 4. テスト
- `vitest` によるユニットテストでフィルタ適用処理を検証。
- `playwright` による E2E テストで UI 操作と状態保持を確認。

## 5. アクセシビリティ
- チップは `button` 要素として実装し `aria-pressed` 属性で選択状態を示す。
- Space / Enter キーによる切替をサポート。
- 接続が削除され選択中デバイスが無い場合は自動的に `ALL` に戻る。

### 2025-07-03 更新
- `aria-pressed` 更新処理を追加
- Space/Enter 押下で click() するキーボード操作を実装
- 存在しないデバイス ID が選択されていた場合 `ALL` へ戻るよう監視

