# 3dpmon v2.2.1042 リリースノート案

## 日本語

3dpmon v2.2.1042 は、K2 Pro Combo / CFS を中心に、Printer Core v3 の監視・CFS印刷開始・安全な操作準備を進めたリリース候補です。

### 主な変更

- K2 Pro Combo / CFS の `/info`、WS9999、`boxsInfo`、WebRTCカメラ検出を強化しました。
- K2/CFS のフィラメント供給を、外部スプールとCFSスロットを混ぜずに表示できるようにしました。
- CFS / CFS-C は 0台から4台まで、外部スプールを含めて最大17巻構成を表示できる設計になりました。
- CFSスロットの色、残量、装填状態、機器選択状態、`T1A` などの割当観測を、通常フィラメント管理とは別の read-only 観測情報として蓄積します。
- K2/CFS のファイル印刷では、旧来の `opGcodeFile` 直投げではなく、`colorMatch` から `multiColorPrint` へ進む明示的なCFS割当経路を追加しました。
- CFS情報が未観測、古い、または装填済みスロットを確認できない場合は、空走り防止のためCFS印刷開始を拒否します。
- K2カメラのWebRTC表示とパネル内の映像収まりを改善しました。
- K2のファイル一覧、印刷履歴、サムネイル表示の互換性を改善しました。
- Printer Core v3 のCFS操作UIを追加しました。ただし実機certificationが完了していない操作は fail-closed のままです。
- 再起動後は、保存済みの古い `/info` やCFS観測だけでCFS操作を復活させず、現在起動中の再probeと新しいCFS観測が揃うまで操作を無効化します。

### 注意事項

- CFS/CFS-C の load / unload / feed / retract / slot select は、実機ごとのcertificationが完了した操作だけが有効化されます。
- Creality純正RFIDフィラメント以外では、機器から残量が報告されない場合があります。その場合、3DPmon側の台帳管理で残量を扱う必要があります。
- K1C + CFS-C の実機certification、K2/CFS attach / detach / runout / reconnect の長時間確認は継続作業です。

### 検証

- ローカル: `npx vitest run --reporter=dot --silent`
- ローカル: `npm run test:e2e`
- ローカル: `npm run build`
- GitHub Actions: lint / smoke / test

## English

3dpmon v2.2.1042 is a release-candidate build focused on Printer Core v3 monitoring, K2 Pro Combo / CFS support, CFS-aware print start, and safer command-readiness foundations.

### Highlights

- Improved K2 Pro Combo / CFS detection through `/info`, WS9999, `boxsInfo`, and WebRTC camera hints.
- Displays K2/CFS filament supply without mixing the external spool and CFS slots.
- Supports the planned display model for 0 to 4 CFS/CFS-C units, plus the external spool, up to 17 visible material sources.
- Stores CFS slot color, remaining percentage, loaded state, printer-selected state, and `T1A`-style assignment evidence as read-only material observations separate from the 3DPmon spool ledger.
- Adds an explicit K2/CFS print-start path using `colorMatch` followed by `multiColorPrint`, instead of legacy direct `opGcodeFile` submission.
- Blocks CFS print start when CFS topology is stale, unobserved, or no loaded CFS slot can be verified, reducing the risk of dry-run-like printing without filament.
- Improves K2 WebRTC camera display and video fitting inside dashboard panels.
- Improves compatibility for K2 file lists, print history, and thumbnail paths.
- Adds Printer Core v3 CFS command UI states. Operations that are not live-certified remain fail-closed.
- After restart, production CFS controls stay disabled until the current runtime re-probes `/info` and observes fresh CFS topology; stale persisted evidence alone is not enough to re-enable control.

### Notes

- CFS/CFS-C load, unload, feed, retract, and slot select are enabled only when live certification evidence explicitly allows the operation for the current printer model and firmware.
- Non-RFID third-party filament may not report remaining percentage from the printer. In that case, remaining material should be managed by the 3DPmon spool ledger.
- K1C + CFS-C live certification and longer K2/CFS attach, detach, runout, and reconnect certification remain ongoing work.

### Verification

- Local: `npx vitest run --reporter=dot --silent`
- Local: `npm run test:e2e`
- Local: `npm run build`
- GitHub Actions: lint / smoke / test
