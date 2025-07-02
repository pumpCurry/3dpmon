# P-0 — カード純粋コンポーネント化

rev 1.0 2025-07-xx 初版（ChatGPT 出力）
rev 1.1 2025-07-03 Card_Status などの unsubscribe 修正

## ゴール
1. すべてのカードクラスが `new Card_X({ deviceId, bus, initialState })` で生成可能。
2. カードは EventBus 経由でのみデータを受け取る。
3. `destroy()` で必ず unsubscribe する。
4. ユニットテストで DOM ↔ state 反映を確認。
5. 既存 UI が変わらず動作する。

## 影響ファイル
- `src/cards/BaseCard.js`
- `src/cards/Card_Camera.js`
- `src/cards/Card_HeadPreview.js`
- `src/cards/Card_Status.js`
- `src/cards/Card_TempGraph.js`
- `src/cards/Card_ControlPanel.js`
- `src/cards/Card_CurrentPrint.js`

## 作業工程
1. BaseCard に `connected()` / `destroy()` ダミー実装を追加。
2. 各カードのコンストラクタを `{ deviceId, bus }` 受け取りに変更し、必要な subscribe を `connected()` へまとめる。
3. DashboardManager からカード生成時に `deviceId` を渡すよう修正。
4. 各カードに対するユニットテストを実装し、新 API で動くことを保証。
5. Playwright での Smoke テストを追加。

## テスト設計
- Vitest を用い、各カードの DOM 更新を検証。
- Playwright によりダッシュボードを起動し、Bus へイベント送信して UI が更新されるか確認。

### P0-R1 追加修正
- `Card_TempGraph.destroy()` が `bus.off('printer:id:temps')` を呼ぶよう修正。
- リスナー解除をテストで確認。

### P0-R2 追加修正
- Card_Status / Card_ControlPanel / Card_CurrentPrint が同一関数で解除し漏れないよう修正。

