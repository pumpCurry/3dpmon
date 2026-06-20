# 3dpmon

[![最新リリースをダウンロード (.exe)](https://img.shields.io/github/v/release/pumpCurry/3dpmon?style=for-the-badge&label=Download%20.exe&color=2f86eb)](https://github.com/pumpCurry/3dpmon/releases/latest)

- ブラウザから CREALITY K1シリーズ 3D プリンタを **複数台同時に** 監視するためのダッシュボードです。詳細な説明は [docs/index.md](docs/index.md) を参照してください。将来計画は [docs/future.md](docs/future.md) にまとめています。
- K1 Max 複数台の並行監視・制御に対応しています。
  - 対応機種は K1C / K1 Max で動作確認をしています。
  - ほかの機種にも対応可能であれば対応させたいので、ご協力くださるかたどうかよろしくお願いいたします。
- **v2.2.001 (最新)** — 旧データ構造サポートを完全終了し、レガシーコード 266 行を削除。コスト分析エンジン・統計ダッシュボード 3 種・DHCP/IP 遷移対策を搭載。Electron 起動テスト + 実機 2 台スモークテスト + 257 件ユニットテスト通過。
- **v2.1.017 (LTS)** — 旧バージョン(v2.1.009以前)からのアップグレードが必要な場合は、[v2.1.017 LTS](https://github.com/pumpCurry/3dpmon/releases/tag/v2.1.017-LTS) を経由してください。v2.2.0 以降は v1.x/v2.0 旧フォーマットのインポートをサポートしません。
- 変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。
## インストール

> [!TIP]
> **インストーラ（exe）版があります。コードから動かす必要はありません。**
> 👉 **ダウンロードはこちら → <https://github.com/pumpCurry/3dpmon/releases/latest>**
> すべてのバージョン一覧： <https://github.com/pumpCurry/3dpmon/releases/>

### インストール版（Windows・推奨）
1. [リリースページ](https://github.com/pumpCurry/3dpmon/releases/) を開きます。
2. 最新リリースの **Assets** から、以下のいずれかを入手します。
   - `3dpmon-<version>-setup.exe` … インストール版（推奨。スタートメニュー登録あり）
   - `3dpmon-<version>-portable.exe` … インストール不要のポータブル版
3. ダウンロードした exe を実行します。
   > ⚠️ 現在のインストーラは未署名のため、初回起動時に Windows SmartScreen の警告が表示されます。**「詳細情報」→「実行」** で起動できます（仕様です）。

### ソースから起動（開発者向け）
ブラウザ版をソースから動かす場合：
1. このリポジトリを取得します。
   - **Git**: `git clone https://github.com/pumpCurry/3dpmon.git`
   - **ZIP**: GitHub の **Code → Download ZIP** から取得します。
2. Python 3 をインストールすると運用が楽です（簡易 HTTP サーバを動かすためだけに使います）。
   - **Windows**: Microsoft Store の [Python 3.13](https://apps.microsoft.com/detail/9pnrbtzxmb4z)
   - **Linux**: 多くのディストリビューションでは `python3` パッケージが利用可能です。
   - **macOS**: 付属の Python 3 を使用するか [python.org](https://www.python.org/) から入手します。
3. ターミナルで展開したフォルダに移動し、簡易 HTTP サーバーを起動します（Windows は同梱の `start.bat` をダブルクリックでも可）。
   ```
   python -m http.server 8000
   ```
4. ブラウザで `http://localhost:8000/3dp_monitor.html` を開きます。
5. Electron パッケージとして起動する場合は、`npm install` 後に `npm run electron` を実行します。

## ライセンス
3dpmon は **修正 BSD License (3 条項 BSD ライセンス)** の下で公開されています。著作権は *5r4ce2* の **pumpCurry** が保有します。詳細は [https://542.jp/](https://542.jp/) を参照してください。連絡先は X(Twitter) の [@pcb](https://twitter.com/pcb) です。

---

# 3dpmon

This is a browser-based dashboard for monitoring **multiple** CREALITY K1-series 3D printers simultaneously. For detailed documentation see [docs/index.md](docs/index.md). Information about upcoming features is available in [docs/future.md](docs/future.md). See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## Installation

> [!TIP]
> **A prebuilt installer (.exe) is available — you don't need to run from source.**
> 👉 **Download here → <https://github.com/pumpCurry/3dpmon/releases/latest>**
> All releases: <https://github.com/pumpCurry/3dpmon/releases/>

### Installer (Windows, recommended)
1. Open the [Releases page](https://github.com/pumpCurry/3dpmon/releases/).
2. From the latest release **Assets**, grab one of:
   - `3dpmon-<version>-setup.exe` — installer (recommended; adds a Start-menu entry)
   - `3dpmon-<version>-portable.exe` — portable, no installation required
3. Run the downloaded exe.
   > ⚠️ The installer is currently unsigned, so Windows SmartScreen will warn on first launch. Click **More info → Run anyway** (this is expected).

### Run from source (developers)
To run the browser version from source:
1. Download this repository.
   - **Git**: `git clone https://github.com/pumpCurry/3dpmon.git`
   - **ZIP**: choose **Code → Download ZIP** on GitHub.
2. Install Python 3 if it is not already available (used only for a simple HTTP server):
   - **Windows**: Microsoft Store [Python 3.13](https://apps.microsoft.com/detail/9pnrbtzxmb4z)
   - **Linux**: most distributions provide the `python3` package.
   - **macOS**: use the bundled Python or install from [python.org](https://www.python.org/).
3. Open a terminal in the extracted folder and launch a simple HTTP server (on Windows you can also run `start.bat`):
   ```
   python -m http.server 8000
   ```
4. Navigate to `http://localhost:8000/3dp_monitor.html` in your browser.
5. To run as an Electron package, run `npm install` then `npm run electron` (or `start.bat`).


## License
3dpmon is distributed under the **Modified BSD License (3-clause BSD License)**. Copyright is held by **pumpCurry** of *5r4ce2*. For details, visit [https://542.jp/](https://542.jp/). You can reach out via X (Twitter) at [@pcb](https://twitter.com/pcb).
