# 3dpmon ItemKeeper 連携仕様書（印刷履歴プッシュ）— Phase 1 実装仕様

3dpmon が保持する**印刷履歴**を、**印刷開始・完了（失敗）時**に **ItemKeeper (ik2) の受け口へ認証付き HTTP POST** する、
**ItemKeeper 専用連携**の実装仕様（3dpmon 側 = 送信側の実装対象）。

汎用通知 Webhook（[webhook-specification.md](webhook-specification.md)）とは**別チャネル**として新規実装する。
通知 Webhook が「外部サービスへの通知文配信（無認証・再送なし・単発イベント）」であるのに対し、本連携は
**製造実績の取り込み**が目的で、次を備える:

- **認証**: ItemKeeper が払い出した **ID（client_id）+ 鍵（secret）** を用い、**特定 URI へ特定の方法で送ったときのみ**受理・解析される。
- **全件スナップショット**: 各トリガで、保持している印刷履歴を **機器ごとにまとめた配列**で送る（取りこぼしゼロ）。
- **冪等・再送**: 同じ履歴を何度送っても二重計上されない。失敗は再送する。

- 対象: 3dpmon v2.2.x 以降 / ItemKeeper ik2（`https://itemkeeper.com`）
- 役割: 3dpmon = **プッシュ送信側（本書の実装対象）** / ItemKeeper = **受け口（別途実装）**
- ItemKeeper 側設計の正本: ItemKeeper リポジトリ `docs/design/3dpmon_print_ingest_webhook.md`

---

## 0. 汎用 Webhook との違い

| 観点 | 汎用通知 Webhook | ItemKeeper 連携（本書） |
|------|------------------|--------------------------|
| 目的 | 通知文配信 | 製造実績・フィラメント消費の取り込み |
| 認証 | なし | **ID（client_id）+ 鍵（secret）/ Bearer 必須** |
| 送信単位 | 単発イベント1件 | **全件スナップショット（機器ごとの履歴配列）** |
| 信頼性 | ファイア&フォーゲット | **アウトボックス + 指数バックオフ再送** |
| 重複 | 対策なし | **冪等（機器 + jobId で重複排除）** |
| ファイル同一性 | filename のみ | **filename + filemd5** |
| 機器 | hostname（表示名） | **機器ごとに配列化（alias/mac/hostname/model）** |

> 既存 `_sendWebHook()`（`dashboard_notification_manager.js`）は通知用のまま残し、本連携は新モジュール
> （例 `dashboard_integration_itemkeeper.js`）として分離実装することを推奨する。

---

## 1. 全体像

```
[ItemKeeper] でクライアントを発行 → client_id（ID） + secret（鍵）を 3dpmon に設定
       │
3dpmon: 印刷 開始/完了 を検知
       │ 保持している印刷履歴を「機器ごとの配列」にまとめる（全件スナップショット）
       │ Authorization: Bearer client_id.secret を付与（特定 URI・特定方法）
       │ アウトボックスに積み、gzip で POST（失敗は再送）
       ▼
[ItemKeeper] /api/ingest/print-events
       1) 認証（Bearer）・リプレイ防止・冪等
       2) client_id → org 確定 / 機器を同定
       3) 各ジョブを解析（新規のみ「製造結果取り込み」へ）
```

- **client_id は 3dpmon インスタンス（= 1 組織）に1つ**。1 回の POST に**複数機器**の履歴を含められる。
- 機器は **配列の各要素**として送る（受信側が「どの機器の履歴か」を判定できる）。

---

## 2. 設定方法

ItemKeeper 連携の**接続情報はインスタンス単位**（1 つ）で持ち、**機器エイリアスは機器ごと**に持つ。

### 2.1 インスタンス設定（接続設定モーダルに「ItemKeeper連携」セクションを新設）

| 項目 | キー | 説明 |
|------|------|------|
| 連携を有効化 | `enabled` | ON で印刷開始・完了時に送信 |
| 接続先 URL | `endpoint` | 例 `https://itemkeeper.com/api/ingest/print-events`。「接続先:ポート」入力は内部で完全 URL に正規化 |
| クライアント ID | `clientId` | ItemKeeper が払い出す「ID」 |
| 暗号キー | `secret` | ItemKeeper が払い出す「鍵」（共有シークレット。Bearer 認証鍵） |
| 暗号化 | `encoding` | **Phase1 は `none` 固定**（履歴 JSON を平文・Bearer 認証）。`aes-256-gcm` は**受信側 Phase4+ 予定・現状未受理**のため UI は選択不可（グレーアウト）。**いずれの場合も Bearer 認証は外さない** |
| カメラ画像を添付 | `attachCamera` | 既定 **OFF**。ON で送信のたびに各機の現在カメラ画像（JPEG）を Base64 で `device.camera` に付与（§4.4）。OFF時は現行 JSON と完全一致＝**下位互換** |
| 状態パネルを添付 | `attachState` | 既定 **OFF**。ON で各機の状態パネル（`storedData`）を `device.state` に付与（§4.5）。各キー raw（加工前）＋ value/unit/text（加工後） |
| ファイル一覧を添付 | `attachFiles` | 既定 **OFF**。ON で各機のファイル一覧を `device.files` に付与（§4.6） |
| サムネをBase64添付 | `attachFileThumbs` | 既定 **OFF**。`attachFiles` ON 時、`files[].thumbnail` に Base64 サムネを付与（重い・同時数/枚数制限あり）。OFFなら `thumbnailUrl` のみ |
| フィラメント更新履歴を添付 | `attachFilamentHistory` | 既定 **OFF**。ON でトップレベル `spools[]`（画面上のフィラメント一覧＝識別子レジストリ）＋各機 `device.filamentHistory`（装着/取外し履歴＋切れ/交換イベント）を付与（§4.7）。消費量はジョブ履歴 `jobs[]` と重複するため含めない |
| 開始時に送信 | `onStart` | 既定 ON |
| 完了/失敗時に送信 | `onFinish` | 既定 ON |
| 履歴の送信範囲 | `historyScope` | `all`（全件・既定）/ `recent:{n}`（直近 n 件）。大規模時の調整用 |

```js
// monitorData.appSettings.itemkeeper = {
  enabled: true,
  endpoint: "https://itemkeeper.com/api/ingest/print-events",
  clientId: "ikc_live_xxxxxxxxxxxx",
  secret: "********",
  encoding: "none",         // Phase1は "none" 固定（"aes-256-gcm" は受信側Phase4+・現状未受理）
  onStart: true,
  onFinish: true,
  historyScope: "all"       // "all" | "recent:200"
}
```

### 2.2 機器エイリアス（接続先ごと = `connectionTargets[]`）

| 項目 | キー | 説明 |
|------|------|------|
| 機器エイリアス | `ikDeviceAlias` | **ItemKeeper 側で機器を一意化する安定名**（例「1号機」）。DHCP で hostname が変わっても不変。未設定時は `label`→`hostname` で代替 |
| この機器を連携対象にする | `ikEnabled` | 既定 ON。OFF の機器は配列から除外 |
| この機器のカメラ画像を添付する | `ikCamera` | 既定 ON。`attachCamera` が ON のとき、本フラグが false の機器だけ `device.camera` を付与しない（カメラ無し機の除外用）。`attachCamera` が OFF なら本フラグは無視 |

- 永続化は既存 `saveUnifiedStorage()` で自動（`appSettings` 全体が対象）。
- ItemKeeper 側はこの `ikDeviceAlias` を「1号機/2号機」等の登録機器に突き合わせる（機器別の稼働可視化に使う）。

### 2.3 テスト送信
「連携テスト送信」ボタンで疎通＋認証を確認（`X-IK-Trigger: ingest.test`、本文は空 `devices:[]`）。
ItemKeeper は 2xx を返す。401/403 は認証失敗として UI に明示する。

---

## 3. 送信タイミング

| トリガ | X-IK-Trigger | 送信内容 |
|--------|--------------|----------|
| 印刷開始検出（新 PrintID） | `print.started` | **全件スナップショット**（開始直後の進行中ジョブを含む） |
| 印刷正常完了（`printDone`） | `print.finished` | **全件スナップショット**（確定したジョブを含む） |
| 印刷失敗/中断（`printFailed`） | `print.finished` | 同上（失敗ジョブは `result:"failed"`/`"canceled"`） |

- いずれのトリガでも本文は同一構造（§4）。**毎回スナップショット全件**を送るため、トリガを取りこぼしても次回で必ず追いつく。
- `X-IK-Trigger` と本文の `trigger` は「何が起きたか」の補助情報。受信側の処理は**スナップショットの差分（新規ジョブ）駆動**であり、トリガ依存ではない。
- 任意: `historyScope` を `recent:n` にすると直近 n 件のみ送る（受信側は冪等なので欠落しても次回補完）。

---

## 4. ペイロード（履歴 JSON）

### 4.1 構造（機器ごとの配列）
本文は「**機器IDオブジェクトごとに履歴配列を持つ**」構造。バージョン管理のためエンベロープで包む。

```jsonc
{
  "schema": "3dpmon.ik.history.v1",
  "sentAt": "2026-06-08T15:47:31.000Z",
  "trigger": { "event": "print.finished", "deviceKey": "1号機", "jobId": 1738921200 }, // 補助
  "devices": [                          // ★機器ごとの配列
    {
      "deviceKey": "1号機",             // 配列の機器ID（ikDeviceAlias 優先・安定キー）
      "device": {
        "alias": "1号機",
        "hostname": "k1max-abcd.local",
        "ip": "192.168.1.5",
        "mac": "fc:ee:28:11:22:33",     // Electron 時・取得できれば
        "model": "K1 Max"
      },
      "camera": {                        // ★任意（attachCamera=ON 時のみ・§4.4）。取得不可なら省略
        "mime": "image/jpeg",
        "dataBase64": "/9j/4AAQSk...",   // 生 Base64（data: プレフィックスなし）
        "bytes": 20345,
        "capturedAt": "2026-06-08T15:47:31.000Z"
      },
      "jobs": [ /* §4.2 履歴レコード（全件 or 直近n件） */ ]
    }
    /* , { 別の機器 … } */
  ]
}
```

### 4.2 履歴レコード（jobs[] の1件）
```jsonc
{
  "jobId":          1738921200,          // 安定ジョブID（=開始時刻epoch秒）。冪等キーの一部・大小で時系列保証
  "filename":       "dragon_plate.gcode",
  "rawFilename":    "/card/gcodes/dragon_plate.gcode",
  "filemd5":        "3a7f4e8b...",       // プリンタ報告値（§6.3 注意）。内容同一判定に使う
  "startTime":      "2026-06-08T15:00:00.000Z",
  "finishTime":     "2026-06-08T15:47:30.000Z", // 進行中は null/省略
  "durationSec":    2685,
  "state":          "finished",          // "printing" | "finished"
  "result":         "success",           // finished 時: success | failed | canceled（printing 時は null）
  "printfinish":    1,                   // 1=成功 0=失敗 null=未確定（3dpmon内部値）
  "materialUsedMm": 14256,               // 確定総消費(mm)。進行中は途中値/省略可
  "filaments": [                         // 分割交換対応の配列
    {
      "spoolId":   "spool_1654789_a3f2",
      "serialNo":  42,
      "material":  "PLA",
      "colorName": "Leaf Green",
      "colorHex":  "#2ECC71",
      "brand":     "CC3D",
      "diameterMm":1.75,
      "density":   1.24,
      "usedMm":    14256,                // ★このスプールの消費(mm)＝真値
      "usedGram":  52.7,                 // 参考（density×mm の派生値）
      "spoolRemainMm": 187400            // 参考（リール残のヒント）
    }
  ]
}
```

> **mm が真値・g は派生**: G-code/プリンタは mm（押し出し長）基準で、素材が違っても温度が合えば出てしまうため、
> g は密度からの逆算値でしかない。ItemKeeper は mm を正として扱う。
> 古い履歴で `filaments[].usedMm` が無い場合は、ジョブ全体の `materialUsedMm`（単一スプール扱い）にフォールバックしてよい。

> **`filename` は basename（拡張子込みのファイル名のみ）で送る**: ItemKeeper の出力マッピングは `filename`（basename）を主キーに解決する。フルパスは `rawFilename`（情報用）に入れること。`filename` にパスを含めるとマッピング不一致になる。

### 4.3 暗号化（encoding=aes-256-gcm 時）【Phase4+ 予約・受信側未対応】
> **Phase1 では受信側が AES を未対応（`none` のみ受理）。本節は将来（Phase4+）用の予約仕様。** 当面 3dpmon は `encoding=none` で送信する。

`devices` 配列を含む JSON を AES-256-GCM で暗号化し、本文を次のエンベロープにする:
```jsonc
{ "enc":"aes-256-gcm", "v":1, "iv":"<b64,12B>", "ct":"<b64>", "tag":"<b64,16B>" }
// 鍵 = HKDF-SHA256(secret)
```

### 4.4 カメラ画像（任意・`device.camera`）【attachCamera=ON 時のみ】

`attachCamera` が ON のとき、各 `device` に「**送信時点の現在カメラ画像**」を Base64(JPEG) で付与する。

```jsonc
"camera": {
  "mime":       "image/jpeg",        // 現状 JPEG 固定
  "dataBase64": "/9j/4AAQSk...",     // 生 Base64（data: プレフィックスを含めない）
  "bytes":      20345,               // 元 JPEG のバイト数（参考）
  "capturedAt": "2026-06-08T15:47:31.000Z" // 取得時刻（ISO8601）
}
```

- **下位互換**: `camera` は**任意フィールド**。OFF 時・取得失敗時・機器別 `ikCamera=false` 時は**キー自体を省略**するため、既存の v1 受信実装はそのまま動作する（スキーマ番号は据え置き）。
- **取得経路（3dpmon 側実装メモ）**:
  - **Electron 親**（本番）: 親レンダラーは `file://` オリジンのため CORS でプリンタ画像を直接読めない。メインプロセスが `set-camera-endpoints` の allowlist 経由でプリンタの `/?action=snapshot` を1枚取得し、`get-camera-snapshot` IPC で Base64 を返す（`/relay-camera` プロキシと短期キャッシュ・取得関数を共有）。
  - **リレー子 / 同一オリジン http**: 親の `/relay-camera/{host}/snapshot.jpg` を同一オリジン fetch して blob→Base64。
  - 上記いずれも不可（ブラウザ直接接続で CORS 不許可・カメラ無し・オフライン等）なら **画像を省略**。
- **サイズ/再送**: JPEG は gzip が効かないため画像分だけ本文が増える。**413（サイズ超過）時は §7 の `historyScope` 縮小再送が `buildSnapshot` で本文を組み直すため、再送時には画像が自動的に外れて履歴のみ送られる**（画像は確実性より履歴優先）。

### 4.5 状態パネル（任意・`device.state`）【attachState=ON 時のみ】

`attachState` が ON のとき、各 `device` に状態パネル（3dpmon 内部の `storedData` 全キー）を付与する。
各キーは **加工前（`raw`＝プリンタ生値）と 加工後（`value`/`unit`/`text`＝UI 変換値）を併記**する。

```jsonc
"state": {
  "capturedAt": "2026-06-08T15:47:31.000Z",
  "fields": {
    "nozzleTemp":    { "raw": 215.34, "value": "215.3", "unit": "℃", "text": "215.3℃" },
    "printProgress": { "raw": 42,     "value": "42",    "unit": "%", "text": "42%" },
    "state":         { "raw": 1,      "value": "印刷中", "unit": "",  "text": "印刷中" }
    // …全 storedData キー
  }
}
```

- `raw` は `storedData[key].rawValue`、`value`/`unit` は `computedValue`（`{value,unit}` 形）を正規化、`text` は連結表示用。
- 任意フィールド。OFF 時・storedData 空の機器は省略（下位互換）。**クロスオリジン無関係**（in-memory から組み立て）。

### 4.6 ファイル一覧（任意・`device.files`）【attachFiles=ON 時のみ】

`attachFiles` が ON のとき、各 `device` にプリンタのファイル一覧（3dpmon が取得済みのもの）を付与する。

```jsonc
"files": {
  "capturedAt": "2026-06-08T15:47:31.000Z",
  "items": [
    {
      "name":         "dragon.gcode",                 // basename
      "path":         "/card/gcodes/dragon.gcode",
      "sizeBytes":    1234567,
      "modifiedSec":  1700000000,
      "layer":        499,
      "expectMm":     14256,                           // 予定使用量(mm)
      "thumbnailUrl": "http://192.168.1.5/downloads/…", // プリンタ宛URL（参考）
      "thumbnail": {                                    // attachFileThumbs=ON 時のみ・取得成功時のみ
        "mime": "image/png", "dataBase64": "iVBOR…", "bytes": 8123
      }
    }
  ]
}
```

- 任意フィールド。OFF 時・ファイル一覧未取得の機器は省略（下位互換）。`device.files` メタは **in-memory（`getFileList`）から組み立てクロスオリジン無関係**。
- **サムネ Base64（`attachFileThumbs`）の取得経路はカメラと同型**: ① Electron 親＝`get-image-base64` IPC（`/relay-image` と同じ SSRF 制約＝`downloads/` 配下のみ・`httpPort`）② リレー子/同一オリジン http＝`/relay-image/{host}/{path}` fetch。取得不能なら `thumbnailUrl` のみ残す。**同時取得数・1機あたり枚数を制限**（暴走/送信遅延防止）。
- **サイズ/再送**: state/files（特にサムネ Base64）は本文を増やす。**413 時は §7 の縮小再送が `buildSnapshot` で組み直すため、これら任意ブロックは自動的に外れて履歴のみ送られる**（履歴優先）。

### 4.7 フィラメント更新履歴（任意・トップレベル `spools[]` ＋ `device.filamentHistory`）【attachFilamentHistory=ON 時のみ】

`attachFilamentHistory` が ON のとき、**トップレベルに `spools[]`（画面上のフィラメント一覧＝識別子レジストリ）** と、**各機 `device.filamentHistory`（装着/取外し履歴＋切れ/交換イベント）** を付与する。これにより履歴/ジョブが参照する `spoolId` を、画面上の識別子（`#NNN`・名前・素材・色）へ確実に解決でき、フィラメントの運用追跡に使える。**消費量はジョブ履歴 `jobs[].filaments[].usedMm` に既出のため重複させない**（per-spool の `usedLengthLog` だけ＝スプール視点の補助ログ）。

```jsonc
{
  "schema": "3dpmon.ik.history.v1", "sentAt": "…", "trigger": { … },
  "spools": [                              // ★トップレベル：画面上のフィラメント一覧（識別子レジストリ・削除済み除外）
    {
      "spoolId": "spool_1700000000_abc",   // 内部ID（権威キー・履歴/jobs の spoolId と一致）
      "serialNo": 1, "serialDisplay": "#001", // 画面表示の通し番号
      "name": "緑PLA",                     // 画面表示名
      "material": "PLA", "materialSub": "Silk",
      "colorName": "Leaf Green", "colorHex": "#2ECC71", "brand": "CC3D",
      "diameterMm": 1.75, "density": 1.24,
      "totalLengthMm": 330000, "remainingLengthMm": 187400,
      "printCount": 3, "isActive": true, "inferred": false,
      "hostname": "k1max-abcd.local",      // 現在の装着先（未装着は null）
      "usedLengthLog": [ { "jobId": "1700000000", "usedMm": 14256 } ] // スプール視点の per-print 消費
    }
  ],
  "devices": [
    {
      "deviceKey": "1号機", "device": { … }, "jobs": [ … ],
      "filamentHistory": {                 // ★各機：当該 host 分の更新履歴
        "mountHistory": [                  // 装着/取外し履歴（ADR-0004・追記専用）
          { "evId": "mount_…",   "ts": 1700000000000, "type": "mount",   "spoolId": "…", "anchorRemainingMm": 200000, "sinceJobId": "0" },
          { "evId": "unmount_…", "ts": 1700009000000, "type": "unmount", "spoolId": "…", "untilJobId": "1700008000" }
        ],
        "events": [                        // 切れ/交換イベント（ADR-0005・現在の文脈）
          { "evId": "fctx_…", "ts": 1700000500000, "stateAtEvent": 5, "oldSpoolId": "…", "oldRemainingMm": 1000, "oldRemainingPct": 0.5, "runout": true, "resolved": false, "resolution": null, "jobIdAtEvent": "1700000000" }
        ]
      }
    }
  ]
}
```

- 任意フィールド。OFF 時・データの無い機器は省略（下位互換）。すべて **in-memory（`monitorData.filamentSpools`/`mountHistory`/`filamentEventContext`）から組み立て・同期処理・クロスオリジン無関係**。
- `spools[]`（トップレベル）はインスタンス共有の一覧。`device.filamentHistory` は `host` で絞り込む。
- ジョブ毎の `jobs[].filaments[]` にも **画面識別子 `serialDisplay`(`#NNN`)・`name` を追加**（後方互換の追加フィールド）。
- **413 時**は他の任意ブロックと同様、縮小再送で自動的に外れる（履歴優先）。

---

## 5. HTTP リクエスト

```
POST {endpoint}
Authorization:   Bearer {clientId}.{secret}
Content-Type:    application/json
Content-Encoding: gzip                  // 履歴が大きいので gzip 圧縮を推奨
X-IK-Trigger:    print.started | print.finished | ingest.test
X-IK-Timestamp:  {epoch_ms}             // リプレイ防止（受信側 ±5分外は拒否）
X-IK-Nonce:      {uuid}                  // リプレイ防止（この POST の一意性）
X-IK-Request-Id: {uuid}                  // ログ追跡用（冪等キーではない）
X-IK-Encoding:   none                    // Phase1は none 固定（aes-256-gcm は受信側Phase4+・現状未受理）
# 【Phase4+ 予約】encoding=aes-256-gcm かつ署名併用時のみ:
X-IK-Signature:  sha256={hex}            // HMAC-SHA256(secret, `${X-IK-Timestamp}.${X-IK-Nonce}.${rawBody}`)

{body}                                   // §4（gzip 圧縮可）
```

- メソッド `POST`。**Authorization は Bearer 必須**。
- **冪等は本文の各レコード単位**（`client_id` + `deviceKey` + `jobId`）。POST 単位の冪等キーは持たない（スナップショットは毎回内容が変わるため）。`X-IK-Nonce` は POST の再送（同一バイト列）リプレイ防止用。
- gzip 圧縮を推奨（全件履歴は数百 KB になりうる）。
- **Phase1 の受理は `encoding=none` のみ**。受信側は `X-IK-Encoding` が none 以外なら **400（`unsupported encoding`）** で明示拒否する（§7 の 400 と同じく再送せず UI 警告）。`X-IK-Signature` も Phase1 は未使用（Bearer が認証を担保）。
- 【Phase4+ 予約】`X-IK-Signature` は将来 aes 併用時の任意上乗せ（`crypto.subtle` 必須・§6.2 注意）。

---

## 6. 実装メモ・注意

### 6.1 アウトボックス（再送）
- 製造実績は落とせない。POST 前に IndexedDB のキューへ積み、2xx 受領で削除、失敗は指数バックオフで再送。
- スナップショット方式なので、再送が遅れても次回 POST に最新全件が含まれる。冪等なので重複送信は無害。

### 6.2 暗号化しないでも認証は外さない / secure-context
- `encoding=none` は履歴 JSON を平文で送るだけ。`Authorization: Bearer` は常に付与。
- `crypto.subtle`（署名・AES）は**セキュアコンテキスト限定**。`http://localhost`・`https://`・Electron は可だが
  **`http://192.168.x.x` 直アクセスでは使えない**。→ 既定は **Bearer のみ（crypto 不要）**。署名/暗号化は使える環境での上乗せ。

### 6.3 filemd5 はプリンタ報告値（重要）
- `filemd5` は印刷履歴に**プリンタが報告する値**で、3dpmon は算出しない（md5 ライブラリ無し・SubtleCrypto は MD5 非対応）。
- かつ **md5 は印刷完了後の履歴にしか現れない**（印刷前には不明）。
- → ItemKeeper 側のマッピングは **filename を主キー**に、**md5 は内容同一の確認**に使う設計が前提。
  ローカルで事前計算した md5 を登録する運用は、**プリンタ報告 md5 と一致するか要検証**（本書 §8 / ItemKeeper 側で扱う）。

### 6.4 混在コンテンツ / CORS
- `https://` で開いた 3dpmon から `http://` LAN 宛 POST はブラウザがブロック。`https://itemkeeper.com` 宛は問題なし。
- クロスオリジン POST はプリフライト（OPTIONS）が走る。ItemKeeper 側で許可する（セキュリティは Bearer が担保）。Electron 経由なら実質非問題。

### 6.5 秘密情報
- `secret` は localStorage/IndexedDB に平文保存。ItemKeeper 側で**低権限・即時失効可能**なクレデンシャルとして発行される前提。

### 6.6 3dpmon が必ず載せるべきフィールド
解析は ItemKeeper 側が行うが、それには **`deviceKey`/`device`、`job.filename`+`job.filemd5`、`filaments[].{material,colorHex,spoolId,usedMm}`** が要。**欠かさず載せる**こと。

### 6.7 リレー親子での設定同期（v2.2.1031〜、v2.2.1032 で永続層を物理分離）
ItemKeeper 設定（`appSettings.itemkeeper`）は **親（デスクトップ `file://`）が唯一の権威**として保持・送信する。以下で親子の表示と送信元を一致させる。
- **親 → 子ミラー**: relay-snapshot / relay-delta に `appSettings.itemkeeper` を含める。子は受信して `monitorData.appSettings.itemkeeper` を置換し `itemKeeperIntegration.loadSettings()` で自身を再構築する。
- **readonly（閲覧専用）**: 設定欄は無効化＝読み取りミラー。
- **satellite（操作）**: 編集可。保存は新 RPC `relay-settings`（`{type:"relay-settings", payload:{itemkeeper}}`）で親へ委譲。親が `applyRemoteSettings()` で確定保存し、次回 delta で全子へ還流する（往復同期）。readonly からの `relay-settings` はサーバ側ガードで拒否。
- **送信元**: ItemKeeper への POST・定期送信は **親とスタンドアロンのみ**。リレー子（readonly/satellite）は `window._3dpmonRelayChild` ガードで送信しない＝重複報告を防ぐ。
- **standalone（`?relay=standalone`）**: リレー子ではなく独立クライアント。自身の設定を独自に保持・送信する（同期対象外）。

#### 6.7.1 ストレージ分離（v2.2.1032〜）
親(`file://`) と ブラウザ(`http://host:5313`) のオリジン差で IndexedDB は自動分離されるが、**同一ブラウザ内の `?relay=standalone` と既定の readonly はクエリ違いだけで origin が同じため IDB / localStorage を共有してしまう**（v2.2.1031 までの暗黙の前提崩れ）。readonly が relay-snapshot で受けた親由来 `monitorData` を autoSave で同一DBへ書き戻すと、後から開く standalone の永続データが破壊される。

これを防ぐため、リレー子（readonly/satellite）モードで起動した時のみ、ストレージ初期化前に名前空間を `"relay"` へ切り替える（`setStorageNamespace("relay")` + `setPanelLayoutNamespace("relay")`）。具体的には:

| 対象 | 親 / standalone | リレー子(readonly/satellite) |
|---|---|---|
| IndexedDB DB 名 | `"3dpmon"` | `"3dpmon-relay"` |
| localStorage 全体キー | `"3dpmon-global"` | `"3dpmon-relay-global"` |
| localStorage host 接頭辞 | `"3dpmon-host-"` | `"3dpmon-relay-host-"` |
| パネルレイアウト LS キー | `"3dpmon_panel_layout_v5"` | `"3dpmon_panel_layout_v5_relay"` |

これにより同一ブラウザ内の standalone とリレー子は **物理的に別DB／別LSキー** に書き出されるため、互いに永続データを上書きしない。親(Electron `file://`) と standalone(`http://`) は従来通り origin 差で自動分離される（両方 `"3dpmon"` のままで後方互換）。

---

## 7. レスポンス契約と再送判断

ItemKeeper はバッチ結果を JSON で返す。

```jsonc
// 200 OK
{ "status": "ok",
  "accepted": 3,      // 新規に受理したジョブ数
  "duplicate": 41,    // 既受信でスキップした数
  "pending_review": 3,// 取り込み待ち（人手確定待ち）に積んだ数
  "devices_unregistered": ["2号機"]  // 未登録機器（要・管理画面で登録）
}
```

| HTTP | 3dpmon の挙動 |
|------|----------------|
| 200/202 | 成功。アウトボックスから削除 |
| 400 | スキーマ不正。再送せずログ＋UI 警告 |
| 401/403 | 認証失敗・失効。再送せず **UI に「ItemKeeper 認証エラー」明示** |
| 413 | サイズ超過。`historyScope` を縮小して再送 |
| 429 / 5xx / ネットワーク | 指数バックオフで再送 |

---

## 8. ItemKeeper 側の扱い（対向の参考・3dpmon 実装には不要）

- `clientId → org` 固定。受信は org スコープ隔離。`deviceKey` を登録機器（1号機/2号機 等）に突き合わせ、機器別稼働を可視化。
- `filename`(+`filemd5`) → **「どのアイテムが何個できるか」の配列**に解決（同時複数アイテム対応）。md5 は内容同一の確認・ドリフト検出に使用。
- 受信は「**製造結果取り込み**」に着地し、**人が品目ごとに良品/不良を確認して確定**（検品兼用）→ 良品=入庫 / 不良=不良ロット入庫（廃棄待ち/再生待ち）/ フィラメント=mm で出庫。
- 将来: フィラメント交換時に「次に何色をセットし何を作るか（不足順/重要順）」を提示する planning に、本連携の機器×フィラメント×出力マッピング データを使う。

---

## 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-06-08 | 初版ドラフト: ItemKeeper 専用連携。Bearer 認証・冪等・再送・filemd5・filaments[]。単発イベント方式。 |
| 2026-06-08 | v2（Phase1確定版）: **全件スナップショット＋機器ごとの配列**方式に変更。client_id はインスタンス単位（1 org）。機器エイリアスで機器同定。冪等はレコード単位（deviceKey+jobId）。gzip。filemd5 はプリンタ報告値（事前計算の一致は要検証）。レスポンス=バッチ集計。 |
| 2026-06-08 | v2.1（受信対向 最終確認反映）: Phase1 の受理は **`encoding=none` のみ**と明記（`aes-256-gcm`/`X-IK-Signature` は受信側 Phase4+ 予約・現状未受理・UI 選択不可）。受信側は非 none encoding を 400（`unsupported encoding`）で拒否。`filename`=basename（マッピングキー）/`rawFilename`=フルパスの規則を明文化。 |
