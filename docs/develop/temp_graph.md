# TempGraphCard ガイド

TempGraphCard (ID: TEMP) はホットエンドとベッド温度、およびファン速度を折れ線で表示するカードです。ステップ⑥で Chart.js 依存を排除し、独自実装の LiteChart を採用しました。

## API
| メソッド | 機能 |
| --- | --- |
| `init({dataset})` | 初期データ配列をセットします |
| `mount(container)` | Canvas を生成しカードを表示します |
| `update({time, hotend, bed, fan})` | 新しい計測値をリングバッファへ追加します |
| `destroy()` | 描画ループを停止して要素を除去します |

## テーマ拡張
- `--temp-hot-color`、`--temp-bed-color`、`--temp-fan-color` で各線色を変更できます。
- 既定テーマは `styles/card_temp.scss` に定義されています。

## キーバインド
- `R` キーでズームリセット、`F` キーでファンスピード表示の ON/OFF を切替えます。

