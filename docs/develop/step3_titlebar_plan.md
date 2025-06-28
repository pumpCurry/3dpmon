## ステップ③ ― TitleBar 実装まとめ

このドキュメントでは、`future.md` で示されたステップ③の要件と
PR #252 のレビュー結果を踏まえ、今後の実装タスクを整理する。

### 1. 背景
- V2 移行計画における第三段階として TitleBar コンポーネントを完成させる。
- 現状では最低限のタブ表示のみで、BaseBar 抽象クラス化や a11y 対応が未完。

### 2. 未完タスク一覧
| ID   | 内容                         | 優先度 |
| ---- | -------------------------- | ---- |
| T3-A | BaseBar への共通機能追加         | ★ |
| T3-B | EventBus `tab:add`/`tab:remove` | ★ |
| T3-C | キーボードナビゲーション              | ★ |
| T3-D | 単体テスト追加                     | ◎ |
| T3-E | ドキュメント更新                   | ◎ |
| T3-F | スタイル調整                       | ○ |
| T3-G | Hamburger ボタンのイベントスタブ   | ○ |

### 3. 実装の方針
1. `BaseBar` にドラッグハンドル等の共通メソッドを追加する。
2. `TitleBar` で `tab:add`/`tab:remove` を発火し、ConnectionManager 側で
   TODO コメントを設置して後続開発へ繋げる。
3. `role="tablist"` / `role="tab"` と `aria-selected` を付与し、
   左右キーでタブ移動、Enter キーで選択イベントを実装する。
4. Vitest で追加テストを作成し、DOM 追加・削除・キーボード操作を検証する。
5. `docs/develop/titlebar.md` に API と DOM 構造を追記し、README からリンクする。
6. CSS はコントラスト比 4.5:1 を満たすよう微調整し、Safari でのマスク表示崩れを確認する。
7. サイドメニュー実装までは `bus.emit('menu:global')` のみを発火する。

### 4. 完了条件
1. CI・ローカルテストがすべて緑になること。
2. 新たな JSDoc 付きコードが main ブランチへマージされること。
3. README の「Architecture Picture」へ TitleBar を含む図を追加する。（任意）
