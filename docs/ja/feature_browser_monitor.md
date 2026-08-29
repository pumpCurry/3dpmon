# ブラウザ / Electron から 3Dプリンタを監視する

このドキュメントでは、3dpmon を利用して Creality シリーズ、K2 Pro Combo / CFS、Moonraker / IR3 V2 系の 3D プリンタをブラウザまたは Electron アプリ上で監視する方法を説明します。

## 対応範囲

| 系統 | 監視 | カメラ | フィラメント供給 | 印刷開始 | CFS単体操作 |
| --- | --- | --- | --- | --- | --- |
| Creality K1 / K1C / K1 Max系 | 対応 | MJPEG | 外部スプール | 既存経路 | 対象外 |
| K2 Pro Combo / CFS | 対応 | WebRTC | 外部スプール + CFS 0-4台 read-only | guarded CFS-aware path | 無効 |
| K1C + CFS-C | 実装土台あり / 実機certification待ち | 機種依存 | read-only provider土台あり | certification待ち | 無効 |
| Moonraker / IR3 V2 | 別protocol pathで対応 | Moonraker系経路 | K1/K2 CFS authorityとは分離 | 別経路 | 対象外 |

> [!IMPORTANT]
> v2.2.1044 RC では、CFS/CFS-C の standalone load / unload / feed / retract / slot select は有効ではありません。K2/CFS print-start は、CFS slot観測と割当証跡が揃う場合だけ進む guarded path です。

## 実行環境

- **Electron アプリ**: 推奨環境です。GridStack によるパネルの自由配置、ウィンドウサイズ保存、ネイティブ通知、K2 WebRTCカメラ表示を利用できます。
- **ブラウザ版**: 開発・確認用に `npm run start:http` でローカルHTTPサーバーを起動し、`http://localhost:8313/3dp_monitor.html` を開きます。

## 基本的な接続フロー

1. アプリを起動します。
2. **環境設定** を開き、プリンタの IP アドレスとポート（Creality K1/K2系は通常 `9999`）を入力して接続先を追加します。
3. プリンタ種別を選択します。K2 Pro Combo は K2系、IR3 V2 / Moonraker は Moonraker 系として登録します。
4. 接続に成功するとパネルにホスト名、状態、温度、カメラ、ファイル一覧、印刷履歴などが表示されます。
5. K2/CFS では、外部スプールと CFS 1A-4D のようなslotを混ぜずに、read-onlyのフィラメント供給として表示します。

## マルチプリンタ管理

3dpmon では複数のプリンタを同時に監視できます。

- **接続先の追加・削除・再接続**: 環境設定から複数のプリンタを登録し、個別に接続・切断・再接続できます。
- **接続状態インジケータ**: 各接続先の状態を接続中 / 切断 / 再接続中として表示します。
- **Per-host 接続カラー設定**: プリンタごとに識別用の色を割り当て、パネル上でどのプリンタの情報かを判別できます。
- **Per-host データ分離**: 各プリンタのデータは `monitorData.machines[hostname]` で独立管理され、データの混在を避けます。
- **Printer Core v3 identity dry-run**: K1/K2系では `/info` や WS9999 の観測から identity を推定します。Moonraker / IR3 V2 はこのK1/K2固有経路へ混ぜません。

## パネルシステム

監視情報は GridStack ベースのパネルとして表示されます。パネルは自由にドラッグ・リサイズでき、レイアウトは自動保存されます。パネルの追加はパネルメニューから行います。

K2/CFS では、通常のフィラメントカードに加えて、Hybrid Filament UI と CFS Debug / Certification panel により、read-only probe、preflight、dry-run payload、ARM状態、before/after evidence、protocol event export を分離して確認できます。ただし、LIVE SEND やCFS単体操作は実機certificationが完了するまでproduction操作として有効化されません。

## 接続がうまくいかない場合

- IP アドレスが正しいか、プリンタと同じネットワークに接続されているか確認してください。
- Creality K1/K2系の WebSocket ポートは通常 `9999` です。変更している場合は環境設定で調整してください。
- K2 WebRTCカメラは、`/info` の値をidentity/transport evidenceとして保持しつつ、実際のカメラ接続は観測済みのWebRTC camera serviceへ接続します。
- CFS情報が stale / 未観測の場合、表示は最後に観測した状態として扱われます。現在値と誤認しないよう、画面上の状態表示を確認してください。
- 接続が切れた場合は自動再接続が試みられます。手動で再接続する場合は環境設定から操作してください。

ブラウザまたは Electron アプリでの監視により、離れた場所からでも複数プリンタの状態を同時に確認できます。
