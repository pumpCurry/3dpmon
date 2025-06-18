# 3dpmon

Browser-based monitor for Clarity K1 series 3D printers. 開発中の3Dプリンタ監視ダッシュボードです。

The dashboard includes a filament spool manager. Each spool can store its name, color, material and weight. Length and weight fields accept either mm/m or g/kg and automatically convert between units. Manufacturers or custom materials can be registered on the fly from the overlay dialog.

## Installation
1. Download the project using **Git** or the GitHub download button.
   - **Git**: `git clone https://github.com/pumpCurry/3dpmon.git`
   - **Without Git**: open the repository on GitHub and select **Code → Download ZIP**.
2. Install Python 3 if it is not already available:
   - **Windows**: Install Python from the Microsoft Store [Python 3.13](https://apps.microsoft.com/detail/9pnrbtzxmb4z).
   - **Linux**: Most distributions provide `python3` packages, e.g. `sudo apt install python3`.
   - **macOS**: Python 3 is bundled on recent macOS versions. If missing, install from [python.org](https://www.python.org/).
3. Open a terminal and change into the extracted folder.
4. Launch a simple HTTP server:
   ```
   python -m http.server 8000
   ```
5. Access `http://localhost:8000/3dp_monitor.html` from your browser.

## Quick Start / 使い方
1. ファイル一式を任意のフォルダに展開します
2. 上記の `python -m http.server` を実行
3. ブラウザで `http://localhost:8000/3dp_monitor.html` を開き、右上にプリンタの IP アドレスを入力して接続します

詳細な操作説明とダッシュボードの各機能については [`docs/dashboard_usage.md`](docs/dashboard_usage.md) と [`docs/dashboard_features.md`](docs/dashboard_features.md) を参照してください。フィラメント管理機能のガイドは [`docs/FILAMENT-MANUAL-ja.md`](docs/FILAMENT-MANUAL-ja.md) にまとめています。

## Filament Registration
フィラメントスプールは設定カードの「フィラメントスプール」セクションで登録・編集できます。`追加` ボタンを押すと以下のダイアログが表示されます。

```
┌──────────── スプール追加 ────────────┐
│ スプール名 : [             ]         │
│ 総長(mm)   : [        ]               │
│ 残り長(mm) : [        ]               │
│                       [OK] [キャンセル] │
└────────────────────────────────────┘
```

スプール名、総長さ、残り長さを入力して登録すると、印刷履歴カードのスプール一覧から選択できるようになります。旧バージョンで作成したデータは起動時に自動的に新形式へ変換されるため、そのまま利用可能です。

さらに `dashboard_spool.js` の `addSpool` 関数に `manufacturerName` や `materialName` などのオプションを渡すことで、メーカー名や素材種別をカスタム登録できます。

## License
This project is licensed under the MIT License. See [LICENSE](LICENSE).

## Copyright
(C) pumpCurry
