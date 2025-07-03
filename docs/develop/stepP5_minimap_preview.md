# P-5 ― Live Preview & Mini-Map

本ステップではダッシュボード右下にレイアウト全体を俯瞰するミニマップを追加する。
カードの現在状態を小さなサムネイルとして表示し、クリックで対象カードへ移動する。

## 1. 追加ファイル
- `src/widgets/MiniMap.js`
- `styles/minimap.scss`
- `tests/unit/minimap.test.js`
- `tests/e2e/minimap_focus.spec.ts`

## 2. 機能概要
- `MiniMap` クラスは `LayoutStore` から現在レイアウトを取得し SVG で矩形を描画。
- カメラと温度グラフカードは定期的に `card:snapshot` を emit しサムネイルを更新。
- クリックした矩形のカードへスムーズスクロールし 500ms ハイライト。
- `Alt+M` で表示切替、`Esc` で非表示。ドラッグで移動可能。
- ビューポート幅 640px 未満では自動的に非表示。

## 3. テスト
- unit: レイアウトの矩形数が一致すること、`card:snapshot` で画像が更新されること。
- e2e: 矩形クリックでカードがフォーカスされ、Alt+M でトグルされること。

