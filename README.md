# 3dpmon

- ブラウザから CREALITY K1シリーズ 3D プリンタを **複数台同時に** 監視するためのダッシュボードです。詳細な説明は [docs/index.md](docs/index.md) を参照してください。将来計画は [docs/future.md](docs/future.md) にまとめています。
- K1 Max 複数台の並行監視・制御に対応しています。
  - 対応機種は K1C / K1 Max で動作確認をしています。
  - ほかの機種にも対応可能であれば対応させたいので、ご協力くださるかたどうかよろしくお願いいたします。
- v2.1.008 で **UI統合・品質改善・バグ修正** を実施しました。アップロードダイアログ統合（ボタン/D&D/重複の全パス統一）、印刷確認ダイアログの推定値修正（失敗印刷の過少申告を排除）、レイアウトテンプレート（1台/2台/4台）、FOUC防止スプラッシュ画面、Electron音声自動再生バイパス、completionElapsedTimeレースコンディション修正、per-hostフィラメント更新修正など40+件の修正を実施しました。変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。
## インストール
1. このリポジトリをダウンロードします。
   - **Git**: `git clone https://github.com/pumpCurry/3dpmon.git`
   - **ZIP**: GitHub の **Code → Download ZIP** から取得します。
2. Python 3 をインストールすると運用が楽です(簡易httpサーバを動かすためだけに使います)
   - **Windows**: Microsoft Store の [Python 3.13](https://apps.microsoft.com/detail/9pnrbtzxmb4z)
   - **Linux**: 多くのディストリビューションでは `python3` パッケージが利用可能です。
   - **macOS**: 付属の Python 3 を使用するか [python.org](https://www.python.org/) から入手します。
3. ターミナルで展開したフォルダに移動します。
4. 簡易 HTTP サーバーを起動します:
   ```
   python -m http.server 8000
   ```
   Windows の場合は同梱の `start.bat` をダブルクリックしても起動できます。
5. ブラウザで `http://localhost:8000/3dp_monitor.html` を開きます。

## ライセンス
3dpmon は **修正 BSD License (3 条項 BSD ライセンス)** の下で公開されています。著作権は *5r4ce2* の **pumpCurry** が保有します。詳細は [https://542.jp/](https://542.jp/) を参照してください。連絡先は X(Twitter) の [@pcb](https://twitter.com/pcb) です。

---

# 3dpmon

This is a browser-based dashboard for monitoring **multiple** CREALITY K1-series 3D printers simultaneously. For detailed documentation see [docs/index.md](docs/index.md). Information about upcoming features is available in [docs/future.md](docs/future.md). See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## Installation
1. Download this repository.
   - **Git**: `git clone https://github.com/pumpCurry/3dpmon.git`
   - **ZIP**: choose **Code → Download ZIP** on GitHub.
2. Install Python 3 if it is not already available:
   - **Windows**: Microsoft Store [Python 3.13](https://apps.microsoft.com/detail/9pnrbtzxmb4z)
   - **Linux**: most distributions provide the `python3` package.
   - **macOS**: use the bundled Python or install from [python.org](https://www.python.org/).
3. Open a terminal and change to the extracted folder.
4. Launch a simple HTTP server:
   ```
   python -m http.server 8000
   ```
   On Windows you can also run `start.bat` to launch the server.
5. Navigate to `http://localhost:8000/3dp_monitor.html` in your browser.

## Electron モード
Electron パッケージでの起動にも対応しています。
1. `npm install`
2. `npm run electron` (または `start.bat`)


## License
3dpmon is distributed under the **Modified BSD License (3-clause BSD License)**. Copyright is held by **pumpCurry** of *5r4ce2*. For details, visit [https://542.jp/](https://542.jp/). You can reach out via X (Twitter) at [@pcb](https://twitter.com/pcb).
