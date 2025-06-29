## ステップ⑤ ― HeadPreviewCard 分離・実装仕様

このドキュメントでは `future.md` におけるステップ⑤で予定されている HeadPreviewCard（HDPV）の実装計画をまとめる。ステップ④ "CameraCard" は最終レビューで完全 GREEN となり、次フェーズとしてツールヘッドの位置可視化カードを追加する。

### 1. 背景と目的
- ホットエンド位置を 2D/3D 表示し、各プリンタ機種のベッドサイズへ自動適応させる。
- 既存 BaseCard のドラッグ・倍率調整機能を活用し、単体で動的に開閉できるカードとする。

### 2. 主要ファイル構成
```
src/cards/
 ├ Card_HeadPreview.js   ★本体(ID: HDPV)
 ├ headpreview.worker.js ★描画ワーカ (optional)
styles/card_headpreview.scss
tests/headpreview.test.js
docs/develop/headpreview.md
```

### 3. 公開 API
| メソッド | 機能 |
| -------- | ---- |
| `init({ position, model })` | `position = {x,y,z}` とプリンタ `model` を受け取りベッドサイズを取得 |
| `mount(container)` | Canvas または SVG を生成しコンテナへ挿入 |
| `update({ position })` | ヘッド座標をアニメーション更新 |
| `destroy()` | ループ停止・Canvas 開放 |

### 4. 機能要件
| 要件 | 詳細 |
| --- | --- |
| **描画方式** | デフォルトは Canvas2D。`import('three')` に成功した場合は Three.js による 3D 表示へ切替 |
| **ベッドサイズ** | `ModelAdapter.getBedSize(model)` → `{w,h,zMax}` を参照 |
| **Z 表示** | 2D は Z バー横表示、3D は高さでヘッドドットを浮かせる |
| **フレーム更新** | `requestAnimationFrame` で 30 FPS 目標 |
| **最小カードサイズ** | 200×200px、scale 0.5–2.0 に対応 |
| **エラー処理** | position が NaN の場合は警告アイコンを表示 |
| **EventBus** | `head:setModel` / `head:updatePos` を購読 |
| **アクセシビリティ** | Canvas に `role="img"` と `aria-label="Head position X..Y..Z.."` を毎秒更新 |

### 5. 実装タスク一覧
| ID | 作業 | 完了基準 |
| --- | ---- | ---- |
| **T5-A** | `headpreview.worker.js` で y-up → 画面座標変換 | ワーカが `postMessage` で描画データ返却 |
| **T5-B** | Canvas2D レンダラ実装 | 方眼 + ヘッドマーカーが表示 |
| **T5-C** | Three.js レンダラ (feature flag) | `HDPV_USE_3D=true` で 3D 描画 |
| **T5-D** | ModelAdapter へ `getBedSize` 追加 | K1=220×220×250 等を返す |
| **T5-E** | BaseCard 倍率連携 | スライダーで Canvas scale |
| **T5-F** | 単体テスト (happy-dom) | update→canvas draw 呼び出しをモック検証 |
| **T5-G** | ドキュメント `headpreview.md` 執筆 | API / Model 設定方法を記載 |
| **T5-H** | カバレッジ ≥ 80% & CI 緑 | `npm test` 成功、Codex CI 成功 |

### 6. ブランチ & ワークフロー
```
git checkout -b feature/v2-step5-headpreview
# T5-A … H を実装
git push origin feature/v2-step5-headpreview
# Pull Request → レビュー → merge
```

three を導入する場合は `npm install three@^0.162` を行い、lockfile を更新する。Codex の setup スクリプトは lockfile に基づき `npm ci` を実行するため、追加依存を忘れずにコミットすること。
