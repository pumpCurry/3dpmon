# フォント生成ガイド

このドキュメントでは `font_tools/train_pix2pix_updated.py` の概要と使用方法を説明します。pix2pix を利用して参考フォントから GD 高速道路ゴシック JA のスタイルを学習し、欠けている文字を補完生成します。

## 主な機能
- 参考フォントとターゲットフォントの文字をレンダリングして学習画像を自動生成
- U-Net Generator と PatchGAN Discriminator を利用した pix2pix 学習
- 学習済みモデルを用いたバッチ推論により、新しい文字画像を生成

## 使用手順
1. `TARGET_FONT_PATH` と `REFERENCE_FONT_PATH` にそれぞれターゲットフォントと参考フォントのファイルパスを指定します。
2. `common_chars_for_training` に学習させる文字ペアを辞書形式で定義します。
3. スクリプトを実行すると学習用画像が `data_updated/train/` 以下に出力され、pix2pix の学習が始まります。
4. エポックごとにチェックポイントが `checkpoints_gd_highwaygothic/` に保存されます。
5. 学習後、`missing_chars_to_generate` で指定した文字を生成し、`output_gd_highwaygothic/` に PNG 形式で保存します。

## 参考
- 学習データの品質が生成結果に大きく影響するため、できるだけ多くの文字ペアを用意してください。
- Pillow の `textbbox` を利用して文字を中央に配置するなど、描画精度を高める実装になっています。
