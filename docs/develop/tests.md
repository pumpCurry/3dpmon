# 3dpmon v2 ― テスト仕様書

## 1. 目的
ConnectionManager・カード群の退行バグを早期検出する。

## 2. テストレイヤ
| レイヤ | ツール | 対象 |
|-------|-------|-----|
| 単体 | Vitest | utils, core |
| 結合 | Vitest+Mock WS | ConnectionManager ↔ EventBus |
| E2E | Playwright (Step⑧) | UI/カード相互作用 |

## 3. 命名規約
`tests/<module>.test.js`

## 4. 成功基準
- `npm test` 緑 100%
- カバレッジ 80% 以上
