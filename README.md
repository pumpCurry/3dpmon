# 3dpmon

[![安定版をダウンロード](https://img.shields.io/github/v/release/pumpCurry/3dpmon?style=for-the-badge&label=Stable%20release&color=2f86eb)](https://github.com/pumpCurry/3dpmon/releases/latest)

3dpmon は、複数台の3Dプリンタを一つのダッシュボードで監視・管理するブラウザ / Electron アプリです。Creality K1系の既存監視に加え、Printer Core v3 では K2 Pro Combo / CFS の監視、外部スプールとCFSスロットを分離した read-only フィラメント表示、K2 WebRTCカメラ、CFS割当つき print-start guard を段階的に統合しています。

Moonraker / IR3 V2 系は、K1/K2固有の identity / control path へ混ぜず、別protocol pathとして扱います。

## 日本語

### 現在の対応範囲

| 系統 | 監視 | カメラ | フィラメント供給 | 印刷開始 | CFS単体操作 |
| --- | --- | --- | --- | --- | --- |
| Creality K1 / K1C / K1 Max系 | 対応 | MJPEG | 外部スプール | 既存経路 | 対象外 |
| K2 Pro Combo / CFS | 対応 | WebRTC | 外部スプール + CFS 0-4台 read-only | guarded CFS-aware path | 無効 |
| K1C + CFS-C | 実装土台あり / 実機certification待ち | 機種依存 | read-only provider土台あり | certification待ち | 無効 |
| Moonraker / IR3 V2 | 別protocol pathで対応 | Moonraker系経路 | K1/K2 CFS authorityとは分離 | 別経路 | 対象外 |

### v2.2.1044 Release Candidate

> [!IMPORTANT]
> v2.2.1044 は Release Candidate / pre-release です。CFS/CFS-C の standalone load / unload / feed / retract / slot select は有効ではありません。K2/CFS print-start は guarded / certification continuing として扱います。

v2.2.1044 RC では、K2 Pro Combo / CFS の監視、CFS slot観測、K2 WebRTCカメラ、K2ファイル一覧 / 印刷履歴互換、CFS割当つき印刷開始ガード、Hybrid Filament UI / CFS Debug・Certification panel を統合しています。詳細は [docs/release-notes-v2.2.1044.md](docs/release-notes-v2.2.1044.md) と [CHANGELOG.md](CHANGELOG.md) を参照してください。

### 既知の制限

- CFS/CFS-C の load / unload / feed / retract / slot select は、実機certificationを module-owned registry へ追加するまでproduction操作へ昇格しません。
- Creality純正RFIDフィラメント以外では、機器から残量が報告されない場合があります。その場合、3DPmon側の台帳管理で残量を扱う必要があります。
- K1C + CFS-C の実機certification、K2/CFS attach / detach / runout / reconnect の長時間確認は継続作業です。
- v2.2.0 以降は v1.x / v2.0 旧フォーマットのインポートをサポートしません。旧バージョンからアップグレードする場合は [v2.1.017 LTS](https://github.com/pumpCurry/3dpmon/releases/tag/v2.1.017-LTS) を経由してください。

### ダウンロード

- 安定版: [最新安定リリース](https://github.com/pumpCurry/3dpmon/releases/latest)
- Release Candidate: [v2.2.1044 pre-release](https://github.com/pumpCurry/3dpmon/releases/tag/v2.2.1044)
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
- [docs/future.md](docs/future.md): 将来計画
- [docs/develop/printer-core-v3-open-work.md](docs/develop/printer-core-v3-open-work.md): Printer Core v3 の残作業

### ライセンス

3dpmon は **修正 BSD License (3 条項 BSD ライセンス)** の下で公開されています。著作権は *5r4ce2* の **pumpCurry** が保有します。詳細は [https://542.jp/](https://542.jp/) を参照してください。連絡先は X(Twitter) の [@pcb](https://twitter.com/pcb) です。

---

# 3dpmon

[![Download stable release](https://img.shields.io/github/v/release/pumpCurry/3dpmon?style=for-the-badge&label=Stable%20release&color=2f86eb)](https://github.com/pumpCurry/3dpmon/releases/latest)

3dpmon is a browser / Electron dashboard for monitoring and managing multiple 3D printers. In addition to the existing Creality K1-family monitoring path, Printer Core v3 is gradually integrating K2 Pro Combo / CFS monitoring, read-only filament display that keeps the external spool separate from CFS slots, K2 WebRTC camera support, and guarded CFS-aware print start.

Moonraker / IR3 V2 devices stay on a separate protocol path and are not mixed into the K1/K2-specific identity or control authority.

## English

### Current Support Scope

| Family | Monitoring | Camera | Filament Supply | Print Start | Standalone CFS Control |
| --- | --- | --- | --- | --- | --- |
| Creality K1 / K1C / K1 Max family | Supported | MJPEG | External spool | Existing path | N/A |
| K2 Pro Combo / CFS | Supported | WebRTC | External spool + 0-4 CFS units, read-only | Guarded CFS-aware path | Disabled |
| K1C + CFS-C | Implementation foundation / live certification pending | Model dependent | Read-only provider foundation | Certification pending | Disabled |
| Moonraker / IR3 V2 | Supported through a separate protocol path | Moonraker-family path | Separate from K1/K2 CFS authority | Separate path | N/A |

### v2.2.1044 Release Candidate

> [!IMPORTANT]
> v2.2.1044 is a Release Candidate / pre-release. Standalone CFS/CFS-C load, unload, feed, retract, and slot select are not enabled. K2/CFS print start is treated as guarded / certification continuing.

v2.2.1044 RC integrates K2 Pro Combo / CFS monitoring, CFS slot observation, K2 WebRTC camera support, K2 file-list / print-history compatibility, guarded CFS-assigned print start, and the Hybrid Filament UI / CFS Debug and Certification panel. See [docs/release-notes-v2.2.1044.md](docs/release-notes-v2.2.1044.md) and [CHANGELOG.md](CHANGELOG.md) for details.

### Known Limitations

- CFS/CFS-C load, unload, feed, retract, and slot select cannot become production operations until live certification evidence is added to the module-owned registry.
- Non-RFID third-party filament may not report remaining percentage from the printer. In that case, remaining material should be managed by the 3DPmon spool ledger.
- K1C + CFS-C live certification and longer K2/CFS attach, detach, runout, and reconnect certification remain ongoing work.
- v2.2.0 and later do not support importing legacy v1.x / v2.0 storage formats. When upgrading from older releases, migrate through [v2.1.017 LTS](https://github.com/pumpCurry/3dpmon/releases/tag/v2.1.017-LTS).

### Downloads

- Stable: [Latest stable release](https://github.com/pumpCurry/3dpmon/releases/latest)
- Release Candidate: [v2.2.1044 pre-release](https://github.com/pumpCurry/3dpmon/releases/tag/v2.2.1044)
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
- [docs/future.md](docs/future.md): future plans
- [docs/develop/printer-core-v3-open-work.md](docs/develop/printer-core-v3-open-work.md): Printer Core v3 open work

### License

3dpmon is distributed under the **Modified BSD License (3-clause BSD License)**. Copyright is held by **pumpCurry** of *5r4ce2*. For details, visit [https://542.jp/](https://542.jp/). You can reach out via X (Twitter) at [@pcb](https://twitter.com/pcb).
