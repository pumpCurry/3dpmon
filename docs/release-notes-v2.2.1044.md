# 3dpmon v2.2.1044 リリースノート

## 日本語

3dpmon v2.2.1044 は、K2 Pro Combo / CFS を中心に、Printer Core v3 の監視、CFS対応印刷開始ガード、安全な操作準備、K2 WebRTCカメラ表示をまとめたリリース候補です。v2.2.1043 は既存pre-releaseと重なるため、本リリース候補は v2.2.1044 として扱います。

### 主な変更

- K2 Pro Combo / CFS の `/info`、WS9999、`boxsInfo`、WebRTCカメラ検出を強化しました。
- K2/CFS のフィラメント供給を、外部スプールとCFSスロットを混ぜずに表示できるようにしました。
- CFS / CFS-C は 0台から4台まで、外部スプールを含めて最大17巻構成を表示できる設計になりました。
- CFSスロットの色、残量、装填状態、機器選択状態、`T1A` などの割当観測を、通常フィラメント管理とは別の read-only 観測情報として蓄積します。
- K2/CFS のファイル印刷では、旧来の `opGcodeFile` 直投げではなく、`colorMatch` から `multiColorPrint` へ進む明示的なCFS割当経路を追加しました。この経路は空走り防止のため、CFS slotの観測と割当が揃う場合だけ使う guarded path として扱います。
- CFS情報が未観測、古い、または装填済みスロットを確認できない場合は、空走り防止のためCFS印刷開始を拒否します。
- K2カメラのWebRTC表示とパネル内の映像収まりを改善しました。
- カメラ接続中表示のスピナーがカード幅や文字折り返しで楕円に歪まないよう、カメラ専用スピナーとして正方形寸法を固定しました。
- K2のファイル一覧、印刷履歴、サムネイル表示の互換性を改善しました。
- 通常のフィラメント監視カードとは別に、開発者/テスター向けの CFS Debug / Certification panel を追加しました。read-only probe、preflight、dry-run payload、ARM状態、before/after evidence、protocol event export を分離して確認できます。
- Printer Core v3 のCFS操作UI状態を追加しました。ただし v2.2.1044 では、CFS/CFS-C の standalone load / unload / feed / retract / slot select はすべて無効です。
- 再起動後は、保存済みの古い `/info` やCFS観測だけでCFS操作を復活させず、現在起動中の再probeと新しいCFS観測が揃うまで操作を無効化します。

### 注意事項

- v2.2.1044 の module-owned certification registry は空です。保存済み設定やUI表示だけで、CFS/CFS-C の standalone load / unload / feed / retract / slot select が有効になることはありません。
- CFS Debug / Certification panel の LIVE SEND は、v2.2.1044 ではproduction commandとして有効化されません。timeout / unknown時のside-effect command自動retryも行いません。
- K2/CFS print-start は guarded / certification continuing として扱います。実機での print-start、CFS feed、押出、完了までの証跡は継続してGate 21で確認します。
- Creality純正RFIDフィラメント以外では、機器から残量が報告されない場合があります。その場合、3DPmon側の台帳管理で残量を扱う必要があります。
- K1C + CFS-C の実機certification、K2/CFS attach / detach / runout / reconnect の長時間確認は継続作業です。

### 検証

- ローカル: `npx vitest run tests/unit/dashboard_camera_spinner_css.test.js tests/unit/dashboard_camera_ctrl.test.js tests/unit/dashboard_camera_ctrl_dedup.test.js`
- ローカル: `npm run verify:release`
- GitHub Actions: lint / smoke / test / e2e / version-sync

### ビルド成果物

- `3dpmon-2.2.1044-setup.exe`
- `3dpmon-2.2.1044-portable.exe`
- `3dpmon-2.2.1044-setup.exe.blockmap`
- `release-manifest-2.2.1044.json`

公開時は `release-manifest-2.2.1044.json` を添付し、最終commit、build日時、各成果物のSHA256をmanifestで確認できるようにします。

## English

3dpmon v2.2.1044 is a release-candidate build focused on Printer Core v3 monitoring, K2 Pro Combo / CFS support, guarded CFS-aware print start, safer command-readiness foundations, and K2 WebRTC camera display. Because v2.2.1043 overlaps with an existing pre-release, this release candidate is published as v2.2.1044.

### Highlights

- Improved K2 Pro Combo / CFS detection through `/info`, WS9999, `boxsInfo`, and WebRTC camera hints.
- Displays K2/CFS filament supply without mixing the external spool and CFS slots.
- Supports the planned display model for 0 to 4 CFS/CFS-C units, plus the external spool, up to 17 visible material sources.
- Stores CFS slot color, remaining percentage, loaded state, printer-selected state, and `T1A`-style assignment evidence as read-only material observations separate from the 3DPmon spool ledger.
- Adds an explicit K2/CFS print-start path using `colorMatch` followed by `multiColorPrint`, instead of legacy direct `opGcodeFile` submission. This remains a guarded path that is used only when CFS slot observation and assignment evidence are available.
- Blocks CFS print start when CFS topology is stale, unobserved, or no loaded CFS slot can be verified, reducing the risk of dry-run-like printing without filament.
- Improves K2 WebRTC camera display and video fitting inside dashboard panels.
- Keeps the camera connection spinner circular by using a dedicated fixed-size camera spinner class that cannot be stretched by card width or text wrapping.
- Improves compatibility for K2 file lists, print history, and thumbnail paths.
- Adds a developer/tester-facing CFS Debug / Certification panel separate from the regular filament monitoring card. It separates read-only probe, preflight, dry-run payload, ARM state, before/after evidence, and protocol event export.
- Adds Printer Core v3 CFS command UI states. In v2.2.1044, standalone CFS/CFS-C load, unload, feed, retract, and slot select operations are all disabled.
- After restart, production CFS controls stay disabled until the current runtime re-probes `/info` and observes fresh CFS topology; stale persisted evidence alone is not enough to re-enable control.

### Notes

- The v2.2.1044 module-owned certification registry is empty. Saved settings or visible UI state cannot enable standalone CFS/CFS-C load, unload, feed, retract, or slot select operations.
- LIVE SEND in the CFS Debug / Certification panel is not enabled as a production command in v2.2.1044. Side-effect commands are not retried automatically after timeout or unknown results.
- K2/CFS print start is treated as guarded / certification continuing. Gate 21 will continue collecting evidence for print start, CFS feed, extrusion, and job completion on real hardware.
- Non-RFID third-party filament may not report remaining percentage from the printer. In that case, remaining material should be managed by the 3DPmon spool ledger.
- K1C + CFS-C live certification and longer K2/CFS attach, detach, runout, and reconnect certification remain ongoing work.

### Verification

- Local: `npx vitest run tests/unit/dashboard_camera_spinner_css.test.js tests/unit/dashboard_camera_ctrl.test.js tests/unit/dashboard_camera_ctrl_dedup.test.js`
- Local: `npm run verify:release`
- GitHub Actions: lint / smoke / test / e2e / version-sync

### Build Artifacts

- `3dpmon-2.2.1044-setup.exe`
- `3dpmon-2.2.1044-portable.exe`
- `3dpmon-2.2.1044-setup.exe.blockmap`
- `release-manifest-2.2.1044.json`

The release will include `release-manifest-2.2.1044.json` so the final commit, build timestamp, and SHA256 for each artifact can be verified from the manifest.
