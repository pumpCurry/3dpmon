# 3dpmon

ブラウザから Clarity シリーズ 3D プリンタを監視するためのダッシュボードです。詳細な説明は [docs/index.md](docs/index.md) を参照してください。

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
5. ブラウザで `http://localhost:8000/3dp_monitor.html` を開きます。

---

# 3dpmon

This is a browser-based dashboard for monitoring the Clarity series of 3D printers. For detailed documentation see [docs/index.md](docs/index.md).

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
5. Navigate to `http://localhost:8000/3dp_monitor.html` in your browser.
