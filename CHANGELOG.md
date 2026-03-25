# Changelog

## v2.1.006 (2026-03-25)

### UI/UX品質改善（Phase 0-4）

ペルソナベースの機能分析・レビューを実施し、統合管理スイートとしての品質をC級→B+級に改善した。

#### Phase 0: CI/CD基盤再構築
- **vitest** 導入（137テスト: unit 54 + protocol 56 + integration 13 + production 12 + spool 2）
- **ESLint** flat config + jsdoc プラグイン、**Prettier**、**Stylelint** 導入
- GitHub Actions CI ワークフロー刷新（test + lint パイプライン）

#### Phase 1: CSSデザイントークン＋インラインスタイル撲滅
- `:root` に60+のCSS Custom Properties 定義（色/z-index/スペーシング/タイポ/シャドウ/トランジション）
- ダークテーマ: `@media (prefers-color-scheme: dark)` + `.theme-dark` クラスの2系統対応
- JS内のインラインスタイル146箇所→0箇所（100%解消）
- 5ファイルの `injectStyles()` を外部CSSに抽出
- CSS設計ガイドライン文書 + AGENTS.md にルール追加

#### Phase 2: フィラメント管理拡張
- **カスタムプリセット**: ユーザーが自由にブランド/素材/色を登録・編集・削除
  - 素材密度テーブル: 4種→13種（ASA, PA, PC, PVA, HIPS, PP, POM, PEEK, PEI等）
  - プリセット非表示/アーカイブ、JSON インポート/エクスポート
- **在庫アラート**: `minStockAlert` 閾値、赤/黄背景、ダッシュボードバッジ通知
- **廃棄ロス可視化**: Tab 4 に廃棄スプール数/金額/素材別内訳/直近リスト表示
- **印刷前安全ゲート**: 素材不一致検出、スプール未装着警告、残量バー付き確認ダイアログ

#### Phase 3: 製造時間管理
- 新モジュール `dashboard_production.js` + 新パネル「生産管理」
- per-host 稼働率、日次生産レポート（7日間）、GCode見積 vs 実績比較、フリートサマリー

#### Phase 4: UI一貫性の徹底
- 空状態/ローディング/エラーの統一コンポーネント（ARIA属性付き）
- アクセシビリティ: `role="alertdialog"` + ESCキー + フォーカストラップ + `:focus-visible`
- レスポンシブ: テーブル水平スクロール、モバイルダイアログ全幅化、flex-wrap
- 色弱対応: デュアルエンコード（色 + アイコン + wavy下線 + ハッチングパターン）

---

## v2.1.005 (2026-03-12)

### per-host hostname 渡し漏れ修正（第3次監査）

per-host 化後に残存していた hostname 未渡し・任意引数を全面修正し、全モジュールで hostname を必須化した。

#### バグ修正
- **`resolveFilamentJobId`**: `prevPrintID` を参照するが引数に無かった問題を修正（第3引数に追加、3箇所の呼び出し元を更新）
- **`restoreAggregatorState`**: `handleMessage` 内で `initHost` を渡さず呼んでいた問題を修正
- **アップロード処理の hostname 未渡し**: `getDeviceIp()` ×2箇所、`scopedById("file-list-table")` で hostname 省略 → 誤ったプリンタへの送信・DOM 取得失敗の可能性
- **通知ログ `scopedById`**: `initLogRenderer` の fallback で `scopedById("notification-history")` に hostname 未渡し

#### 3Dプレビュー回転ボタンの per-host 化
- `setFlatView` / `setTilt45View` / `setObliqueView` / `toggleZSpin` / `stopZSpin` / `applyStageTransform` / `setTopView` / `setCameraView` が全ホスト一括操作だった問題を修正
- 各関数に `hostname` パラメータを追加し、対象ホストのみ操作するよう変更
- ボタンイベントバインドをクロージャ化してパネルの hostname をキャプチャ
- `destroyPreviewPanel` でスピンタイマー停止を追加（タイマーリーク防止）

#### JSDoc hostname 必須化（12ファイル）
- `dashboard_spool.js`: `getCurrentSpoolId`, `getCurrentSpool`, `setCurrentSpoolId`
- `dashboard_chart.js`: `initTemperatureGraph`, `resetTemperatureGraph`, `updateTemperatureGraphFromStoredData`, `resetTemperatureGraphView`
- `dashboard_stage_preview.js`: `setPrinterModel`, `restoreXYPreviewState`, `saveXYPreviewState`, `initXYPreview`, `updateXYPreview`, `updateZPreview` + 回転関数8件
- `dashboard_camera_ctrl.js`: `startCameraStream`, `stopCameraStream`
- `dashboard_printstatus.js`: `handlePrintStateTransition`
- `dashboard_data.js`: `getDisplayValue`
- `dashboard_ui.js`: `registerFieldElements`, `unregisterFieldElements`
- `dashboard_printmanager.js`: `setupUploadUI`
- `dashboard_send_command.js`: `initializeRateControls`, `initSendRawJson`, `initSendGcode`, `initTestRawJson`, `initPauseHome`, `initXYUnlock`

#### デッドコード削除
- **`flushNormalLogsToDom` / `flushNotificationLogsToDom` / `writeLogsToContainer`**: 呼び出し元ゼロのデッドコードを削除（`dashboard_log_util.js`）

### 対象ファイル (15ファイル)

| ファイル | 変更内容 |
|----------|----------|
| `dashboard_aggregator.js` | `resolveFilamentJobId` に `prevPrintID` 第3引数追加、3呼び出し元更新 |
| `dashboard_msg_handler.js` | `restoreAggregatorState(initHost)` hostname 渡し |
| `dashboard_printmanager.js` | `getDeviceIp(hostname)` ×2、`scopedById` hostname 渡し、JSDoc 必須化 |
| `dashboard_log_util.js` | `scopedById` hostname 渡し、デッドコード3関数削除 |
| `dashboard_stage_preview.js` | 回転関数8件 per-host 化、`destroyPreviewPanel` スピン停止追加 |
| `dashboard_panel_init.js` | ボタンバインドをクロージャ化 |
| `dashboard_spool.js` | JSDoc hostname 必須化 |
| `dashboard_chart.js` | JSDoc hostname 必須化、`resetTemperatureGraph`/`resetTemperatureGraphView` ガード追加 |
| `dashboard_camera_ctrl.js` | JSDoc hostname 必須化 |
| `dashboard_printstatus.js` | JSDoc hostname 必須化 |
| `dashboard_data.js` | JSDoc hostname 必須化 |
| `dashboard_ui.js` | JSDoc hostname 必須化 |
| `dashboard_send_command.js` | JSDoc hostname 必須化 |

## v2.1.004 (2026-03-12)

### マルチプリンタ データ分離監査・修正

per-host 化（v2.1）後に残存していた暗黙的なグローバルフォールバックを全面監査し、プリンタ間のデータ漏洩・合流を根絶した。

- **スプール装着の per-host 完全化**: `getCurrentSpoolId()` がグローバル `currentSpoolId` にフォールバックしていた問題を修正。`hostSpoolMap` に未登録のホストは `null` を返すよう変更
- **カメラ ON/OFF の per-host 化**: グローバル `cameraToggle` を `hostCameraToggle` (per-host Map) に分離。パネル初期化・カメラ制御・パネルメニュー・ストレージ永続化の全経路を対応
- **印刷ステート遷移履歴の per-host 化**: モジュールレベル `stateHistory` 配列を `_stateHistoryMap` (per-host Map) に移行。異なるプリンタの遷移パターンが混合する問題を解消
- **3Dプレビュー回転状態の per-host 化**: `stageRotX` / `stageRotZ` / `spinTimer` を `PreviewHostState` オブジェクトに移行。ビュー関数が全ホスト状態をイテレーションするよう変更
- **ファイルリストの per-host 化**: `_fileList` シングルトンを `_fileListMap` (per-host Map) に移行
- **温度グラフの hostname ガード追加**: hostname 未指定での `initTemperatureGraph` / `updateTemperatureGraphFromStoredData` 呼び出しを早期 return に変更
- **フィラメントダッシュボードのホストフィルタリング**: `getActiveHosts()` が `getConnectionState() === "connected"` で接続中ホストのみ返すよう修正。ストレージに残存する未接続ホストの表示を防止
- **フィラメント管理/交換モーダルのプレビューオーバーフロー修正**: `.dfv-card` / `.dfv-controls` / `.dfv-scale-wrapper` の CSS 競合を `!important` + `position:relative` で解決

### レガシーコード整理・最小サポートバージョン宣言

- **v1.25/v1.29 レガシーキー移行の廃止**: `wsDestV1p125` / `cameraToggleV1p129` / `autoConnectV1p129` からの直接移行コードを削除
- **最小サポート移行元バージョンを v1.40 に明記**: `STORAGE_KEY` / `restoreUnifiedStorage` / `cleanUpLegacyStorage` のドキュメントを更新
- **`restoreLegacyStoredData` リファクタ**: `storedDataV1p125` からの移行は非公式互換として維持。`PLACEHOLDER_HOSTNAME` ガード追加、型チェック強化、`??=` 採用
- **`cleanUpLegacyStorage` 縮小**: 削除対象を `storedDataV1p125` のみに限定

### デッドコード削除

- **`setStoredData()`**: deprecated 関数を削除（呼び出し元はコメントアウト済みコードのみ）
- **`getCurrentMachine()`**: deprecated 関数を削除（アクティブな呼び出し元ゼロ）
- **`consumeDirtyKeys()`**: deprecated 関数を削除（アクティブな呼び出し元ゼロ）
- **`_bindHostSwitchClicks()`**: NOP 関数と3箇所の呼び出しを削除
- **未使用 import 除去**: `dashboard_aggregator.js` / `dashboard_spool.js` から `setStoredData` import を削除
- **`getDisplayValue` の `getCurrentMachine` フォールバック除去**: hostname 未指定時は `null` を返すよう変更

### 対象ファイル (10ファイル)

| ファイル | 変更内容 |
|----------|----------|
| `dashboard_data.js` | deprecated 関数3件削除、`getDisplayValue` 修正 |
| `dashboard_storage.js` | v125/v129 移行廃止、v140+宣言、リファクタ |
| `dashboard_connection.js` | `_bindHostSwitchClicks` 削除 |
| `dashboard_aggregator.js` | `setStoredData` import 除去、`historyPersistFunc`/`guessExpectedLength`/`autoCorrectCurrentSpool` per-host 化 |
| `dashboard_spool.js` | `setStoredData` import 除去、`getCurrentSpoolId` フォールバック除去 |
| `dashboard_printmanager.js` | `_fileListMap` per-host 化、`useFilament` hostname 引数追加 |
| `dashboard_chart.js` | hostname 未指定ガード追加 |
| `dashboard_stage_preview.js` | 回転状態・スピンタイマー per-host 化 |
| `dashboard_printstatus.js` | `_stateHistoryMap` per-host 化 |
| `dashboard_panel_init.js` / `dashboard_camera_ctrl.js` / `dashboard_panel_menu.js` | `hostCameraToggle` per-host 化 |

## v2.1.003 (2026-03-11)

### 現在の印刷パネル ファイル名取得不具合修正
- WS デバイスは `printFileName` キーでファイル名を送信するが、msg_handler が存在しない `data.fileName` を参照していたため、印刷開始時にファイル名が取得できなかった
- `data.printFileName || data.fileName` に修正（3箇所）し、storedData フォールバックも `printFileName` を優先するよう変更
- 接続直後や新規印刷開始時に「(名称不明)」が表示される問題を根本解消

### 現在の印刷パネル historyList マージ修正
- `updateHistoryList` / `refreshHistory` で、historyList の先頭行（現在の印刷）が既存の current ジョブと同一IDの場合にデータ更新をスキップしていた
- 同一IDでも historyList のより完全なデータ（filename / thumbnail / usagematerial / usagetime 等）をマージして saveCurrent + renderPrintCurrent を実行するよう修正
- 印刷開始直後に機器から送信される historyList の情報が現在の印刷パネルに即座に反映されるようになった

### フィラメント100%復帰修正
- 印刷途中でフィラメント交換後、100%到達時に元のフィラメント情報に戻る問題を修正
- `parseRawHistoryEntry` で `filamentInfo` フィールドが欠落していた問題を修正
- `updateHistoryList` のマージ処理で `FILAMENT_KEYS` 保護を追加（保存済み交換データを常に優先）

### 履歴フィラメント指定・修正ダイアログ
- 印刷履歴の「指定」「✏修正」ボタンを統合フィラメントダイアログに置換
- 過去取り外したスプールからの選択、新品開封からの指定に対応（機器装着なし）
- スプール変更時に旧スプールへの使用量復元・新スプールからの差し引きを自動計算
- 操作後のフィラメントプレビュー即時更新を追加

## v2.1.002 (2026-03-11)

### 受信ログ コンタミネーション修正
- 全モジュールの `pushLog` 呼び出しに hostname パラメータを追加（計44箇所）
- 対象: connection / msg_handler / camera_ctrl / printmanager / data / send_command
- パネルごとのログ表示が正しくホスト単位でフィルタリングされるようになった

### 印刷履歴 成否表示の改善
- 印刷中のジョブに ▶（印刷中）/ ⏸（一時停止中）アイコンを表示（青色）
- 印刷終了後は従来通り ✔（成功）/ ✗（失敗）に切り替わる
- CSS クラス `result-active` を追加、`.col-finish` セレクタ整合性を修正

### 現在の印刷パネル 情報欠落修正
- 印刷開始検出時に `saveCurrent` を即座に呼び出し、ファイル名を storedData から取得
- 印刷中のフィラメント使用量を storedData のリアルタイム値（`usedMaterialLength`）から表示
- 印刷名が「(名称不明)」、使用量が「0 mm」になる問題を解消

### 通知・ログ修正
- 通知バナー生成時のログ二重出力を修正
- テスト再生時のログレベルを info に統一
- 起動時の `persistAggregatorState: ホスト未設定` 警告を修正
- `initTemperatureGraph` の canvas 未検出ログを debug レベルに変更

## v2.1 (2026-03-11)

### マルチプリンタ並行監視
- per-host データインフラ（`_dirtyKeys` Map化、`_fieldCache` 複合キー、`setStoredDataForHost` 5引数拡張）
- aggregator / msg_handler の per-host 化（`_hostStates` / `_msgHostStates` Map）
- コマンドルーティング（`_cmdHostname` でパネル単位ホスト紐付け）
- シングルトン解消（chart / stage_preview / spool / filament preview を per-host Map 化）
- aggregator タイマー: ANY接続で起動、ALL切断で停止
- ストレージ: IndexedDB per-host 書き込み、2秒スロットリング、videos MAX_VIDEOS=500上限

### パネルシステム
- GridStack によるパネル自由配置
- `dashboard_panel_factory.js` / `dashboard_panel_boot.js` / `dashboard_panel_menu.js` 追加
- `3dp_panel.css` パネルシステム用 CSS 追加
- Electron メインプロセス (`electron/main.js` / `electron/preload.js`)

### UI改善
- 通知メッセージで機器名 "unknown" 表示を修正（23箇所の `notify()` に hostname 付与）
- 現在の印刷パネル: 4K大画面でのポートレートモード閾値を緩和
- 温度表示: ラベル右揃え・値右揃え固定幅（flex レイアウト化）
- テーブルヘッダ固定: `border-collapse: separate` + クラスセレクタ移行
- 印刷履歴・ファイル一覧の数値/日付カラム右揃え対応

### フィラメント管理
- フィラメント交換の hostname スレッディング修正（交換→パネル反映が正しいホストに適用）
- フィラメントプレビューの per-host フォールバック除去（最後に初期化したパネルへの誤反映を防止）
- フィラメント管理モーダルのプレビューオーバーフロー修正
- `setCurrentSpoolId` / `deleteSpool` のホスト名引数スレッディング

### エクスポート/インポート
- v2.00 統一エクスポート（JSON 形式、タイムスタンプ付きファイル名）
- v1.40 / v2.00 自動判定インポート（旧形式からの自動変換対応）
- Export/Import ボタンを2つに統合（旧3ボタンから整理）

### カメラ
- カメラレジストリの per-host hostname 追加
- カメラ通知の hostname スレッディング修正

## v2.0-rc
- Step④ CameraCard 分離
- Step⑤ HeadPreviewCard 実装と最終ポリッシュ
- Step⑥ TempGraph 高速化 & SideMenu 追加
