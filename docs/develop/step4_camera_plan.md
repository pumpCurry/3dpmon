## ステップ④ ― CameraCard 分離計画

本ドキュメントでは `future.md` に基づき CameraCard を既存プレビューから分離する作業内容をまとめる。

### 1. 目的
- 既存のプレビュー機能を独立した `Card_Camera.js` へ移行し、拡張性を高める。
- `BaseCard` クラスを新設し、カード共通のライフサイクルと操作を統一する。

### 2. 作業タスク
| ID | 内容 | 完了条件 |
|----|------|---------|
|T4-A|`BaseCard.js` 抽象化|CameraCard が継承|
|T4-B|`<video>` stream 実装|映像が表示される|
|T4-C|エラー／再接続ロジック|強制切断テストで自動復帰|
|T4-D|最小サイズ & aspect CSS|ウィンドウ縮小テストで崩れない|
|T4-E|ハンバーガー → 倍率スライダー|scale 0.5–2.0 動作|
|T4-F|単体テスト (happy-dom)|mount / retry / scale|
|T4-G|ドキュメント `docs/develop/camera.md`|API・CSS・再接続フロー|
|T4-H|Coverage ≥ 80 %|CI 緑|

### 3. 実装ポイント
- `init({streamUrl,minSize,aspect})` で初期設定を受け取り、`update()` で URL 変更に追従する。
- `<video>` 要素に `error` / `stalled` イベントを監視し、3 回目で `retry()` を発火。失敗時は `/snapshot.jpg` を表示。
- `scale(x)` と `setPosition(x,y)` は BaseCard で提供。ドラッグ配置時の `data-card-id` は `CAMV`。

