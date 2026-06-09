# Changelog

## v2.2.1021 (2026-06-09)

### 外部連携UI + ItemKeeper 連携（印刷履歴プッシュ）+ 汎用Webhook独立化

#### 新機能
- 接続設定モーダルに「🔌 外部連携」ボタン＋サブモーダルを新設（保存して戻る／変更を破棄してキャンセルのトランザクション編集）。
- **ItemKeeper (ik2) 連携（第一弾MVP）**: 印刷開始・完了/失敗時に印刷履歴の全件スナップショットを Bearer 認証＋gzip で POST。`filaments[]` は ADR-0004/0005 台帳から per-spool 消費量(mm)を組立。連携テスト送信・機器別エイリアス/ON-OFF・履歴範囲(all/recent:n)に対応。仕様: `docs/develop/itemkeeper-integration-specification.md`。
- **汎用 Webhook Push の独立化**: 既存の通知 Webhook を外部連携に表示し、通知（画面/TTS）が OFF でも送信できる独立フラグ `webhookIndependent` を新設（既定 OFF＝完全後方互換）。

#### テスト
- 新規ユニットテスト3本（34件）、全435テスト緑、lint 0 error。実機 Electron でモーダル描画・開閉を検証。

> ※ 第二段（IndexedDB 恒久アウトボックス＋指数バックオフ再送、AES-256-GCM 暗号化）は未実装。

---

## v2.2.1020 (2026-06-08)

### 効率モード/最小化/非フォアでの通知遅延・画面更新停止を解消

- **根本原因**: 画面更新(500ms)・通知・heartbeat(30s)がレンダラのタイマー駆動である一方、背景スロットリング未無効化のため Chromium が背景ウィンドウのタイマーを 1秒→1分まで絞り描画を停止。さらに Windows 11 の効率モード(EcoQoS)が適用されていた。
- **対策（3層 / electron/main.js）**: `backgroundThrottling: false`／Chromium スイッチ3種（`disable-background-timer-throttling`・`disable-renderer-backgrounding`・`disable-backgrounding-occluded-windows`）／`powerSaveBlocker("prevent-app-suspension")`。
- 最小化・非フォア・効率モードでも通知が定時発火し、復帰時に画面が即最新化。PR #368(bg-cpu) とは独立した別問題への対処。

---

## v2.2.1019 (2026-06-08)

### 同一機器へのカメラ(MJPEG)多重接続を防止

- ホスト名変更や IP 再利用で内部キーが二重化した際、同一カメラ(ip:port)へ複数 MJPEG 接続が張られる問題を修正（#369）。カメラ開始時に同一 ip:port の旧ストリームを停止し **1機器=1接続** に収束（別機器には不干渉）。
- 一連の修正（#1 WS多重接続 / #2 受信ログ抑制 / #4 カメラ多重接続）で「同一実機への複数動画接続」「背景CPU高騰」の主要因を解消。

---

## v2.2.1018 (2026-06-08)

### 受信生データのログを既定抑制（バックグラウンドCPU/ログ汚染の軽減）

- WS 受信のたびに全パケットを「受信:」出力していたのを、`logLevel="debug"` のときのみ出力に変更（#368）。エラー/状態変化/印刷開始などの意味あるログは従来どおり記録。
- 実測（5機・camera OFF・最小化, #1適用済）: ログ蓄積 1000→**59**、最小化CPU 2.7–4.8%→**0.3%**、フォア 7.9%→**5.5%**。

---

## v2.2.1017 (2026-06-08)

### 同一機器へのWebSocket多重接続を修正

- 再接続のたびに旧 WebSocket を close せず重複し、各 `onmessage` が多重発火して CPU を多重計上・ソケットがリークしていた問題を修正（#367）。`connectWs` が新規接続前に同一機器(`dest`)の生ソケットを確実に close。
- 検証: 1接続+8再接続後の ESTABLISHED WS が **10本超→1本**。ユニットテスト 396＋新規2件 pass。

---

## v2.2.1016 (2026-06-07〜08)

### フィラメント切れ/交換の状態認識つき帰属（ADR-0005・全2弾）

ADR-0005 を2弾で実装（v2.2.1015 第1弾＋本リリースの第2弾を統合）。印刷途中のスプール交換・フィラメント切れの帰属と残量計算を根本改善。

#### 第1弾（状態認識つき帰属＋B1修正）
- **B1（実害）**: 印刷途中の交換後に残量が 0 へ張り付く不具合を修正。
- 状態で分岐: 稼働中の交換＝ジョブ全体を新スプールへ／一時停止中＝分割（旧→切れ点・新→再開後）。mountHistory 台帳(ADR-0004)の冪等再計算を維持。

#### 第2弾（交換ウインドウUX＋切れ推定）
- 交換ダイアログの自動クローズ／キャンセル＝同一継続／放置60sで自動整理。
- 一時停止中の使い切り（センサーON＋残<10%＋一時停止の3条件一致）検知で同プリセット新品を「推定(`inferred`)」スプールとして自動投入。シリアル/在庫を消費しない・UIに「推定」バッジ＋確認/訂正/取消・**完全可逆**・誤発火対策つき。

---

## v2.2.1015 (2026-06-07)

### ADR-0005 第1弾（v2.2.1016 に統合・単独リリースなし）

状態認識つきフィラメント帰属の基盤と B1（途中交換で残量0張り付き）修正。詳細は v2.2.1016 を参照。

---

## v2.2.1014 (2026-06-05〜06)

### サテライト（リレー子）の画像/カメラ パススルー + 更新2回/秒

- **画像パススルー**: 親に `/relay-image/{host}/{path}` プロキシ追加（許可ホスト限定・`..`拒否・Cache-Control）。子のサムネ/アイコンが表示されるように。
- **カメラパススルー**: 親に `/relay-camera/{host}/snapshot.jpg` プロキシ（~1.2sキャッシュ・SSRF防止）。子は MJPEG 直結をやめ ~0.4FPS ポーリングで軽量化。
- 親→子ブロードキャストを 1000ms→**500ms（2回/秒）** に。

---

## v2.2.1013 (2026-06-05)

### フィラメント残量の二重減算を根本修正（ADR-0004: mountHistory台帳＋冪等再計算）

実機データで確定した「同一ジョブが最大6回計上され残量が容量の2倍超まで減る」二重減算を構造的に解消。

- 新モジュール `dashboard_filament_ledger.js`: 残量を「装着区間アンカー − Σ(プリンタ報告の信頼消費)」で**冪等に再計算**。累積減算を権威経路から排除。
- 破損した過去を再計算せず現在値にアンカー。多重 finalize ガード・`usedLengthLog` 重複防止・印刷開始直後の急減修正。
- オフライン/再接続でもプリンタ履歴から冪等復元（限界 F1/F2 は検出して未検証表示）。設計: `docs/ADR/0004-filament-mounthistory.md`。
- **v2.2.1012 を同梱**: 全体パネル統計修正、サテライト履歴/ファイル一覧同期、2列「逆順」レイアウト、CSS変数。

---

## v2.2.1012 (2026-06-04)

### 全体パネル統計・サテライト同期・逆順レイアウト（v2.2.1013 に統合・単独リリースなし）

生産管理/機器ランキングを `printStore.history` から正しく集計、サテライト/ビューオンリーでの印刷履歴・ファイル一覧の同期、パネル2列逆順レイアウト、CSS変数定義。

---

## v2.2.1011 (2026-06-03)

### リレー操作モード昇格UI + 使用量m/mmトグル + オフラインフィラメント継続

- **操作モード昇格/降格**: :5313 ブラウザ接続(readonly)から操作モードへ昇格するトグルを新設（子のみ表示）。親で PIN 設定時は親側で検証。接続設定に「操作昇格PIN」欄（親のみ）。
- **使用量 m/mm トグル＋2段表示**: 印刷履歴・ファイル一覧に単位トグル・再読み込みを追加。使用量を距離と(g, ¥)の2段右寄せ表示。即時保存・全パネル即反映。
- オフライン完了印刷のフィラメント継続紐付け、残量小数1桁表示。

---

## v2.2.1010 (2026-06-01)

### 印刷中の複数表示バグ + 履歴消去（優先1ホスト）バグ修正

- **Bug A**: 印刷結果一覧で複数行が「印刷中(▶)」表示される問題。判定を純関数 `resolveHistoryFinishStatus` に切り出し、「印刷中」は現在の印刷ID一致かつ稼働中のみに限定。
- **Bug B**: `_writePerHostLocalStorage` が machines に無いホストキーを無条件削除し、一時的に外れた機器（IP変化/mDNS障害等）の履歴を消去していた問題。「空シェルのみ削除」に限定し、データを持つ孤児キーは自動削除しない。

---

## v2.2.1009 (2026-06-01)

### 「優先1ホスト」アンチパターンの排除（全機器平等化）

- **BUG-1（高）**: D&D/進捗バーが最初に初期化されたパネルに固定。進捗UIを per-host レジストリ化、D&D を host 非依存ハンドラへ。
- **BUG-2（高）**: 送信先を全解除すると最初のホストへフォールバック → 「送信先未選択」エラーで正しく停止。
- **BUG-3（中）**: レガシーセレクトが毎回 hosts[0] にリセット → 選択保持に修正。

---

## v2.2.1008 (2026-06-01)

### gcode平均時間のマルチホスト登録バグ修正

- gcode の印刷予定秒数(平均時間)が1番目の機器にしか登録されない問題（ファイル本体は全機器へ正しく展開されていた）。キャッシュ書き込みを「アップロード先 targets 確定後に全ホストへ」方式へ変更し、純関数 `registerGcodeMetaForHosts` を新設。全経路で全機器に登録。回帰テスト8件追加。

---

## v2.2.1007 (2026-05-22)

### インポート/エクスポート機能の致命的バグ修正

- **Bug 1（高）**: エクスポート時にファイルが空・破損になる問題。`revokeObjectURL` を `click()` 直後に同期実行していたため。appendChild→click→removeChild ＋ revoke を60秒遅延に変更。
- **Bug 2（高）**: 正常インポートが「不正なJSON」と誤表示される問題。成功 toast で未定義変数 `version` を参照し ReferenceError。`version` に退避して解消。

---

## v2.2.1006 (2026-05-19)

### タイトルバー表示バグ修正

- 開発起動時(`electron .`)にタイトルが「v33.4.11」(Electron版)になる問題。`app.getVersion()` ではなく `package.json` から `APP_VERSION` を読むよう修正。ウィンドウタイトル/About/IPC/HTTP API に反映。

---

## v2.2.1005 (2026-05-19)

### NSIS インストーラ + About ダイアログ + アプリアイコン

- **NSIS インストーラ** `3dpmon-2.2.1005-setup.exe`（インストール先選択・ショートカット自動作成・per-user・日本語UI・アンインストール時データ削除確認）。ポータブル版も継続。
- 3Dプリンタ+心電図波形のアプリアイコンをインストーラ/タスクバー/ウィンドウ/ファビコンに統一。
- メニュー＋About ダイアログ、統一バージョン管理(`scripts/sync-version.js`)。

---

## v2.2.004 (2026-05-19)

### カメラ接続CPU100%スタック問題の根本修正

- MJPEG ストリームで `img.src` 設定後、サーバが TCP 接続を受けるがデータを返さない場合に `onload`/`onerror` が発火せず CPU 100% で固まる問題。
- **Watchdog タイマー**: 10秒以内に応答が無ければ強制中断→リトライ。**Generation ベース stale 検出**で二重タイマー/stale コールバックを排除。

---

## v2.2.003 (2026-04-18)

### 印刷中UI改善 + 旧データ構造サポート終了

- 印刷開始直後の ✗ 表示を解消（`printfinish=0` は印刷中▶）。印刷中の行を薄い黄色背景で強調。`endtime` あり+printfinish≠1→失敗(✗)。確認ダイアログの警告文を改善。
- 旧データ構造（v1.x/v2.0）サポート完全終了、レガシーコード266行削除。旧版からは [v2.1.017 LTS](https://github.com/pumpCurry/3dpmon/releases/tag/v2.1.017-LTS) 経由でアップグレード。

---

## v2.2.001 (2026-04-14)

### 旧データ構造サポート完全終了 + E2Eテスト導入

#### Breaking Change
- v1.x / v2.0 旧フォーマットのインポートはサポート終了。旧バージョンからのアップグレードは [v2.1.017 LTS](https://github.com/pumpCurry/3dpmon/releases/tag/v2.1.017-LTS) 経由で行うこと。

#### レガシーコード削除 (266行)
- `STORAGE_KEY ("3dp-monitor_1.400")` と全フォールバック読み取り
- `_convertV140toV200()` / `_detectExportVersion()` — v1.40→v2.00 変換
- `cleanUpLegacyStorage()` / `cleanupLegacy()` / `restoreLegacyStoredData()`
- レイアウト v2→v3→v5 マイグレーション IIFE
- `wsDest` → `connectionTargets` マイグレーション
- `currentHostname` / `setCurrentHostname()` / `notificationSuppressed`
- `setupConnectButton()` / `handleMessage()` 旧エントリポイント
- `LS_KEY` localStorage→IndexedDB マイグレーション

#### テスト強化
- Electron 起動テスト (`tests/e2e/electron_boot.test.mjs`) — 3件
  - 起動しウィンドウが表示されること、モジュール import が全解決、削除済み export の残存検出
- 実機スモークテスト (`tests/e2e/electron_smoke.test.mjs`) — 18件+2SKIP
  - 2台(192.168.54.151/152)への TCP/WS/カメラ接続、hostname 解決、非コンタミネーション検証
- レガシー駆除テスト (`tests/smoke/legacy_purge.test.js`) — 36件
  - hostname ガード全パターン、hostSpoolMap 参照整合性、IP→hostname 遷移保護、
    DHCP統合、costPerMm 算出、旧コード削除確認
- 合計 257 件ユニットテスト + E2E テスト通過

#### v2.2.0 起動不能バグ修正
- `dashboard_connection.js` の `handleMessage` import 残存を除去
  (v2.2.0 で export を削除したが import が残っていた)

#### エクスポートバージョン
- `_exportVersion` を `"2.20"` に更新

---

## v2.1.017 LTS (2026-04-12)

### レガシー単一機器コード完全駆除 + コスト分析エンジン + DHCP対策

**★ このバージョンは LTS（長期サポート）リリースです。**
v2.1.018 以降で単一機器時代のデータ構造サポート（v1.x/v2.0 旧フォーマット、storedDataV1p125、wsDestV1p125 等）を終了します。旧バージョンからのアップグレードは v2.1.017 経由で行ってください。

#### レガシーコード完全駆除 (v2.1.014)
- `currentHostname` を OBSOLETE 化（`const null` に固定、全 import/使用箇所を除去）
- `currentSpoolId` を monitorData から削除（`hostSpoolMap` が唯一の権威）
- `wsDest` の全フォールバック読み取りを除去（起動時の connectionTargets 移行のみ残存）
- `setCurrentSpoolId` の全スプール走査レガシーパスを完全削除
- `restoreLegacyStoredData` / `cleanupLegacy` を廃止
- hostname ガード追加（空/undefined/PLACEHOLDER で呼ばれたら即拒否 + 通知）
- `hostSpoolMap` 書き込み前のスプール存在チェック、`validateHostSpoolMap()` 新設
- `client_sync.js` の filamentSpools 全置換をIDベースマージに変更
- `filemanager.js` の hostname='default' フォールバックを throw に変更

#### コスト分析エンジン (v2.1.015)
- `costPerMm`（円/mm）をスプールに自動算出（addSpool/updateSpool）
- `finalizeFilamentUsage` でジョブに `materialCostYen` を記録
- `buildJobCostReport()`: ファイル名ごとの印刷物単価（成功率・失敗ロス・真の単価）
- `buildHostRanking()`: 機器ランキング（稼働率×成功率でソート）
- `buildMaterialReport()`: 素材別消費レポート（月別推移付き）
- 統計パネル UI 3種（印刷物コスト / 機器ランキング / 素材消費レポート）
- フィラメントマネージャー「＋ 他メーカーのフィラメントを追加」ボタン
- `buildHostUtilization` / `buildDailyProductionReport` のフィラメント集計バグ修正
- 成功判定を `printfinish=1` 優先に統一

#### DHCP/IP遷移対策 (v2.1.016)
- `_setConnectionTargetHostname`: DHCP統合（同hostname旧IPエントリを自動検出・統合）
- `updateConnectionHost`: IP→ホスト名遷移時に hostSpoolMap / spool.hostname / pd_キー を同時移行
- `filamentChangeDialogOpen` → per-host Set（他ホストをブロックしない）
- `gcode_meta_cache` → per-host キー（同名ファイルのメタデータ混在防止）
- `panelLayout` の `validHosts` に IP:PORT ではなく IP のみ追加

#### 残レガシー対処 (v2.1.017)
- `usageHistory` に `hostname` フィールド追加（per-host フィラメント消費分析対応）
- `removalReminderSent` の保存/復元修正（リロード後の再発火防止）
- 古い localStorage キーの一括掃除（v1.25/v1.29/v1.40/layout v2-v4）
- ポート番号 `:9999` `:8080` のハードコード除去 → `DEFAULT_WS_PORT` / `DEFAULT_CAMERA_PORT` に定数化
- `notificationSuppressed` グローバル let → const 廃止
- `temporaryBuffer` 死んだ配列を削除
- インポート時のパネル配置復元修正（localStorage + appSettings 両方に即時書き込み）

---

## v2.1.012 (2026-04-09)

### per-host 接続/切断トグル + レビュー修正 + レガシーUI保護

#### per-host 接続/切断トグル
- 接続設定モーダル内に ▶(接続) / ■(切断) ボタンを追加
- 接続中・接続試行中のホストを個別に切断可能（設定は保持）
- CONNECTING 状態の WebSocket も close 対象に追加（占有防止）
- userDisc フラグで自動再接続を抑制
- 旧シングルホスト時代の接続/切断ボタンを無効化、docs/LEGACY_UI.md 作成

---

## v2.1.011 (2026-04-09)

### レビュー指摘修正

#### データ整合性強化
- autoCorrect fallback: ライブ追跡済みジョブを `trackedJobIds` で除外（二重減算防止）
- autoCorrect: currentPrintID クリア直後の同 tick 実行を `_lastAutoCorrect` で抑制（printCount ずれ防止）

#### 性能改善
- relay delta 適用時の `markAllKeysDirty` を廃止（`setStoredDataForHost` の自動 dirty 化のみに変更、毎秒の全キー DOM 再評価を解消）

#### 堅牢性向上
- TTS 遅延キュー `_pendingUtterances` にサイズ上限10件を追加（voiceschanged 未発火環境での無限メモリ増加を防止）
- completionTimer の dead code を撤去（dual-writer 再発トラップ除去）

#### 接続/切断トグルボタン復活
- `setupConnectButton()` を初期化時に呼出（未接続だったイベントリスナーを活性化）
- disconnect ボタンにイベントリスナー追加（全接続ホストを切断）
- 切断後にアプリ再起動なしで再接続が可能に

---

## v2.1.010 (2026-04-08)

### フィラメントデータ整合性の根本再設計 + 4バグ修正

#### フィラメント遡及補正 (autoCorrectCurrentSpool)
- アプリOFF中の印刷消費を `printStore.history` から遡及反映
- epoch ID ベースの範囲判定（startPrintID〜endPrintID）で装着中の印刷のみ対象
- `usageHistory` に startLength エントリがない場合の updatedAt フォールバック追加
- 他スプールの startLength エントリで早期 return していたバグを修正
- `trimUsageHistory` で各スプールの最新 startLength エントリを保護（FIFO 削除から除外）

#### currentPrintID 残留問題
- アプリOFF中に印刷完了しても currentPrintID がクリアされない問題を修正
- aggregator: state=printDone/printFailed 時に currentPrintID をクリア
- resolveFilamentJobId は isPrinting 時のみ実行（クリア済み stale ID の書き戻し防止）

#### スプール未装着時のゴースト表示修正
- スプール取外し時に `storedData.filamentRemainingMm` を null クリア
- パネル初期化時、スプール未装着なら storedData にフォールバックしない
- `_syncFilamentPreview` の未装着時 filamentCurrentLength を 0 に修正
- `materialStatus`（機器フィラメントセンサー）より hostSpoolMap（アプリ管理状態）を優先
  - hostSpoolMap なし → 「スプール未装着」表示（センサー値に関わらず）

#### Bug #4: 印刷中ステータスアイコン ✗ + 偽失敗統計
- `printfinish = 0` → `null` に修正（0 は else 条件で ✗ 表示になるバグ）
- `buildFileInsight` で `printfinish == null`（進行中/不明）を統計対象外に
- 印刷回数 = 成功 + 失敗のみ（進行中ジョブを除外）

#### Bug #1: completionElapsedTime 振動
- msg_handler の completionTimer setInterval を完全撤去（2 writer 問題の解消）
- aggregator セクション 4-4 に一本化
- 取り出し忘れリマインダー（30分通知）を aggregator に移設

#### Bug #3: Relay propagation gap
- `_applyDelta()` 後に `markAllKeysDirty()` を呼出
- 親のリアルタイム変更が子クライアントの画面に反映されるように

#### Bug #2: TTS 起動時発声失敗
- `_speakText()` メソッドに抽出
- `speechSynthesis.getVoices()` が空（起動直後）の場合は遅延キューに保留
- `voiceschanged` イベントで再試行

#### バージョン自動反映
- タイトルバーに `package.json` のバージョンを自動表示
- Electron IPC (`get-app-version`) + preload API 追加

---

## v2.1.008 (2026-03-28)

### UI統合・品質改善・バグ修正（40+件）

#### アップロードダイアログ統合
- ボタンUP/D&D/重複有無の全パスを単一 `prepareAndConfirm` → `_showUploadConfirmDialog` に統合
- 印刷確認ダイアログと同じ `.pm-print-*` ビジュアル構造に統一
- 送信先セクション: 1台時は読取専用表示、複数台時はチェックボックス付き
- 全チェック外しでUP → 「送信先未選択」警告でブロック（以前は意図しないフォールバック）
- 0台接続時 → エラーダイアログ表示（以前はボタン表示のまま送信先なし）
- per-host 重複表示: 該当ホスト名を明示（以前は全体で1件扱い）
- GCode情報: 履歴のみのファイルでも `filamentInfo` からフォールバック表示

#### 印刷確認ダイアログ — 推定値精度修正
- `materialNeeded` の優先カスケード: 成功実績平均 > GCode見積 > 機器報告値
  - 以前: `raw.usagematerial`（失敗時0mm）をそのまま使用 → 不足警告が出ない
- ソースラベル表示: 「必要量: 168m (実績ベース)」
- 失敗印刷の平均値汚染修正:
  - `buildFileInsight`: 成功印刷のみで `avgDurationSec` / `avgMaterialMm` を算出
  - `buildHistoryStats`: ファイル一覧の `usagetime` に失敗データを含めない
  - `buildDailyProductionReport`: 成功印刷のみ `totalPrintTimeSec` に計上
  - `buildEstimateVsActual`: 成功印刷のみで平均算出

#### レイアウトシステム
- テンプレート: 1台フル幅(48列) / 2台横並び(24列×2) / 4台グリッド(24列×2行)
- パネルメニューにテンプレートボタン追加
- レイアウトリセット → テンプレート適用に変更（以前は全パネル消失）
- パネルレイアウトのエクスポート/インポート機能
- レイアウトのみインポート（データは保持）

#### FOUC防止 + スプラッシュ画面
- `.legacy-card-source` マーカークラス方式: boot時に旧カードに付与 → CSS非表示
- `cloneNode(true)` 後にマーカー除去（テンプレートへの伝搬防止）
- ローディングスプラッシュ: 「3dpmon」ロゴ + スピナー + フェードアウト

#### Electron
- 音声自動再生バイパス: `--autoplay-policy=no-user-gesture-required` フラグ
- .bat ファイル: CP932/CRLF エンコーディング + `.gitattributes binary` 属性

#### completionElapsedTime レースコンディション修正
- `_hasValidDeviceState` ガード: 接続前（device=undefined）は復元値を維持
- `doneStates` スコープ修正: if ブロック外に移動

#### per-host データ整合性
- パネル追加/復元/テンプレート適用後に `markAllKeysDirty(hostname)` を呼び出し
  - 2台目以降のフィラメント表示が更新されない問題を修正
- hostnameフォールバック排除: `selEl?.value || hosts[0]` → 明示的nullチェック+警告
  - 操作対象不明時はブロック（以前はデフォルトホストにフォールバック）
- 通知ログ・アラートの hostname 伝播修正

#### トップバー
- 音声トグルボタン復活（🔊/🔇 + TTS 👤）
- フォントサイズスライダー: `appSettings.topbarFontSize` に保存・復元
- パネルメニューのセクション順序整理（テンプレート・全体パネルを上位に配置）
- z-index: パネルメニューがトップバーの下に表示されるよう調整

#### その他修正
- フィラメント履歴消失バグ: リジューム時の二重消費防止
- 温度グラフ: マウス操作ロック機能（初期値ロック、ピンとは異なるアイコン）
- 4台テンプレートで幽霊2台目が表示される問題: IP→ホスト名遷移のフィルタリング
- `shared` ホストがパネルメニューに表示される問題: `perHost:false` パネルのフィルタ

---

## v2.1.007 (2026-03-25)

### フィラメント管理拡張（Phase 5: A+B+C）

#### Phase A: Per-Host ストレージ分離
- localStorage 単一キー（~3.6MB/2台）→ per-host 分割キー形式に移行
  - `3dpmon-global` + `3dpmon-host-{encoded-hostname}` の分割書き込み
  - 自動マイグレーション: 旧統一キー検出 → 分割 → 旧キー削除
  - 孤児ホストキーの自動クリーンアップ
- IndexedDB SHARED_KEYS に `userPresets`, `hiddenPresets`, `hostSpoolMap`, `hostCameraToggle` の4キーを追加（データロス防止）

#### Phase B: 色別印刷集計
- Tab 4 集計レポートに「色別内訳」セクション追加
  - 色見本 + 色名 / 印刷回数 / 消費量 / 比率 / コスト のテーブル
  - Chart.js ドーナツチャート（フィラメントの実際の色を使用）

#### Phase C: 残フィラメント活用提案
- 新関数 `buildFilamentRecommendations()`: 残量で印刷可能なファイルをスコアリング
  - 素材一致(+100) + フィット率(+50) + 頻度(+10) の3軸評価
  - 循環参照回避のための accessor パターン（boot時に登録）
- 印刷ダイアログ統合: 残量不足時に「💡 この残量で印刷できるファイル」を提案
- `buildFileInsight`, `getFileList` を export 化

#### テスト
- 新規14件追加（storage 8 + recommendation 6）、合計151件全グリーン

---

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
