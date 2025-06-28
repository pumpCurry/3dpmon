# 3dpmon v2 — テスト仕様書

## 1. 目的
コア層・カード層の退行を早期検出する。

## 2. レイヤ
| レイヤ | ツール | 主対象 |
|-------|-------|-------|
| Unit  | Vitest | utils, EventBus |
| Integration | Vitest + WS mock | ConnectionManager |
| E2E  | Playwright (Step⑧) | UI/カード |

## 3. 命名
`tests/<module>.test.js`

## 4. 基準
- `npm test` 全緑
- カバレッジ ≥ 80 %
