# 3dpmon Operation Guide / 操作ガイド

## Operating Specifications (English)
- Browser-based dashboard for monitoring Clarity K1 series 3D printers
- Communicates with the printer via WebSocket on port 9999
- Displays camera stream, temperature chart and print status in real time
- Includes remote commands, file management and notification system
- Settings and history are stored in the browser
- Preparation time, first-layer check time, pause duration and filament
  information are included in the print history

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
- 準備時間、1層目確認時間、一時停止時間、使用フィラメント情報も
  印刷履歴に記録されます

## 操作説明 (Japanese)
1. リポジトリをダウンロードし、任意のフォルダに配置します
2. 静的 HTTP サーバーを起動します。例:
   ```
   python -m http.server 8000
   ```
3. ブラウザで `http://localhost:8000/3dp_monitor.html` を開きます
4. 右上の入力欄にプリンタの IP アドレスを入力して「接続」をクリック
5. ダッシュボード上で状態確認や操作を行います

## First Connection
When launching the dashboard for the first time there is no saved
network configuration. Enter the printer's IP address or hostname in
the field at the top right and click **Connect**. The port is selected
automatically for supported models (K1 and K2 series), so normally only
the IP is required. Camera images currently stream from port `8080` and
support for `8000` is under development.

## Unlocking Audio
Most browsers block audio playback until the user interacts with the
page. Click anywhere on the start screen to unlock sound effects and
voice playback. A small control with music and voice icons appears in
the lower right corner. If the icons show a slash, audio is disabled;
when they show a circle, notifications will play sounds. These settings
can be customized from the **Settings** card.

## Screen Overview
All information provided by the printer is displayed on the dashboard.
The main monitor card shows the camera feed and print controls, while
other cards allow file management, temperature adjustments and various
settings.

## Dashboard Layout
- **Title Bar** – Shows the printer hostname and print state. Enter the
  destination IP here and use the Connect/Disconnect buttons. A mute
  indicator appears if sound is disabled.
- **Monitor Card** – Combines the camera feed, head position preview and
  print controls. Here you can pause or stop printing, adjust nozzle and
  bed temperatures and toggle fans or the LED light.
- **Temperature Graph** – Displays a live chart of nozzle and bed
  temperatures.
- **Info Card** – Lists machine limits, model details and overall usage
  statistics.
- **Log Card** – Shows received messages and errors in separate tabs with
  buttons to copy the logs.
- **Print History Card** – Contains a history of completed jobs and a
  file list tab with upload controls for G-code files.
- **Settings Card** – Provides storage settings, notification options and
  a command palette for frequently used commands.

---

## 初回接続手順 (Japanese)
起動直後はネットワーク設定が保存されていません。右上の入力欄に
プリンタの IP アドレスまたはホスト名を入力し、**接続** ボタンを
押してください。対応機種(K1/K2 シリーズ)ではポートは自動設定さ
れるため、IP のみで接続できます。カメラ映像は現在 `8080` ポート
のみ対応しており、`8000` は準備中です。

## 音声のアンロックとカスタマイズ (Japanese)
ブラウザの仕様により、ユーザーが画面をクリックするまで音声を再生
できません。起動画面のどこでもクリックするとアンロックされ、右下
に音楽と音声のアイコンが表示されます。アイコンが斜線付きの場合は
無効、丸印なら有効で、通知時に音声や効果音が再生されます。設定
カードから好みに合わせてカスタマイズできます。

## 画面説明 (Japanese)
監視カードではカメラ映像と印刷操作をまとめて表示し、その他のカー
ドでファイル管理や温度調整、各種設定が行えます。プリンタから得ら
れる情報はすべてダッシュボード上に表示されます。

## 画面構成
- **タイトルバー** – プリンタ名や印刷状態を表示し、接続先 IP 入力欄と接続/切断ボタンがあります。音声が無効な場合はミュート表示が出ます。
- **監視カード** – カメラ映像、ヘッド位置プレビュー、印刷状態テーブル、停止・一時停止ボタンなどをまとめています。ノズルやベッド温度の調整、各ファンや LED の切り替えも行えます。
- **温度グラフ** – ノズルとベッドの温度推移を折れ線グラフで表示します。
- **機器情報カード** – 加速度制限やモデル情報、使用統計を確認できます。
- **ログカード** – 受信ログと通知ログをタブで切り替え、コピー用ボタンも備えています。
- **印刷履歴カード** – 印刷履歴一覧とファイル一覧タブがあり、G-code アップロードも可能です。
- **設定カード** – ストレージ設定や通知設定、コマンドパレットなどをまとめたエリアです。
