# 印刷統合スイート ロードマップ

v2.1.005 時点の分析に基づく、フィラメント管理・印刷履歴・ファイル一覧の統合改善計画。

## 背景と課題

### 現状の問題: 3つの「翻訳不足」

1. **機械の言葉 → 人間の言葉**: `12340 mm` → `12.3m (21g, ¥110)` の変換がない
2. **断片データ → 統合インサイト**: 印刷回数・消費量・コスト・時間が別々の画面に散在
3. **過去 → 未来の予測**: 蓄積データから「あと何回印刷できる」「このファイルは前回何分かかった」を導出していない

### データの信頼性問題

- `Math.ceil` による切り上げ丸め → v2.1.005 で除去済み (機器報告値をそのまま保持)
- `usageHistory` と `printStore.history` の二重管理 → 編集時の不整合リスク
- マルチホストでの `usageHistory` トリミングが合算 (ホスト均等でない)
- 印刷中スプール交換の中間記録なし

### 活用されていない既存データ

| データ | 格納場所 | 現状 |
|--------|---------|------|
| `weightFromLength()` / `lengthFromWeight()` | `dashboard_spool.js` | **呼び出し元ゼロ** |
| `MATERIAL_DENSITY` (PLA:1.24, PETG:1.27 等) | `dashboard_spool.js` | **参照ゼロ** |
| `purchasePrice` / `currencySymbol` | spool オブジェクト | **表示のみ、計算に未使用** |
| `usedLengthLog[]` (per-job 消費量) | spool オブジェクト | **蓄積のみ、分析なし** |
| `printIdRanges[]` (ジョブ範囲) | spool オブジェクト | **蓄積のみ、分析なし** |
| `preparationTime` / `pauseTime` | printStore.current | **印刷中カードに未表示** |
| `filamentId` / `filamentColor` / `filamentType` | printStore.current | **印刷中カードに未表示** |
| `nozzleTempMin/Max` / `bedTempMin/Max` | filament preset | **温度チェックに未使用** |
| `completionElapsedTime` | aggregator | **取り出し忘れ通知に未使用** |
| `filemd5` | printStore.history | **クロスホスト比較に未使用** |
| `totalJob` / `totalUsageTime` / `totalUsageMaterial` | storedData | **トレンド分析に未使用** |
| `buildHistoryStats()` | dashboard_printmanager.js | **平均時間を計算可能だが回数/MD5のみ使用** |

---

## 実装計画

### Stage 0: データ精度の基盤修正 — 完了

- [x] `parseRawHistoryEntry` の `Math.ceil` 除去 (printmanager:258)
- [x] `renderPrintCurrent` の `Math.ceil` 除去 (printmanager:563)
- [x] `handlePrintClick` の `Math.ceil` 除去 (printmanager:1183)
- [x] aggregator の `Math.round` 除去 (aggregator:1085)

### Stage 1: ユーティリティ基盤

#### 1-1. `formatFilamentAmount(mm, spool)` — 統一フォーマッタ

**目的**: 全 UI で mm 値を人間可読にする共通関数。

**仕様**:
```javascript
formatFilamentAmount(12340, spool)
// → { mm: 12340, m: "12.3", g: "21", cost: "110", display: "12.3m (21g, ¥110)" }

formatFilamentAmount(12340, null)
// → { mm: 12340, m: "12.3", g: null, cost: null, display: "12.3m" }
```

**依存**: `weightFromLength()`, `MATERIAL_DENSITY` (既存・未接続)

**適用箇所** (14箇所以上):
- 印刷前ダイアログ (printmanager `handlePrintClick`)
- 印刷中カード (printmanager `renderPrintCurrent`)
- 印刷履歴テーブル (printmanager `renderHistoryTable`)
- ファイル一覧の期待消費量 (printmanager `renderFileList`)
- フィラメント管理 Tab 0 ダッシュボード (filament_manager)
- フィラメント管理 Tab 2 スプール一覧 (filament_manager)
- フィラメント管理 Tab 3 使用履歴 (filament_manager)
- フィラメント管理 Tab 4 集計レポート (filament_manager)
- フィラメント交換ダイアログ (filament_change)
- 通知テキスト (notification_manager)
- 印刷完了通知 (aggregator notify呼び出し)

#### 1-2. `buildFileInsight(filename, hostname)` — ファイル別実績

**目的**: ファイル1つについて、全印刷実績を統合して返す。

**仕様**:
```javascript
buildFileInsight("Benchy.gcode", hostname)
// → {
//   printCount: 5, successCount: 4, failCount: 1, successRate: 0.8,
//   avgDurationSec: 5880, lastPrintDate: "2026-03-14T14:30:00Z", lastResult: 1,
//   avgMaterialMm: 12340, avgMaterialGram: 21, avgCost: 110,
//   expectedMm: 12000, expectedVsActualPct: 2.8,
//   md5: "abc12345..."
// }
```

**依存**: `buildHistoryStats()` (既存) + `loadPrintHistory()` + `formatFilamentAmount`

#### 1-3. `buildSpoolAnalytics(spoolId)` — スプール別分析

**目的**: スプール1つについて消費パターンと予測を返す。

**仕様**:
```javascript
buildSpoolAnalytics("spool_123_abc")
// → {
//   totalConsumed: 184800, consumedPct: 55,
//   avgPerPrint: 12340, printCount: 15,
//   costPerPrint: 200, remainingCost: 1350,
//   daysActive: 24, printsPerDay: 0.625,
//   estimatedRemainingPrints: 12, estimatedRemainingDays: 19,
//   consumptionTrend: [{date, remaining}, ...],
//   recentJobs: [{jobId, used, date}, ...]
// }
```

**依存**: `usedLengthLog[]`, `printIdRanges[]`, `purchasePrice`

### Stage 2: 既存画面の改善

#### 2-1. 印刷前ダイアログ刷新

**現在**:
```
所要時間: 3600s → 完了見込: 2026-03-15 17:00:00
フィラメント: 151200 − 12340 ＝ 138860 mm
```

**改善後**:
```
■ 過去の実績 (5回 / 成功率 80%)
  平均所要: 1時間38分 (実印刷 1h30m + 準備 8m)
  平均消費: 12.3m (21g, ¥110)
  最終: 2026-03-14 ✔ 成功

■ 現スプール: #001 Emerald PLA
  残量: 151.2m (45%, 264g, ¥1,350)
  印刷後予想: 138.9m (41%, 243g, ¥1,240)
  判定: ✓ 十分  /  ⚠ 不足の場合は赤で警告

■ 予想完了: 約 16:38 (実績ベース)
```

**変更ファイル**: `dashboard_printmanager.js` (`handlePrintClick`)

#### 2-2. 印刷中カードにスプール情報追加

現在のカードに追加:
- スプール名・色・素材 (`filamentId` → `getSpoolById`)
- 残量 % バー
- 準備時間・停止時間 (`preparationTime`, `pauseTime`)

**変更ファイル**: `dashboard_printmanager.js` (`renderTemplates.current`)

#### 2-3. ファイル一覧に列追加

| 追加列 | データソース |
|--------|------------|
| 平均時間 | `buildFileInsight().avgDurationSec` |
| 成功率 | `buildFileInsight().successRate` |
| 実績消費量 | `buildFileInsight().avgMaterialMm` → `formatFilamentAmount` |

**変更ファイル**: `dashboard_printmanager.js` (`renderFileList`)

#### 2-4. 履歴テーブル使用量の人間可読化

`12340 mm` → `12.3m (21g, ¥110)` に `formatFilamentAmount` 適用。

**変更ファイル**: `dashboard_printmanager.js` (`renderHistoryTable`)

#### 2-5. 確認ダイアログの秒数→formatDuration

`3600s` → `1時間00分` に変更。

**変更ファイル**: `dashboard_printmanager.js` (`handlePrintClick`)

### Stage 3: 通知・アラートの強化

#### 3-1. 完了通知テンプレートの強化

**現在**: `"{hostname} で印刷が完了しました ({now})"`

**改善後**: `"{hostname} 印刷完了 ✔ {duration} / 消費 {material} / スプール残 {spoolRemain}"`

**変更ファイル**: `dashboard_notification_defaults.js`, `dashboard_aggregator.js` (notify 呼び出し箇所)

#### 3-2. フィラメント不足警告

`handlePrintClick` で `remaining < materialNeeded` 時に確認ダイアログを `warnRed` レベルに変更。

#### 3-3. 取り出し忘れリマインダー

`completionElapsedTime > 30分` (設定可能) で通知発火。

**変更ファイル**: `dashboard_aggregator.js` (`aggregateTimersAndPredictions`)

#### 3-4. 温度範囲チェック

印刷中、ノズル温度がマウント中スプールの `nozzleTempMin/Max` 外の場合に通知。

#### 3-5. Webhook 外部通知 (新機能)

通知イベント発火時に、設定された URL に HTTP POST でペイロードを送信する機能。
ユーザーはこれを使って Slack / Discord / LINE / IFTTT 等に連携可能。

**仕様**:
- 接続設定モーダルに Webhook URL 入力欄を追加 (per-host)
- 通知イベント発火時に `fetch(url, { method: "POST", body: JSON.stringify(payload) })`
- ペイロード: `{ event, hostname, message, timestamp, data: { ... } }`
- オプション: イベント種別ごとの有効/無効設定
- エラー時はログ出力のみ (リトライなし、UI ブロックなし)

### Stage 4: 分析・インサイト

#### 4-1. スプール消費推移グラフ

`usedLengthLog[]` + `printIdRanges[]` を時系列プロット (Chart.js)。
フィラメント管理のスプール詳細ドリルダウンに表示。

#### 4-2. コスト集計レポート多軸化

Tab 4 に追加する軸:
- コスト (¥/日, ¥/週, ¥/月) — `purchasePrice × 消費比率`
- 素材別内訳 (PLA/PETG/ABS)
- プリンタ別比較
- 前月比較

#### 4-3. プリンタ間効率比較

同一 `filemd5` の印刷を cross-host で比較:
- 所要時間差
- 消費量差
- 成功率差

#### 4-4. ファイル信頼性ランキング

`printfinish` の成功/失敗を集計し、ファイル別の信頼性を表示。

#### 4-5. スプール枯渇予測

直近の消費レートから残日数を推定。ダッシュボード (Tab 0) に「残り少ないスプール」として表示。

#### 4-6. 素材別コスト効率

`MATERIAL_DENSITY` × mm → g → ¥/g を算出。素材ごとのコストパフォーマンスを比較。

### Stage 5: 統合ビュー

#### 5-1. ジョブ詳細パネル

履歴行クリックで展開される統合ビュー:
- 時間内訳 (準備/確認/印刷/停止)
- 素材消費 (mm/g/¥)
- スプール残量変動 (開始→終了)
- 同一ファイルの過去実績比較

#### 5-2. スプール詳細ドリルダウン

Tab 2 のスプールクリックで表示:
- 3D プレビュー
- 基本情報 + コスト実績
- 消費推移グラフ (usedLengthLog)
- このスプールの印刷履歴一覧

---

## 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-03-15 | 初版: v2.1.005 分析に基づく統合改善計画策定 |
