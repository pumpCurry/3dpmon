# HeadPreviewCard 使用ガイド

HeadPreviewCard (ID: HDPV) はホットエンドの位置を 2D または 3D で表示するカードです。カード単体でドラッグや倍率変更が可能で、モデルに応じたベッドサイズへ自動適応します。

## API
| メソッド | 説明 |
|---------|-----|
| `init({position, model})` | 初期座標とプリンタモデルを設定し、`ModelAdapter.getBedSize()` でベッド寸法を取得します |
| `mount(container)` | Canvas 要素を生成してコンテナへ挿入します |
| `update({position})` | ヘッド座標を更新し、`requestAnimationFrame` で描画します |
| `destroy()` | ループを停止して Canvas を開放します |

## 描画方式
- 既定は Canvas2D による 2D 表示です
- `import('three')` に成功した場合のみ Three.js を用いた 3D 表示へ切り替えます

## ベッドサイズと Z 表示
`ModelAdapter.getBedSize(model)` から `{w, h, zMax}` を取得し、2D 表示では Z 値をサイドバーに、3D 表示ではヘッドマーカーの高さに反映します。

## イベントバス
- `head:setModel` 受信時: モデル変更処理
- `head:updatePos` 受信時: 座標更新

## アクセシビリティ
Canvas 要素には `role="img"` と `aria-label="Head position X..Y..Z.."` を付与し、毎秒更新します。
