# Changelog

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
