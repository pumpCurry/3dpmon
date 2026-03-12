# ADR-0003 per-host データ分離の設計方針

## ステータス
採用・実装済み (v2.1.005)

## コンテキスト
v2.1 でマルチプリンタ対応を実装したが、多くのモジュールにグローバルシングルトン変数（モジュールレベル `let`）が残存していた。これにより以下の問題が発生:

- プリンタAの温度データがプリンタBのグラフに表示される
- フィラメント交換が全プリンタに適用される
- 印刷ステート遷移パターンが混合される
- カメラON/OFFが全プリンタに影響する

## 決定
**全てのデバイス固有データは hostname をキーとした Map で管理する。**

### 管理パターン
1. **`monitorData` フィールド**: `hostSpoolMap`, `hostCameraToggle` — 永続化対象
2. **モジュールレベル Map**: `_hostStates`, `_hostChartData`, `_previewHostStates`, `_stateHistoryMap`, `_fileListMap`, `_hostTts` — 揮発性（セッション中のみ）
3. **関数引数**: hostname を必須パラメータとして渡す（デフォルト値なし）

### 禁止事項
- `hostname || currentHostname` や `hostname || "_default"` のようなフォールバックは禁止
- hostname 未指定の場合は早期 return または null を返す
- `currentHostname` は後方互換のブートストラップ用途のみ（新規コードでは使用禁止）

### グローバルで正当なデータ
以下はアプリ全体で共有される設計上の意図がある:
- `appSettings` (接続先リスト、更新間隔、ログレベル等)
- `filamentSpools` / `filamentPresets` / `usageHistory` / `filamentInventory` (フィラメントは機器横断で管理)
- `spoolSerialCounter` (通し番号は全体で一意)

## 結果
- プリンタ間のデータ漏洩が根絶された
- 各モジュールが独立して per-host 状態を管理
- hostname 引数の省略はコンパイル時には検出できないが、実行時に console.warn で警告
- v2.1.004 で全面監査を実施し、16ファイル・30箇所以上のフォールバックを除去
- v2.1.005 で第3次監査を実施：hostname 渡し漏れ修正、回転関数 per-host 化、JSDoc hostname 必須化（12ファイル）

## 変更履歴
| 日付 | 内容 |
|------|------|
| 2026-03-10 | 初版: Phase 1-5 per-host 化 |
| 2026-03-12 | v2.1.004: 全面監査、残存フォールバック除去、レガシー deprecated 関数削除 |
| 2026-03-12 | v2.1.005: 第3次監査、hostname 渡し漏れ修正、回転関数 per-host 化、JSDoc 必須化 |
