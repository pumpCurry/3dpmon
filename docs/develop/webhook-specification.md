# 3dpmon Webhook 仕様書

3dpmon の通知イベント発火時に、設定された URL へ HTTP POST で構造化ペイロードを送信する機能。
Slack / Discord / LINE / IFTTT / n8n / Node-RED 等の外部サービスとの連携に使用できる。

## 設定方法

### Webhook URL の設定

1. 接続設定モーダルを開く
2. 「通知設定」ボタンをクリック
3. 「追加設定」セクションの **Webhook URLs** テキストエリアにカンマ区切りで URL を入力
4. 「Webhook テスト送信」ボタンで疎通確認
5. 「すべて保存」をクリック

### Per-Host ON/OFF

接続設定モーダルのプリンタ一覧で、各機器の **WH** チェックボックスで Webhook 送信の有効/無効を切り替え可能。
チェックを外すと、その機器のイベントは Webhook に送信されない（TTS・画面通知は維持される）。

---

## 送信仕様

### HTTP リクエスト

```
POST {webhookUrl}
Content-Type: application/json

{payload}
```

- **メソッド**: POST
- **ヘッダー**: `Content-Type: application/json`
- **送信方式**: ファイア・アンド・フォーゲット（レスポンスを待たず UI をブロックしない）
- **リトライ**: なし（失敗時はブラウザコンソールに警告出力のみ）
- **複数URL**: 登録された全 URL に同一ペイロードを送信

---

## ペイロード構造

### 共通フィールド

```json
{
  "text": "K1Max-4A1B 印刷完了 Benchy.gcode 消費12.3m (21g, ¥110) スプール残151.2m (45%)",
  "event": "printCompleted",
  "hostname": "K1Max-4A1B",
  "timestamp": "2026-03-15T06:42:00.000Z",
  "timestamp_epoch": 1773826920000,
  "timestamp_local": "2026/3/15 15:42:00",
  "timezone_offset_min": -540,
  "data": { ... }
}
```

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `text` | string | Slack Incoming Webhook 互換のテキスト。そのまま投稿可能 |
| `event` | string | イベント種別キー（下記一覧参照） |
| `hostname` | string | 機器の表示名（`storedData.hostname` の値。IP ではない） |
| `timestamp` | string | ISO 8601 UTC 形式 (`YYYY-MM-DDTHH:mm:ss.sssZ`) |
| `timestamp_epoch` | number | Unix エポック（ミリ秒）。連番管理・順序保証に使用可能 |
| `timestamp_local` | string | ブラウザのローカルタイムゾーンでの表示文字列 |
| `timezone_offset_min` | number | UTC からのオフセット（分）。JST = -540, UTC = 0。`new Date().getTimezoneOffset()` の値 |
| `data` | object | イベント固有のフィールド（下記参照） |

### タイムスタンプの解釈

`timezone_offset_min` は JavaScript の `Date.getTimezoneOffset()` の値で、**UTC から ローカル時刻を得るために引く値**（符号注意）。

```
ローカル時刻 = UTC - timezone_offset_min 分
```

例: JST (UTC+9) の場合 `timezone_offset_min = -540` → `UTC - (-540分) = UTC + 9時間`

受信側で日付をローカルに変換する場合は `timestamp_epoch` を使うのが最も確実。
`timestamp_local` は送信元ブラウザの表示文字列なので、表示用途にのみ使用推奨。

---

## イベント一覧

### 印刷イベント

| event | 発火タイミング | data フィールド |
|-------|-------------|----------------|
| `printStarted` | 印刷開始検出時 | — |
| `printCompleted` | 印刷正常完了時 | `filename`, `materialUsed`, `materialUsed_mm`, `materialUsed_g`, `materialUsed_cost`, `materialUsed_currency`, `spoolName`, `spoolRemain`, `spoolRemain_mm`, `spoolRemain_pct`, `spoolRemain_g`, `spoolId`, `spoolSerial`, `material` |
| `printFailed` | 印刷失敗検出時 | `filename` + 上記スプール情報 |
| `printPaused` | 一時停止時 | — |
| `printResumed` | 再開時 | — |

### フィラメントイベント

| event | 発火タイミング | data フィールド |
|-------|-------------|----------------|
| `filamentOut` | フィラメント切れ検出 | — |
| `filamentReplaced` | フィラメント補充検出 | — |
| `filamentLow` | 残量が閾値以下 | `remaining` (mm), `thresholdPct`, `spoolName` |

### 残り時間イベント

| event | 発火タイミング | data フィールド |
|-------|-------------|----------------|
| `timeLeft10` | 残り10分を切った | `thresholdMin`, `remainingSec`, `remainingPretty` |
| `timeLeft5` | 残り5分を切った | 同上 |
| `timeLeft1` | 残り1分を切った | 同上 |

### エラーイベント

| event | 発火タイミング | data フィールド |
|-------|-------------|----------------|
| `errorOccurred` | エラー発生 | `error_code`, `error_key`, `error_msg` |
| `errorResolved` | エラー解消 | — |

### カメライベント

| event | 発火タイミング | data フィールド |
|-------|-------------|----------------|
| `cameraConnected` | カメラ接続成功 | — |
| `cameraConnectionStopped` | ストリーム停止 | — |
| `cameraConnectionFailed` | リトライ上限到達 | — |
| `cameraServiceStopped` | 機器側サービス異常停止 | — |

### 温度アラート

| event | 発火タイミング | data フィールド |
|-------|-------------|----------------|
| `tempNearNozzle80/90/95/98/100` | ノズル温度が上限の 80/90/95/98/100% 到達 | `ratio`, `ratioPct`, `currentTemp`, `maxTemp` |
| `tempNearBed80/90/95/98/100` | ベッド温度が上限の 80/90/95/98/100% 到達 | 同上 |

### テスト

| event | 発火タイミング | data フィールド |
|-------|-------------|----------------|
| `webhookTest` | 通知設定のテストボタン押下 | `message` |

---

## data フィールド詳細

### 印刷完了時の data フィールド

| フィールド | 型 | 単位 | 説明 |
|-----------|-----|------|------|
| `filename` | string | — | ファイル名 (basename) |
| `materialUsed` | string | — | 表示用テキスト (`"12.3m (21g, ¥110)"`) |
| `materialUsed_mm` | number | mm | 消費量の生値 |
| `materialUsed_g` | number | g | 消費量のグラム換算（密度ベース） |
| `materialUsed_cost` | number | (通貨) | 消費量のコスト換算 |
| `materialUsed_currency` | string | — | 通貨記号 (`"¥"`, `"$"` 等) |
| `spoolName` | string | — | スプール表示名 (`"#001 Emerald"`) |
| `spoolRemain` | string | — | 残量の表示テキスト |
| `spoolRemain_mm` | number | mm | 残量の生値 |
| `spoolRemain_pct` | number | % | 残量パーセンテージ |
| `spoolRemain_g` | number | g | 残量のグラム換算 |
| `spoolId` | string | — | スプールの内部 ID |
| `spoolSerial` | number | — | スプールのシリアル番号 (#NNN の NNN) |
| `material` | string | — | 素材名 (`"PLA"`, `"PETG"` 等) |

### 温度アラート時の data フィールド

| フィールド | 型 | 単位 | 説明 |
|-----------|-----|------|------|
| `ratio` | number | — | 上限に対する比率 (0.0-1.0) |
| `ratioPct` | number | % | 上限に対する比率 (0-100) |
| `currentTemp` | number | ℃ | 現在温度 |
| `maxTemp` | number | ℃ | 上限温度 |

---

## ペイロード例

### 印刷完了

```json
{
  "text": "K1Max-4A1B 印刷完了 Benchy.gcode 消費12.3m (21g, ¥110) スプール残151.2m (45%)",
  "event": "printCompleted",
  "hostname": "K1Max-4A1B",
  "timestamp": "2026-03-15T06:42:00.000Z",
  "timestamp_epoch": 1773826920000,
  "timestamp_local": "2026/3/15 15:42:00",
  "timezone_offset_min": -540,
  "data": {
    "filename": "Benchy.gcode",
    "materialUsed": "12.3m (21g, ¥110)",
    "materialUsed_mm": 12340.5,
    "materialUsed_g": 21,
    "materialUsed_cost": 110,
    "materialUsed_currency": "¥",
    "spoolName": "#001 Emerald",
    "spoolRemain": "151.2m (264g, ¥1,350) (45%)",
    "spoolRemain_mm": 151200,
    "spoolRemain_pct": 45,
    "spoolRemain_g": 264,
    "spoolId": "spool_1710000000_abc123",
    "spoolSerial": 1,
    "material": "PLA"
  }
}
```

### フィラメント残量低下

```json
{
  "text": "K1Max-4A1B フィラメント残量が少なくなっています 残り33600mm",
  "event": "filamentLow",
  "hostname": "K1Max-4A1B",
  "timestamp": "2026-03-15T06:30:00.000Z",
  "timestamp_epoch": 1773826200000,
  "timestamp_local": "2026/3/15 15:30:00",
  "timezone_offset_min": -540,
  "data": {
    "remaining": 33600,
    "thresholdPct": 10,
    "spoolName": "#001 Emerald"
  }
}
```

### Webhook テスト

```json
{
  "text": "3dpmon Webhook テスト送信",
  "event": "webhookTest",
  "hostname": "3dpmon",
  "timestamp": "2026-03-15T06:00:00.000Z",
  "timestamp_epoch": 1773824400000,
  "timestamp_local": "2026/3/15 15:00:00",
  "timezone_offset_min": -540,
  "data": {
    "message": "この通知はテスト送信です"
  }
}
```

---

## 連携例

### Slack Incoming Webhook

Slack の Incoming Webhook URL をそのまま登録すれば、`text` フィールドがチャンネルに投稿される。
構造化データが必要な場合は Slack Workflow Builder やカスタムアプリで `data` フィールドを解析する。

### Discord Webhook

Discord は `content` フィールドを使用するため、中継サーバーまたは Cloudflare Workers 等で変換が必要:

```javascript
// 変換例 (Cloudflare Worker)
const body = await request.json();
await fetch(DISCORD_WEBHOOK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: body.text })
});
```

### n8n / Node-RED

Webhook トリガーノードで受信し、`event` フィールドで分岐処理が可能。
`timestamp_epoch` を使えば重複排除やイベント順序の保証が容易。

---

## 制限事項

- **認証**: Bearer トークン等の認証ヘッダーは未サポート。URL に認証情報を含める方式のみ対応
- **リトライ**: 送信失敗時のリトライ機能なし
- **バッチ送信**: 個別イベントごとに即時送信。バッファリング/集約なし
- **ペイロードサイズ**: 制限なし（通常 1-3KB 程度）
- **CORS**: ブラウザの CORS ポリシーに依存。外部 URL が CORS を許可していない場合、送信はされるがレスポンスが読めない（テストボタンが失敗表示になる場合がある）

---

## 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-03-15 | 初版: 構造化ペイロード、数値分離、タイムスタンプ強化、per-host ON/OFF、テスト送信 |
