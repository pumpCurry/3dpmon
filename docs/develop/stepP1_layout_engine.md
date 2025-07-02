# P-1 — LayoutStore + CardContainer 実装

rev 1.0 2025-07-03 初版（ChatGPT 出力）

## ゴール
- カード配置とプリンタIDを含むレイアウトを JSON 保存 / 復元する
- SideBar から新規作成・保存・切替が可能
- CSS Grid + Sortable.js を用いたドラッグ/リサイズ対応

## 追加ファイル
- `src/core/LayoutStore.js`
- `src/core/CardContainer.js`
- `src/dialogs/LayoutModal.js`
- `styles/card_container.scss`
- `tests/unit/layout_store.test.js`
- `tests/unit/card_container.test.js`
- `tests/e2e/layout_switch.spec.ts`

## データスキーマ
- `CardInst`：カードID、種別、deviceId、位置サイズ等
- `Layout`：レイアウトID、名前、更新時刻、カード配列
- 保存先は `localStorage.layouts`

## LayoutStore API
- `getAll()` / `get(id)` / `save(layout)` / `delete(id)`
- `generateId()` は nanoid/non-secure を使用

## テスト設計
- unit: 保存で件数増、削除で減
- card_container: 読み込みで子数一致、ドラッグ終了で layout:update 発火
- e2e: レイアウト切り替えでカード表示が変化
