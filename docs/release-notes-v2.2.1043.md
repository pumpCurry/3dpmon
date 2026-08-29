# 3dpmon v2.2.1043 リリースノート

> [!NOTE]
> この文書は v2.2.1043 pre-release の履歴用リリースノートです。v2.2.1043 のtag/releaseは変更せず保持しています。PR #436 の後続Release Candidateは v2.2.1044 です。

## 日本語

3dpmon v2.2.1043 は、K2 Pro Combo / CFS を中心に、Printer Core v3 の監視・CFS対応印刷開始ガード・安全な操作準備を進めたリリース候補です。

### 主な変更

- K2 Pro Combo / CFS の `/info`、WS9999、`boxsInfo`、WebRTCカメラ検出を強化しました。
- K2/CFS のフィラメント供給を、外部スプールとCFSスロットを混ぜずに表示できるようにしました。
- CFS / CFS-C は 0台から4台まで、外部スプールを含めて最大17巻構成を表示できる設計になりました。
- CFSスロットの色、残量、装填状態、機器選択状態、`T1A` などの割当観測を、通常フィラメント管理とは別の read-only 観測情報として蓄積します。
- K2/CFS のファイル印刷では、旧来の `opGcodeFile` 直投げではなく、`colorMatch` から `multiColorPrint` へ進む明示的なCFS割当経路を追加しました。この経路は空走り防止のため、CFS slotの観測と割当が揃う場合だけ使う guarded path として扱います。
- CFS情報が未観測、古い、または装填済みスロットを確認できない場合は、空走り防止のためCFS印刷開始を拒否します。
- K2カメラのWebRTC表示とパネル内の映像収まりを改善しました。
- K2のファイル一覧、印刷履歴、サムネイル表示の互換性を改善しました。
- Printer Core v3 のCFS操作UI状態を追加しました。ただし v2.2.1043 では、CFS/CFS-C の standalone load / unload / feed / retract / slot select はすべて無効です。
- 再起動後は、保存済みの古い `/info` やCFS観測だけでCFS操作を復活させず、現在起動中の再probeと新しいCFS観測が揃うまで操作を無効化します。

### 注意事項

- v2.2.1043 の module-owned certification registry は空です。保存済み設定やUI表示だけで、CFS/CFS-C の standalone load / unload / feed / retract / slot select が有効になることはありません。
- v2.2.1042 は既存のpre-releaseとして残し、今回のPR #435相当のRelease Candidateは v2.2.1043 として扱います。
- K2/CFS print-start は guarded / certification continuing として扱います。実機での print-start、CFS feed、押出、完了までの証跡は継続してGate 21で確認します。
- Creality純正RFIDフィラメント以外では、機器から残量が報告されない場合があります。その場合、3DPmon側の台帳管理で残量を扱う必要があります。
- K1C + CFS-C の実機certification、K2/CFS attach / detach / runout / reconnect の長時間確認は継続作業です。

### 検証

- ローカル: `npx vitest run --reporter=dot`
- ローカル: `npm run verify:release`
  - `check:version-sync` PASS
  - Vitest 102 files / 1656 tests PASS
  - Electron E2E 3 passed
  - Windows build PASS
  - `release-manifest-2.2.1043.json` 生成
- GitHub Actions: lint / smoke / test / e2e / version-sync

### ビルド成果物

- `3dpmon-2.2.1043-setup.exe`
- `3dpmon-2.2.1043-portable.exe`
- `3dpmon-2.2.1043-setup.exe.blockmap`
- `release-manifest-2.2.1043.json`

公開Releaseには `release-manifest-2.2.1043.json` を添付済みです。最終commit、build日時、各成果物のSHA256はmanifestで確認できます。

## English

> [!NOTE]
> This document is the historical release note for the v2.2.1043 pre-release. The v2.2.1043 tag/release is retained as-is. The subsequent Release Candidate for PR #436 is v2.2.1044.

3dpmon v2.2.1043 is a release-candidate build focused on Printer Core v3 monitoring, K2 Pro Combo / CFS support, guarded CFS-aware print start, and safer command-readiness foundations.

### Highlights

- Improved K2 Pro Combo / CFS detection through `/info`, WS9999, `boxsInfo`, and WebRTC camera hints.
- Displays K2/CFS filament supply without mixing the external spool and CFS slots.
- Supports the planned display model for 0 to 4 CFS/CFS-C units, plus the external spool, up to 17 visible material sources.
- Stores CFS slot color, remaining percentage, loaded state, printer-selected state, and `T1A`-style assignment evidence as read-only material observations separate from the 3DPmon spool ledger.
- Adds an explicit K2/CFS print-start path using `colorMatch` followed by `multiColorPrint`, instead of legacy direct `opGcodeFile` submission. This remains a guarded path that is used only when CFS slot observation and assignment evidence are available.
- Blocks CFS print start when CFS topology is stale, unobserved, or no loaded CFS slot can be verified, reducing the risk of dry-run-like printing without filament.
- Improves K2 WebRTC camera display and video fitting inside dashboard panels.
- Improves compatibility for K2 file lists, print history, and thumbnail paths.
- Adds Printer Core v3 CFS command UI states. In v2.2.1043, standalone CFS/CFS-C load, unload, feed, retract, and slot select operations are all disabled.
- After restart, production CFS controls stay disabled until the current runtime re-probes `/info` and observes fresh CFS topology; stale persisted evidence alone is not enough to re-enable control.

### Notes

- The v2.2.1043 module-owned certification registry is empty. Saved settings or visible UI state cannot enable standalone CFS/CFS-C load, unload, feed, retract, or slot select operations.
- v2.2.1042 remains as the existing pre-release; the PR #435 release candidate is treated as v2.2.1043.
- K2/CFS print start is treated as guarded / certification continuing. Gate 21 will continue collecting evidence for print start, CFS feed, extrusion, and job completion on real hardware.
- Non-RFID third-party filament may not report remaining percentage from the printer. In that case, remaining material should be managed by the 3DPmon spool ledger.
- K1C + CFS-C live certification and longer K2/CFS attach, detach, runout, and reconnect certification remain ongoing work.

### Verification

- Local: `npx vitest run --reporter=dot`
- Local: `npm run verify:release`
  - `check:version-sync` PASS
  - Vitest 102 files / 1656 tests PASS
  - Electron E2E 3 passed
  - Windows build PASS
  - `release-manifest-2.2.1043.json` generated
- GitHub Actions: lint / smoke / test / e2e / version-sync

### Build Artifacts

- `3dpmon-2.2.1043-setup.exe`
- `3dpmon-2.2.1043-portable.exe`
- `3dpmon-2.2.1043-setup.exe.blockmap`
- `release-manifest-2.2.1043.json`

The published release includes `release-manifest-2.2.1043.json` so the final commit, build timestamp, and SHA256 for each artifact can be verified from the manifest.
