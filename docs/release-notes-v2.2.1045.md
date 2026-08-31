# v2.2.1045 Release Notes

## 日本語

v2.2.1045 は、K2 Pro Combo / CFS 監視と guarded print-start の安全境界を固めながら、Creality K1 numeric / Creality OS / CFS のエラーコードを名前空間ごとに分離して表示する Release Candidate です。

### 主な変更

- **Crealityエラーコードの名前空間分離**: K1 numeric、Creality OS、CFS を別namespaceとして扱う `error_catalog` を追加しました。
- **K2/CFSエラー表示の修正**: K2 Pro Combo + CFS で観測した `errcode=1001,key=2843` を、K1の「使用できないファイル形式」ではなく `FS2843 - RFIDを読み取れません` と表示します。
- **raw値の保持**: 表示用canonical codeとは別に、機器から受け取った `errcode/key/value` を保持します。
- **fail-safe解決**: 機種不明時にK1辞書へ自動fallbackしないようにしました。判定不能な場合は未分類としてraw値を表示します。
- **K1互換維持**: 明示的にK1系と分かる場合のみ、既存のlegacy K1 error mapを互換fallbackとして使います。
- **K2/CFS監視UI**: 外部スプールと CFS 0-4台を分けて表示し、CFS slotの装填、選択、色、残量、fresh/staleをread-onlyで確認できます。
- **CFS guarded print-startの安全性強化**: K2/CFS の印刷開始ガードで、装填済みsourceの選択状態が異常または未観測の場合は送信前に停止します。
- **CFS復旧ラッチの強化**: 物理CFS操作候補は未解決復旧ラッチ、破損/衝突record、同一deviceの古い未解決command、同一deviceの並行dispatchをfail-closedで止めます。
- **送信前durable reservation**: 将来の実機certification後にCFS physical commandを有効化する場合でも、物理transport前に復旧ラッチを永続保存し、保存失敗時は送信しません。
- **Certification panelの証跡表示改善**: CFS Debug / Certification panel に、選択状態の完全性と未解決復旧ラッチをpreflight項目として表示します。

### 既知の制限

- CFS/CFS-C standalone操作、つまり load / unload / feed / retract / slot select は、live certification registry登録前のためproduction無効です。
- K2/CFS print-start は guarded path ですが、CFS standalone操作の実機送信はまだ開きません。
- エラーコードマスターは、2026-08-30時点で公開アクセス可能だったCreality公式資料と既存3dpmon辞書を元にしています。未公開・将来firmware・factory診断コードは unknown としてraw値を残します。
- 非RFIDフィラメントの正確な残量管理、K1C + CFS-C live certification、CFS attach / detach / runout / reconnect の長時間確認は後続Gateです。

### 検証

- GitHub Actions CI: PASS (`test`, `lint`, `smoke`, `e2e`, `version-sync`)
- `npx vitest run`: PASS (116 files / 1940 tests)
- 関連CFS hardening tests: PASS (5 files / 115 tests)
- `npm run test:e2e`: PASS (3 passed / 0 failed)
- `npm run check:version-sync`: PASS
- Windows installer / portable build: PASS

## English

v2.2.1045 is a release candidate that hardens the K2 Pro Combo / CFS monitoring and guarded print-start safety boundary, while resolving Creality K1 numeric, Creality OS, and CFS error codes through separate namespaces.

### Highlights

- **Namespace-aware Creality error catalog**: adds an `error_catalog` path for K1 numeric, Creality OS, and CFS records.
- **K2/CFS error display fix**: the observed K2 Pro Combo + CFS payload `errcode=1001,key=2843` now resolves to `FS2843 - RFID cannot be read` instead of the K1-only unsupported-file-format message.
- **Raw transport preservation**: raw `errcode/key/value` are kept separately from canonical display codes.
- **Fail-safe resolution**: unknown printer types no longer fall back to the K1 dictionary. Unknown cases show raw values instead of a misleading K1 message.
- **K1 compatibility retained**: the legacy K1 error map is still used only when the device is explicitly known to be K1-family.
- **K2/CFS monitoring UI**: the external spool and 0-4 CFS units are displayed separately, with read-only slot presence, selection, color, remaining amount, and fresh/stale state.
- **Safer guarded CFS print start**: K2/CFS print-start preflight stops before sending when a loaded source has invalid or unobserved selection evidence.
- **CFS recovery latch hardening**: physical CFS command candidates now fail closed on unresolved recovery records, corrupted/conflicting records, older unresolved commands on the same device, and concurrent dispatch on the same device.
- **Pre-send durable reservation**: once future live certification enables physical CFS commands, the recovery latch is persisted before physical transport; if durable storage fails, the command is not sent.
- **Improved Certification panel evidence**: the CFS Debug / Certification panel shows selection completeness and unresolved recovery blockers as preflight evidence.

### Known Limitations

- Standalone CFS/CFS-C operations, including load, unload, feed, retract, and slot select, remain disabled in production until live certification evidence is registered.
- K2/CFS print-start uses a guarded path, but standalone physical CFS command sending is not opened yet.
- The catalog is based on publicly accessible Creality documentation and the existing 3dpmon legacy map as of 2026-08-30. Private, future firmware, and factory diagnostic codes remain unknown while preserving raw evidence.
- Exact remaining tracking for non-RFID filament, K1C + CFS-C live certification, and long-running CFS attach / detach / runout / reconnect validation remain follow-up gates.

### Verification

- GitHub Actions CI: PASS (`test`, `lint`, `smoke`, `e2e`, `version-sync`)
- `npx vitest run`: PASS (116 files / 1940 tests)
- Related CFS hardening tests: PASS (5 files / 115 tests)
- `npm run test:e2e`: PASS (3 passed / 0 failed)
- `npm run check:version-sync`: PASS
- Windows installer / portable build: PASS
