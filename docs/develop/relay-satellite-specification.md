# リレー/サテライト仕様書（v2.2.1024）

3dpmon の親機（Electron）と子クライアント（ブラウザ＝サテライト/READONLY）の
データ同期・操作中継の仕様。v2.2.1024 でフィラメント同期と操作中継を全面的に再設計した。

## 1. 役割と接続

| 役割 | 検出方法 | プリンタ接続 | 操作 |
|------|---------|------------|------|
| parent | `window.electronAPI.isElectron()` | WS 直結（唯一の権威） | 全部 |
| satellite | `?relay=satellite`（接続後に自動昇格） | なし（リレー経由） | 親へ RPC 委譲 |
| readonly | `?relay=readonly` または http アクセス既定 | なし | 閲覧のみ |
| standalone | `file://` | WS 直結 | 全部 |

- 検出は `dashboard_client_sync.js detectRelayMode()`。子は `window._3dpmonRelayChild = true`。
- 子は `ws://<親>:5313/?mode=<mode>` でリレーサーバ（`electron/relay_server.js`）へ接続。

### 1.1 初回接続は常に readonly（v2.2.1024 変更）

旧実装は `?mode=satellite` を付けるだけで **PIN 検証なし** に操作権限が付与されていた。
v2.2.1024 からサーバは初回接続を常に readonly で受け付け、操作権限は
`relay-promote-request` → 親の PIN 検証（`verifyPromotePin`）経由でのみ付与される。

- URL が `?relay=satellite` の場合、子は `relay-init` 受信後に**自動で昇格要求**を送る。
  - 親に PIN 未設定 → 即昇格（従来とほぼ同じ UX）。
  - PIN 設定済み → PIN 入力ダイアログが開く。
- 切断→再接続時、昇格済みだった子は自動で再昇格を要求する（PIN 設定時は再入力）。
- 明示的に降格（👁 ボタン）した場合は再接続でも自動昇格しない。

## 2. データ同期（親 → 子）

### 2.1 配信内容

| データ | 経路 | 規則 |
|--------|------|------|
| per-host storedData（rawValue） | snapshot + delta（変化キーのみ） | 子はそのまま格納 |
| printStore（履歴・現在ジョブ） | snapshot + delta（ハッシュ変更時） | **全置換** |
| ファイル一覧（_cachedFileInfo） | snapshot + delta | 全置換 |
| filamentSpools / hostSpoolMap | snapshot + delta（ハッシュ変更時） | **全置換**（v2.2.1024 変更） |
| mountHistory（ADR-0004 台帳） | snapshot + delta（独自ハッシュ） | **全置換**（v2.2.1024 追加） |
| カメラ/画像 | `/relay-image/<host>` プロキシ | パススルー |

### 2.2 フィラメント同期の原則（v2.2.1024 再設計）

**親が唯一の権威。子はフィラメント状態を一切ローカル変更しない。**

- 旧実装の問題（親子の表示乖離の根本原因）:
  1. 子も aggregator のフィラメント消費計算を実行し、`spool.remainingLengthMm` を
     毎 tick ローカル上書き（親の配信値が 500ms 以内に破壊される）。
  2. 子のマージが「ID ベース + sticky フラグ保護（`prevActive || ...`）」だったため、
     親での取り外し・交換・削除が子に**永遠に反映されない**。
  3. `mountHistory` が配信されず、子の台帳由来表示が再構成不能。
- 現仕様:
  - 子の aggregator はフィラメント関連ブロックを**全てスキップ**
    （`dashboard_aggregator.js` の `_isRelayChild()` ガード。消費積算・
    reserve/finalize・runout 文脈記録・autoCorrect・交換ダイアログ自動表示・
    スプール由来の復元情報保存が対象。タイマー・通知は従来どおり子でも動作）。
  - 子の受信マージは `_applySharedFilamentState()` による**全置換**
    （配列/オブジェクト参照は維持。欠落フィールドは変更しない。空配列は正当）。
  - 受信適用後にフィラメントプレビューへ反映（`_refreshFilamentPreviews()`）。

## 3. 操作中継（子 → 親）

### 3.1 プリンタコマンド（relay-command）

`sendCommand()` / `sendGcodeCommand()` は子では親へ転送される
（`sendGcodeCommand` の転送は v2.2.1024 で追加。旧実装はサイレント失敗していた）。
親は `relay-command` を受信して対象ホストの WS へ送信する。

### 3.2 フィラメント操作（relay-filament RPC、v2.2.1024 全面実装）

子では `dashboard_spool.js` の変更系 API がガードされ、ローカル変更せずに
親へ RPC 委譲する。親側ハンドラは `dashboard_relay_bridge.js handleRelayFilamentAction()`
（switch がホワイトリストを兼ねる）。結果は relay-delta の全置換で還流する。

| action | 親側実処理 | 子の戻り値 |
|--------|-----------|-----------|
| `mount` / `unmount` | `setCurrentSpoolId(id\|null, host)` | true（送信成功時） |
| `addSpoolFromPreset` | `addSpoolFromPreset(preset, override)` | null |
| `mountNewSpoolFromPreset` | 開封+装着の複合操作（原子的） | `{ok, spool:null, relayed:true}` |
| `updateSpool` | `updateSpool(id, patch)` | undefined |
| `deleteSpool` / `restoreSpool` | 同名関数 | undefined |
| `confirmInferredSpool` / `revertInferredSpool` | 同名関数（ADR-0005 P6） | null |

設計理由: `serialNo` 採番（`++spoolSerialCounter`）とプリセット在庫消費は
**不可逆なローカル資源**であり、子で実行すると親と分岐して台帳が壊れる。
従って生成系は必ず親で実行し、子は ID を事前に知る必要がない形（複合 RPC）にする。

- 子はローカルの同期済みデータで「他ホスト装着済み」検査のみ先に行い、即時フィードバックする。
- readonly モード・リレー未接続時はトーストでユーザーへ通知する（旧実装はサイレント失敗）。

### 3.3 子で未対応（親機でのみ操作可能）

- 印刷履歴のフィラメント修正/指定（`spool-edit` / `spool-assign`）: 複合操作の RPC が
  未実装のため、子では明示ブロック＋トースト表示（「親機でのみ操作できます」）。
  ローカルだけ書き換わる「見かけ操作」を防ぐための意図的な制限。

## 4. 電源投入直後の ID:0/null 対策（v2.2.1024、リレーと独立）

K1 系は電源投入直後に `printStartTime` を 0/null で報告することがあり、
旧実装は id=0（epoch 0 = 1970 年）のゴースト履歴を生成して履歴比較・サムネイル・
完了記録を壊していた。`normalizeJobId()`（`dashboard_utils.js`）で正規化し、

- `processData` の currStartTime は 無効ID → 保存済み現在ジョブID → 0（センチネル）の順。
- 進捗100%の履歴登録は 無効ID → 保存済み現在ジョブID → aggregator 現在ID の順に解決し、
  いずれも無効なら**登録スキップ**（機器の historyList が信頼ソース）。
- `parseRawHistoryList` / `loadHistory` / `saveHistory` が無効IDエントリを除去
  （過去に保存されたゴーストも読み出し時に消える）。

## 5. テスト

| ファイル | 対象 |
|---------|------|
| `tests/unit/dashboard_msg_handler_poweron_id.test.js` | 電源投入 ID:0/null behavioral |
| `tests/unit/dashboard_client_sync_filament_sync.test.js` | 全置換マージ（取り外し/削除/台帳の伝搬） |
| `tests/unit/dashboard_spool_relay_guard.test.js` | 子のスプール操作 RPC 委譲ガード |
| `tests/unit/dashboard_relay_bridge_filament_ops.test.js` | 親側 RPC ディスパッチ |
| `tests/unit/dashboard_aggregator_relay_guard.test.js` | 子 aggregator のフィラメント処理スキップ |

## 6. 既知の制限 / 今後

- 子→親 RPC に ACK/エラー応答がない（失敗は親ログのみ。表示は delta 還流で整合）。
- 履歴フィラメント修正の RPC 化（3.3）。
- 子の filamentLow / tempOutOfRange 通知は無効（消費計算を親へ集約したため。
  必要なら受信値ベースの通知を別途実装する）。
- `filamentEventContext`（runout 文脈）は親専用であり配信しない。
