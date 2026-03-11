# Changelog

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
