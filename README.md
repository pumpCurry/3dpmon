# 3dpmon

Browser-based monitor for Clarity K1 series 3D printers.
開発中の3Dプリンタ監視ダッシュボードです。

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

## Filament Registration
フィラメントスプールは設定カードの「フィラメントスプール」セクションで
登録・編集できます。`追加` ボタンを押すと以下のダイアログが表示されます。

```
┌──────────── スプール追加 ────────────┐
│ スプール名 : [             ]         │
│ 総長(mm)   : [        ]               │
│ 残り長(mm) : [        ]               │
│                       [OK] [キャンセル] │
└────────────────────────────────────┘
```

スプール名、総長さ、残り長さを入力して登録すると、印刷履歴カードの
スプール一覧から選択できるようになります。旧バージョンで作成したデータは
起動時に自動的に新形式へ変換されるため、そのまま利用可能です。

さらに `dashboard_spool.js` の `addSpool` 関数に `manufacturerName` や
`materialName` などのオプションを渡すことで、メーカー名や素材種別を
カスタム登録できます。

## License
This project is licensed under the MIT License. See [LICENSE](LICENSE).

## Copyright
(C) pumpCurry
