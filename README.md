# 3dpmon

[![Stable release](https://img.shields.io/github/v/release/pumpCurry/3dpmon?style=for-the-badge&label=Stable%20release&color=2f86eb)](https://github.com/pumpCurry/3dpmon/releases/latest)

3dpmon は、LAN上の複数の3Dプリンタを1つの画面から監視・管理する Windows Electron / ブラウザ ダッシュボードです。Creality K1 / K2 系、Moonraker / IR3 V2 系を同時に扱い、カメラ、温度、印刷状態、ファイル、履歴、フィラメント在庫と消費量をプリンタごとに確認できます。

English follows the Japanese section.

## 日本語

### できること

- 複数プリンタを同時に接続し、プリンタごとの独立パネルで監視できます。
- ライブカメラ、温度、ファン、LED、ヘッド位置、印刷進捗、残り時間を表示できます。
- G-code のアップロード、削除、印刷開始、pause / resume / stop などの対応済み操作を対象プリンタへ送れます。
- 印刷履歴、サムネイル、所要時間、使用量、成功率をプリンタ別に確認できます。
- フィラメントの在庫、装着中スプール、消費履歴、推定/確定残量を管理できます。
- K2 Pro Combo / CFS では、外部スプールと CFS スロットを分けて read-only 監視できます。
- Moonraker / IR3 V2 は、Creality K1/K2 の identity / control path とは別の protocol path で扱います。

### 現在の対応範囲

| 系統 | 監視 | カメラ | フィラメント供給 | 印刷開始 | CFS単体操作 |
| --- | --- | --- | --- | --- | --- |
| Creality K1 / K1C / K1 Max系 | 対応 | MJPEG | 外部スプール | 既存経路 | 対象外 |
| K2 Pro Combo / CFS | 対応 | WebRTC | 外部スプール + CFS 0-4台 read-only | guarded CFS-aware path | 無効 |
| K1C + CFS-C | 実装土台あり / 実機certification待ち | 機種依存 | read-only provider土台あり | certification待ち | 無効 |
| Moonraker / IR3 V2 | 別protocol pathで対応 | Moonraker系経路 | K1/K2 CFS authorityとは分離 | 別経路 | 対象外 |

### v2.2.1045 Release Candidate

> [!IMPORTANT]
> v2.2.1045 は Release Candidate / pre-release です。CFS/CFS-C の standalone load / unload / feed / retract / slot select は有効ではありません。K2/CFS print-start は、CFS slot観測と割当証跡が揃う場合だけ進む guarded path です。

v2.2.1045 RC では、v2.2.1044 のK2 Pro Combo / CFS監視、CFS slot観測、K2 WebRTCカメラ、CFS割当つき印刷開始ガード、Hybrid Filament UI / CFS Debug・Certification panel に加えて、K1 numeric / Creality OS / CFS のエラーコードを分けて扱う namespace-aware error catalog を追加しています。K2/CFSで `errcode=1001,key=2843` を受け取った場合、K1の「使用できないファイル形式」ではなく `FS2843 — RFIDを読み取れません` と表示します。詳細は [docs/release-notes-v2.2.1045.md](docs/release-notes-v2.2.1045.md) と [CHANGELOG.md](CHANGELOG.md) を参照してください。

### 既知の制限

- CFS/CFS-C の load / unload / feed / retract / slot select は、実機certificationを module-owned registry へ追加するまでproduction操作へ昇格しません。
- Creality純正RFIDフィラメント以外では、機器から残量が報告されない場合があります。その場合、3DPmon側のスプール台帳で残量を管理します。
- K1C + CFS-C の実機certification、K2/CFS attach / detach / runout / reconnect の長時間確認は継続作業です。
- v2.2.0 以降は v1.x / v2.0 旧フォーマットのインポートをサポートしません。旧バージョンからアップグレードする場合は [v2.1.017 LTS](https://github.com/pumpCurry/3dpmon/releases/tag/v2.1.017-LTS) を経由してください。

### ダウンロード

- 安定版: [最新安定リリース](https://github.com/pumpCurry/3dpmon/releases/latest)
- Release Candidate: [リリース一覧](https://github.com/pumpCurry/3dpmon/releases/) から v2.2.1045 pre-release を確認してください。
- すべてのバージョン一覧: <https://github.com/pumpCurry/3dpmon/releases/>

### インストール版（Windows・推奨）

1. [リリースページ](https://github.com/pumpCurry/3dpmon/releases/) を開きます。
2. 対象リリースの **Assets** から、以下のいずれかを入手します。
   - `3dpmon-<version>-setup.exe`: インストール版（推奨。スタートメニュー登録あり）
   - `3dpmon-<version>-portable.exe`: インストール不要のポータブル版
3. ダウンロードした exe を実行します。

> [!NOTE]
> 現在のインストーラは未署名のため、初回起動時に Windows SmartScreen の警告が表示される場合があります。「詳細情報」から実行してください。

### ソースから起動（開発者向け）

1. このリポジトリを取得します。
   - **Git**: `git clone https://github.com/pumpCurry/3dpmon.git`
   - **ZIP**: GitHub の **Code -> Download ZIP** から取得します。
2. Node.js 依存関係をインストールします。
   ```powershell
   npm install
   ```
3. Electron アプリとして起動します。
   ```powershell
   npm run start
   ```
4. ブラウザ版をソースから動かす場合は、簡易HTTPサーバーを起動して `http://localhost:8313/3dp_monitor.html` を開きます。
   ```powershell
   npm run start:http
   ```

### ドキュメント

- [docs/index.md](docs/index.md): ドキュメント索引
- [docs/ja/dashboard_usage.md](docs/ja/dashboard_usage.md): 基本的な使い方
- [docs/ja/feature_filament_management.md](docs/ja/feature_filament_management.md): フィラメント管理
- [docs/release-notes-v2.2.1045.md](docs/release-notes-v2.2.1045.md): v2.2.1045 リリースノート
- [docs/future.md](docs/future.md): 将来計画
- [docs/develop/printer-core-v3-open-work.md](docs/develop/printer-core-v3-open-work.md): Printer Core v3 の残作業

### ライセンス

3dpmon は **修正 BSD License (3 条項 BSD ライセンス)** の下で公開されています。著作権は *5r4ce2* の **pumpCurry** が保有します。詳細は [LICENSE](LICENSE) を参照してください。連絡先は X(Twitter) の [@pcb](https://twitter.com/pcb) です。

---

# 3dpmon

3dpmon is a Windows Electron / browser dashboard for monitoring and managing multiple 3D printers on a LAN. It supports Creality K1 / K2-family printers and Moonraker / IR3 V2-family printers through separated protocol paths, with camera views, temperatures, print status, file operations, print history, and filament inventory/usage tracking per printer.

## English

### What You Can Do

- Monitor multiple printers at the same time with independent per-printer panels.
- View live camera, temperatures, fans, LEDs, head position, print progress, and remaining time.
- Send supported operations such as G-code upload, delete, print start, pause, resume, and stop to the selected printer.
- Review print history, thumbnails, elapsed time, material usage, and success rate per printer.
- Manage filament inventory, mounted spools, usage history, and estimated/confirmed remaining material.
- Observe K2 Pro Combo / CFS material sources read-only while keeping the external spool separate from CFS slots.
- Keep Moonraker / IR3 V2 devices on a separate protocol path from Creality K1/K2 identity and control authority.

### Current Support Scope

| Family | Monitoring | Camera | Filament Supply | Print Start | Standalone CFS Control |
| --- | --- | --- | --- | --- | --- |
| Creality K1 / K1C / K1 Max family | Supported | MJPEG | External spool | Existing path | N/A |
| K2 Pro Combo / CFS | Supported | WebRTC | External spool + 0-4 CFS units, read-only | Guarded CFS-aware path | Disabled |
| K1C + CFS-C | Implementation foundation / live certification pending | Model dependent | Read-only provider foundation | Certification pending | Disabled |
| Moonraker / IR3 V2 | Supported through a separate protocol path | Moonraker-family path | Separate from K1/K2 CFS authority | Separate path | N/A |

### v2.2.1045 Release Candidate

> [!IMPORTANT]
> v2.2.1045 is a Release Candidate / pre-release. Standalone CFS/CFS-C load, unload, feed, retract, and slot select are not enabled. K2/CFS print start uses a guarded path and proceeds only when CFS slot observation and assignment evidence are available.

v2.2.1045 RC keeps the v2.2.1044 K2 Pro Combo / CFS monitoring, CFS slot observation, K2 WebRTC camera support, guarded CFS-assigned print start, and the Hybrid Filament UI / CFS Debug and Certification panel, and adds a namespace-aware Creality error catalog for K1 numeric, Creality OS, and CFS errors. When K2/CFS reports `errcode=1001,key=2843`, 3dpmon now shows `FS2843 — RFID cannot be read` instead of the K1-only unsupported-file-format message. See [docs/release-notes-v2.2.1045.md](docs/release-notes-v2.2.1045.md) and [CHANGELOG.md](CHANGELOG.md) for details.

### Known Limitations

- CFS/CFS-C load, unload, feed, retract, and slot select cannot become production operations until live certification evidence is added to the module-owned registry.
- Non-RFID third-party filament may not report remaining percentage from the printer. In that case, remaining material is managed by the 3DPmon spool ledger.
- K1C + CFS-C live certification and longer K2/CFS attach, detach, runout, and reconnect certification remain ongoing work.
- v2.2.0 and later do not support importing legacy v1.x / v2.0 storage formats. When upgrading from older releases, migrate through [v2.1.017 LTS](https://github.com/pumpCurry/3dpmon/releases/tag/v2.1.017-LTS).

### Downloads

- Stable: [Latest stable release](https://github.com/pumpCurry/3dpmon/releases/latest)
- Release Candidate: check [All releases](https://github.com/pumpCurry/3dpmon/releases/) for the v2.2.1045 pre-release.
- All releases: <https://github.com/pumpCurry/3dpmon/releases/>

### Installer (Windows, recommended)

1. Open the [Releases page](https://github.com/pumpCurry/3dpmon/releases/).
2. From the target release **Assets**, download one of:
   - `3dpmon-<version>-setup.exe`: installer, recommended, adds a Start-menu entry
   - `3dpmon-<version>-portable.exe`: portable build, no installation required
3. Run the downloaded exe.

> [!NOTE]
> The installer is currently unsigned, so Windows SmartScreen may warn on first launch. Use **More info** to run it.

### Run From Source (Developers)

1. Download this repository.
   - **Git**: `git clone https://github.com/pumpCurry/3dpmon.git`
   - **ZIP**: choose **Code -> Download ZIP** on GitHub.
2. Install Node.js dependencies.
   ```powershell
   npm install
   ```
3. Launch the Electron app.
   ```powershell
   npm run start
   ```
4. To run the browser version from source, start the local HTTP server and open `http://localhost:8313/3dp_monitor.html`.
   ```powershell
   npm run start:http
   ```

### Documentation

- [docs/index.md](docs/index.md): documentation index
- [docs/en/dashboard_usage.md](docs/en/dashboard_usage.md): basic usage
- [docs/en/feature_filament_management.md](docs/en/feature_filament_management.md): filament management
- [docs/release-notes-v2.2.1045.md](docs/release-notes-v2.2.1045.md): v2.2.1045 release notes
- [docs/future.md](docs/future.md): future plans
- [docs/develop/printer-core-v3-open-work.md](docs/develop/printer-core-v3-open-work.md): Printer Core v3 open work

### License

3dpmon is distributed under the **Modified BSD License (3-clause BSD License)**. Copyright is held by **pumpCurry** of *5r4ce2*. See [LICENSE](LICENSE) for details. You can reach out via X (Twitter) at [@pcb](https://twitter.com/pcb).
