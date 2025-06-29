# 3dpmon

- ブラウザから CREALITY K1シリーズ 3D プリンタを監視するためのダッシュボードです。詳細な説明は [docs/index.md](docs/index.md) を参照してください。将来計画は [docs/future.md](docs/future.md) にまとめています。
- 現時点ではK1 Max複数台を制御することを目標としています。
  - 対応機種はK1C / K1 Max で動作確認をしています。
  - ほかの機種にも対応可能であれば対応させたいので、ご協力くださるかたどうかよろしくお願いいたします。
  - TitleBar コンポーネントの仕様は [docs/develop/titlebar.md](docs/develop/titlebar.md) にまとめています。

The console should display echoed JSON via the new ConnectionManager.
## インストール
1. このリポジトリをダウンロードします。
   - **Git**: `git clone https://github.com/pumpCurry/3dpmon.git`
   - **ZIP**: GitHub の **Code → Download ZIP** から取得します。
2. Python 3 をインストールします。
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

This is a browser-based dashboard for monitoring the Clarity series of 3D printers. For detailed documentation see [docs/index.md](docs/index.md). Information about upcoming features is available in [docs/future.md](docs/future.md).

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

## Development (v2 skeleton)
To try the new Vite-based dashboard:
1. Install Node packages: `npm install`
2. In one terminal run `npm run mock` to start a local echo server.
3. In another terminal run `npm run dev` and open `http://localhost:5173`.
The console should display echoed JSON via the new ConnectionManager.
## Run tests
Unit tests are executed with [Vitest](https://vitest.dev/).

1. Install Node packages: `npm install`
2. Run `npm test`

See [docs/develop/tests.md](docs/develop/tests.md) for coverage goals and additional details.

## Keyboard Shortcuts
HeadPreviewCard supports the following keys:
- **Space**: reset zoom to 1.0
- **?**: show help dialog

## Codex Task Execution
To run this project within OpenAI Codex tasks, set the setup script path to `run/codex/setup.sh` and enable internet access only for that step. Required environment variables are `NODE_ENV=ci` and `CI=true`. Details are described in [docs/develop/codex_setup.md](docs/develop/codex_setup.md).


## License
3dpmon is distributed under the **Modified BSD License (3-clause BSD License)**. Copyright is held by **pumpCurry** of *5r4ce2*. For details, visit [https://542.jp/](https://542.jp/). You can reach out via X (Twitter) at [@pcb](https://twitter.com/pcb).
