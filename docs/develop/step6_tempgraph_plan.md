## ステップ⑥ ― TempGraphCard & SideMenu 計画

`future.md` のステップ⑥を元に、温度グラフ高速化とサイドメニュー導入に関する作業内容をまとめる。HDPV の最終ポリッシュが完了したため次フェーズへ移行する。

### 1. 背景と目的
- Chart.js を廃止し、軽量な LiteChart 実装で 5 台同時表示時でも 60 FPS を維持する。
- サイドメニューに各種設定 UI を集約し、ハンバーガーアイコンからアクセスできるようにする。

### 2. 主要ファイル構成
```
src/cards/Card_TempGraph.js      ★再実装
src/cards/Bar_SideMenu.js        ★新規
src/shared/TempRingBuffer.js     ★データ構造
bench/tempgraph.bench.js         ★CI用
styles/card_temp.scss
styles/bar_side.scss
docs/develop/temp_graph.md
docs/develop/side_menu.md
```

### 3. 実装タスク
| ID | 内容 | 完了基準 |
|----|------|---------|
|T6-A|LiteChart 導入 – Chart.js 削除|`npm ls | grep chart.js` が 0|
|T6-B|TempRingBuffer – push/pop 2 ms 以内|Vitest ベンチ PASS|
|T6-C|温度・ファン 2 軸描画 + ホバー表示|実際のホバーで値表示|
|T6-D|SideMenu UI – スライド表示・フォーカストラップ|Lighthouse A11y 100|
|T6-E|ハンバーガーから SideMenu 開閉|動作確認|
|T6-F|ベンチ `npm run bench:temp`|FPS ≥ 60 & PASS|
|T6-G|単体テスト TempGraph/SideMenu|Coverage ≥ 80 %|
|T6-H|ドキュメント更新|API・テーマ・キーバインド記載|
|T6-I|CHANGELOG v2.0-rc 更新|ステップ④⑤⑥ 要点記載|

### 4. ブランチ & ワークフロー
```
git checkout -b feature/v2-step6-temp-sidemenu
# T6-A … I を実装し PR を送る
```
