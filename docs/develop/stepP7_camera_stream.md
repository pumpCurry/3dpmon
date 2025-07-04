# Step P7 Camera Stream Integration

カメラプレビューを MJPEG/スナップショット方式へ拡張する。

## 対応ストリームと判定順

| 優先 | 種別 | URL 例 | 判定方法 |
| --- | --- | --- | --- |
| ① | HTTP MJPEG | `http://<ip>:<port>/?action=stream` | `fetch(HEAD)` 2 s 以内に 200 OK |
| ② | Snapshot Poll | `http://<ip>:<port>/?action=snapshot` | ① が 404 か 406 の場合 |
| ✕ | フォールバック停止 | – | サービス拒否時は警告表示 |

## StreamSelector.pick

```ts
const port = connection.camPort ?? 8080;
const base = `http://${connection.ip}:${port}`;
try {
  const r = await fetch(`${base}/?action=stream`, { method:'HEAD', signal, cache:'no-store', mode:'no-cors' });
  if (r.ok) return { mode:'mjpeg', url:`${base}/?action=stream` };
} catch (err) {
  if (err.message.includes('ERR_CONNECTION_REFUSED')) {
    bus.emit('log:add', `[CAM] Service down on ${connection.ip}:${port}`);
    return { mode:'down' };
  }
}
try {
  const r = await fetch(`${base}/?action=snapshot`, { method:'HEAD', signal, cache:'no-store', mode:'no-cors' });
  if (r.ok) return { mode:'snapshot', url:`${base}/?action=snapshot` };
} catch {}
return { mode:'unsupported' };
```

## CameraCard 表示

| 状態 | 表示 |
| --- | --- |
| mode:'down' | バナー「Camera service offline」 |
| mode:'unsupported' | アイコン＋“No stream” |

## 失敗時ロジック

- サービス停止は再試行しない。バナーは5秒表示後にカードを最小化。
- 404/406 はスナップショットへフォールバック。ネットワークエラーは10秒後に再試行。

