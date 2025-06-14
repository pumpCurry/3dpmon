# 3dpmon

Browser-based monitor for Clarity K1 series 3D printers.
開発中の3Dプリンタ監視ダッシュボードです。

The dashboard includes a filament spool manager. Each spool can store its
name, color, material and weight. Length and weight fields accept either
mm/m or g/kg and automatically convert between units. Manufacturers or
custom materials can be registered on the fly from the overlay dialog.

## Quick Start / 使い方
1. ダウンロードしたファイルを任意のフォルダに配置します
2. Windows 例:
   ```
   c:\3dpmon> python -m http.server 8000
   ```
3. ブラウザで [http://localhost:8000/3dp_monitor.html](http://localhost:8000/3dp_monitor.html) を開きます

初回接続方法や音声設定などの詳細な操作説明は
[USAGE-ja-en.md](USAGE-ja-en.md) を参照してください。画面構成の詳細も同ガイドの
"Dashboard Layout / 画面構成" セクションにまとめています。

## License
This project is licensed under the MIT License. See [LICENSE](LICENSE).

## Copyright
(C) pumpCurry
