# 3dpmon Operation Guide / 操作ガイド

## Operating Specifications (English)
- Browser-based dashboard for monitoring Clarity K1 series 3D printers
- Communicates with the printer via WebSocket on port 9999
- Displays camera stream, temperature chart and print status in real time
- Includes remote commands, file management and notification system
- Settings and history are stored in the browser

## Usage (English)
1. Download this repository and place the files in a folder
2. Launch a static HTTP server, e.g.:
   ```
   python -m http.server 8000
   ```
3. Open `http://localhost:8000/3dp_monitor.html` in your browser
4. Enter your printer's IP address in the top right field and click "Connect"
5. Use the dashboard to monitor and control the printer

---

## 動作仕様 (Japanese)
- Clarity K1/K1C/K1A/K1 Max シリーズに対応したブラウザベースの監視ツール
- WebSocket (標準ポート 9999) を利用してプリンタと通信
- カメラ映像、温度グラフ、印刷状態をリアルタイム表示
- 遠隔操作、ファイル管理、通知機能を搭載
- 設定や履歴はブラウザのローカルストレージに保存されます

## 操作説明 (Japanese)
1. リポジトリをダウンロードし、任意のフォルダに配置します
2. 静的 HTTP サーバーを起動します。例:
   ```
   python -m http.server 8000
   ```
3. ブラウザで `http://localhost:8000/3dp_monitor.html` を開きます
4. 右上の入力欄にプリンタの IP アドレスを入力して「接続」をクリック
5. ダッシュボード上で状態確認や操作を行います
