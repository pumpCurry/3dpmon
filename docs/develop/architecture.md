# 3dpmon v2.1 アーキテクチャ仕様書

## 1. システム概要

3dpmon は CREALITY K1 シリーズ 3D プリンタを複数台同時に監視するブラウザベースダッシュボード。
- エントリポイント: `3dp_monitor.html`
- モジュール: `3dp_lib/` 配下の 34 ES モジュール
- 実行環境: ブラウザ (HTTP サーバー経由) または Electron
- 対応機種: K1C / K1 Max (実機確認済み)
- 通信: WebSocket (:9999)、HTTP (:80) - ローカル LAN 前提

## 2. レイヤーアーキテクチャ

```
ユーザーインターフェース層 (HTML + GridStack パネル)
    ↓
パネルシステム層 (panel_factory / panel_boot / panel_menu / panel_init)
    ↓
UI更新・バインディング層 (dashboard_ui.js / dashboard_ui_mapping.js)
    ↓
集約・状態管理層 (dashboard_aggregator.js) — 500ms周期
    ↓
機能モジュール層 (chart / camera / filament / stage_preview / printmanager / notification)
    ↓
データ・ストレージ層 (dashboard_data.js / dashboard_storage.js / dashboard_storage_idb.js)
    ↓
通信層 (dashboard_connection.js / dashboard_msg_handler.js)
    ↓
外部: K1 プリンタ (WS :9999 / HTTP :80)
```

## 3. モジュール一覧

### 3.1 コアデータ
| モジュール | 説明 |
|-----------|------|
| `dashboard_data.js` | `monitorData` を中心とした全アプリケーション状態管理。per-host `machines[hostname]` Map、変更キュー (`_dirtyKeys` per-host Set)、`scopedById()` パネルスコープID解決 |
| `dashboard_storage.js` | monitorData の保存・復元。localStorage/IndexedDB 二重バックエンド、2秒スロットリング、v1.40+移行サポート |
| `dashboard_storage_idb.js` | IndexedDB per-host 分離ストレージ。書き込みキュー、バッチ最適化、localStorageからの自動マイグレーション |

### 3.2 通信
| モジュール | 説明 |
|-----------|------|
| `dashboard_connection.js` | ホストごとに独立した WebSocket 管理。再接続 (exponential backoff)、heartbeat、コマンド送信 (sendCommand/sendGcodeCommand)。connectionMap で全接続を管理 |
| `dashboard_msg_handler.js` | WS受信JSONの解釈。per-host状態管理 (`_msgHostStates` Map)。`handleMessage` → `processData` で storedData に格納 |

### 3.3 UI更新
| モジュール | 説明 |
|-----------|------|
| `dashboard_ui.js` | `data-field` 属性ベースのバインディング。`_fieldCache` (Map, hostname\0field 複合キー) で要素キャッシュ。`updateStoredDataToDOM()` が全ホストの変更キューを巡回 |
| `dashboard_ui_mapping.js` | storedDataキー → DOM要素キー + 変換関数の定義。単位付き文字列変換を一元管理 |

### 3.4 集約
| モジュール | 説明 |
|-----------|------|
| `dashboard_aggregator.js` | 500ms周期で全ホストの DOM更新をトリガー。印刷ワークフロー計算 (終了予測、実印刷開始時刻)。per-host状態 (`_hostStates` Map) |

### 3.5 パネルシステム
| モジュール | 説明 |
|-----------|------|
| `dashboard_panel_factory.js` | GridStack パネルの生成・管理・破棄。HTMLテンプレートからパネル複製、per-host スコープID変換 (`{hostname}__originalId`)、レイアウト永続化 |
| `dashboard_panel_boot.js` | パネルシステム起動処理。既存HTML構造からテンプレート抽出、初回デフォルトレイアウト構築 |
| `dashboard_panel_menu.js` | サイドメニューUI。パネル種別 × 接続中ホストの組み合わせでパネル追加 |
| `dashboard_panel_init.js` | パネル初期化/破棄関数レジストリ。パネルクローン時のイベントリスナー復元、per-host バインディング |

### 3.6 機能モジュール
| モジュール | 説明 |
|-----------|------|
| `dashboard_chart.js` | Chart.js 温度グラフ。per-host インスタンス (`_hostChartData` Map)、Zoom プラグイン、データ間引き |
| `dashboard_stage_preview.js` | XY/Z 3Dプレビュー。per-host 回転状態 (`_previewHostStates` Map)、スピンタイマー |
| `dashboard_camera_ctrl.js` | ホスト別カメラストリーム。Exponential Backoff 再接続 (最大5回)、NO SIGNAL/CONNECTING/RETRYING UI |
| `dashboard_printmanager.js` | 印刷履歴・現在ジョブ管理。per-host ファイルリスト (`_fileListMap` Map)、Template処理 |
| `dashboard_printstatus.js` | 印刷ステート遷移通知。per-host 履歴 (`_stateHistoryMap` Map)、最大4件保持 |
| `dashboard_notification_manager.js` | 通知管理。per-host TTS設定 (`_hostTts` Map)、画面アラート、Web通知 |

### 3.7 フィラメント管理
| モジュール | 説明 |
|-----------|------|
| `dashboard_spool.js` | スプール CRUD、使用量計算、per-host 装着 (`hostSpoolMap`)。密度テーブル、重量⇔長さ変換 |
| `dashboard_filament_manager.js` | フィラメント管理モーダル (ダッシュボード・在庫・プリセット・履歴・集計) |
| `dashboard_filament_change.js` | フィラメント交換モーダル。スプール選択UI、在庫消費 |
| `dashboard_filament_inventory.js` | プリセット単位の在庫数管理 |
| `dashboard_filament_presets.js` | フィラメントプリセット定数定義 |

### 3.8 ユーティリティ
| モジュール | 説明 |
|-----------|------|
| `dashboard_utils.js` | 時間フォーマット、座標解析、フィールド更新チェック |
| `dashboard_log_util.js` | LogManager、自動スクロール、差分描画 |
| `dashboard_constants.js` | 定数定義 |

### 3.9 初期化
| モジュール | 説明 |
|-----------|------|
| `3dp_dashboard_init.js` | アプリケーション起動シーケンス。ストレージ復元、マイグレーション、自動接続、自動保存 |

### 3.10 Electron
| モジュール | 説明 |
|-----------|------|
| `electron/main.js` | Electron メインプロセス。BrowserWindow 生成 |
| `electron/preload.js` | contextBridge 経由の安全な API 公開 (`isElectron`, `getPlatform`) |

## 4. データモデル

### 4.1 monitorData 構造

```javascript
monitorData = {
  appSettings: {
    updateInterval: 500,      // UI更新間隔 (ms)
    autoConnect: true,        // 自動接続
    wsDest: "",               // メイン接続先 (後方互換)
    connectionTargets: [],    // 複数接続先リスト [{dest, color, label, cameraPort, httpPort}]
    showHostTag: true,        // パネルヘッダーにホスト名表示
    cameraToggle: false,      // カメラ ON/OFF (グローバルデフォルト)
    cameraPort: 8080,         // カメラポート (デフォルト)
    httpPort: 80,             // HTTP ポート (デフォルト)
    notificationSettings: {}  // 通知設定
  },
  machines: {
    [hostname]: {
      storedData: { [key]: { rawValue, computedValue, isNew, isFromEquipVal } },
      runtimeData: { lastError: null },
      historyData: [],
      printStore: { current: null, history: [], videos: {} }
    }
  },
  filamentSpools: [],         // 全スプール配列
  filamentPresets: [],        // フィラメントプリセット
  usageHistory: [],           // フィラメント使用履歴 (MAX_USAGE_HISTORY=4500)
  filamentInventory: [],      // 在庫管理
  currentSpoolId: null,       // レガシー互換用 (deprecated)
  hostSpoolMap: {},           // per-host 装着スプール {hostname: spoolId}
  hostCameraToggle: {},       // per-host カメラ ON/OFF {hostname: boolean}
  spoolSerialCounter: 0       // スプール通し番号カウンタ
}
```

### 4.2 storedData エントリ構造

```javascript
{
  rawValue: *,           // 機器から受信した生データ
  computedValue: *,      // UI表示用に変換されたデータ
  isNew: boolean,        // DOM反映待ちフラグ
  isFromEquipVal: boolean // 機器由来データフラグ
}
```

### 4.3 per-host 管理パターン

| レイヤー | データ構造 | キー方式 |
|---------|----------|---------|
| データモデル | `monitorData.machines[hostname]` | hostname 直接キー |
| UI要素キャッシュ | `_fieldCache` Map | `hostname\0field` 複合キー |
| 変更キュー | `_dirtyKeysMap` Map | hostname → Set |
| 集約状態 | `_hostStates` Map | hostname → 状態オブジェクト |
| メッセージ処理状態 | `_msgHostStates` Map | hostname → 状態オブジェクト |
| 温度グラフ | `_hostChartData` Map | hostname → Chart.js データ |
| 3Dプレビュー | `_previewHostStates` Map | hostname → 回転/スピン状態 |
| 印刷ステート遷移 | `_stateHistoryMap` Map | hostname → 履歴配列 |
| ファイルリスト | `_fileListMap` Map | hostname → ファイル配列 |
| TTS設定 | `_hostTts` Map | hostname → 音声設定 |
| スプール装着 | `monitorData.hostSpoolMap` | hostname → spoolId |
| カメラON/OFF | `monitorData.hostCameraToggle` | hostname → boolean |
| DOM要素ID | `{hostname}__originalId` | パネルスコープ |

## 5. 通信プロトコル

### 5.1 WebSocket
- ポート: 9999 (デフォルト)
- データ形式: JSON
- 再接続: exponential backoff (最大60秒)
- Heartbeat: 定期 ping/pong

### 5.2 HTTP
- ポート: 80 (デフォルト)
- 用途: 印刷履歴取得、ファイル操作、サムネイル取得

### 5.3 カメラストリーム
- ポート: 8080 (デフォルト、per-host 設定可)
- 形式: MJPEG ストリーム
- 再接続: exponential backoff (最大5回)

## 6. ストレージ

### 6.1 バックエンド優先順位
1. IndexedDB (推奨、per-host 分離書き込み)
2. localStorage (フォールバック、5MB 制限)

### 6.2 ストレージキー
- 統一キー: `3dp-monitor_1.400` (v1.40 以降)
- IndexedDB: `3dpmon-store` データベース、`shared` + `machines` オブジェクトストア

### 6.3 書き込み最適化
- 2秒スロットリング (SAVE_THROTTLE_MS)
- 同一データスキップ (_lastSavedJson 比較)
- IndexedDB バッチ書き込み (queueSharedWrite/queueMachineWrite)

### 6.4 移行サポート
- 最小サポート移行元: **v1.40** (`3dp-monitor_1.400`)
- v1.25/v1.29 からの移行: **廃止** (v2.1.004)
- `storedDataV1p125`: 非公式互換として restoreLegacyStoredData で読取可能
- `currentSpoolId → hostSpoolMap`: 自動移行 (レガシー互換維持)

## 7. パネルシステム

### 7.1 概要
- GridStack.js によるドラッグ&リサイズ可能なパネル配置
- HTMLテンプレートをクローンしてパネル生成
- ホスト × パネル種別の組み合わせで複数インスタンス

### 7.2 パネル生成フロー
1. `bootPanelSystem()` → HTML構造からテンプレート抽出
2. `addPanel(type, hostname)` → テンプレートクローン → ID変換 (`hostname__id`) → GridStack に追加
3. `initializePanel(panelId)` → `registerPanelInit()` で登録済みの初期化関数実行
4. データバインディング → `data-field` 属性で UI更新層と接続

### 7.3 レイアウト永続化
- `saveLayout()`: GridStack 座標をlocalStorageに保存
- `restoreLayout()`: 保存済みレイアウトを復元
- 初回起動: デフォルトレイアウトを自動構築

## 8. 起動シーケンス

```
1. 3dp_monitor.html ロード
2. 3dp_dashboard_init.js:initializeDashboard()
   2a. initStorage() → IndexedDB 初期化
   2b. restoreUnifiedStorage() → データ復元
   2c. restoreLegacyStoredData() → レガシー移行 (該当する場合)
   2d. bootPanelSystem() → パネルシステム起動
   2e. registerAllPanelInits() → パネル初期化関数登録
   2f. initializeAutoSave() → 30秒自動保存
3. 自動接続 (autoConnect=true の場合)
   3a. connectionTargets を巡回
   3b. connectWs(dest) → WebSocket 接続
   3c. handleMessage() → hostname 取得 → setCurrentHostname()
   3d. ensureHostPanels(hostname) → ホスト用パネル生成
   3e. startHeartbeat() + restartAggregatorTimer()
4. 500ms aggregatorUpdate() ループ開始
   4a. 全ホストの storedData を巡回
   4b. 複合ロジック計算 (終了予測等)
   4c. updateStoredDataToDOM() → DOM反映
```

## 9. ファイル構成

```
3dpmon/
├── 3dp_monitor.html          # エントリポイント (単一HTML)
├── 3dp_panel.css              # パネルシステム CSS
├── 3dp_lib/                   # ESモジュール (34ファイル)
│   ├── 3dp_dashboard_init.js  # 起動シーケンス
│   ├── dashboard_data.js      # データモデル
│   ├── dashboard_connection.js # WS接続管理
│   ├── dashboard_msg_handler.js # メッセージ処理
│   ├── dashboard_aggregator.js # 集約・タイマー
│   ├── dashboard_ui.js        # DOM更新
│   ├── dashboard_ui_mapping.js # フィールドマッピング
│   ├── dashboard_storage.js   # ストレージ管理
│   ├── dashboard_storage_idb.js # IndexedDB
│   ├── dashboard_panel_*.js   # パネルシステム (4ファイル)
│   ├── dashboard_chart.js     # 温度グラフ
│   ├── dashboard_camera_ctrl.js # カメラ制御
│   ├── dashboard_stage_preview.js # 3Dプレビュー
│   ├── dashboard_spool.js     # スプール管理
│   ├── dashboard_filament_*.js # フィラメント管理 (4ファイル)
│   ├── dashboard_printmanager.js # 印刷履歴
│   ├── dashboard_printstatus.js # 印刷状態遷移
│   ├── dashboard_notification_*.js # 通知 (3ファイル)
│   ├── dashboard_log_util.js  # ログ管理
│   ├── dashboard_utils.js     # ユーティリティ
│   └── dashboard_constants.js # 定数
├── electron/                  # Electron プロセス
│   ├── main.js
│   └── preload.js
├── docs/                      # ドキュメント
├── CHANGELOG.md
└── README.md
```

## 10. バージョン管理

- バージョン形式: `1.390.{commit count} (PR #{PR番号})` (各ファイル内)
- アプリバージョン: `v2.1.{patch}` (CHANGELOG/README)
- ファイル名規則: `dashboard_{name}.js` (小文字英数字+アンダースコア)
- JSDoc 必須、日本語コメント必須

---

*本仕様書は v2.1.004 (2026-03-12) 時点のアーキテクチャを反映しています。*
