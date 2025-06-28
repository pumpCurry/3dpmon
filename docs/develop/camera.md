# CameraCard 使用ガイド

CameraCard は 3dpmon の映像プレビューを担当するカードです。ここでは基本 API と再接続フローをまとめます。

## API
| メソッド | 説明 |
|----------|------|
| `init({streamUrl,minSize,aspect})` | 初期設定を適用 |
| `mount(container)` | DOM へ挿入 |
| `update({streamUrl})` | ストリーム URL 更新 |
| `destroy()` | リソース解放 |
| `scale(x)` | 倍率変更（BaseCard） |
| `setPosition(x,y)` | 位置変更（BaseCard） |

## 再接続フロー
1. `<video>` が `error` または `stalled` を 3 回検出すると `retry()` を実行。
2. 再接続失敗時は `/snapshot.jpg` を表示し `camera:error` を emit。
3. 成功時は `camera:retry` を emit して映像を再開します。
