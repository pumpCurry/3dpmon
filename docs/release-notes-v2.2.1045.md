# v2.2.1045 Release Notes

## 日本語

v2.2.1045 は、Creality K1 numeric / Creality OS / CFS のエラーコードを同じ数値辞書へ混ぜて表示していた問題を修正する Release Candidate です。

### 主な変更

- **Crealityエラーコードの名前空間分離**: K1 numeric、Creality OS、CFS を別namespaceとして扱う `error_catalog` を追加しました。
- **K2/CFSエラー表示の修正**: K2 Pro Combo + CFS で観測した `errcode=1001,key=2843` を、K1の「使用できないファイル形式」ではなく `FS2843 — RFIDを読み取れません` と表示します。
- **raw値の保持**: 表示用canonical codeとは別に、機器から受け取った `errcode/key/value` を保持します。
- **fail-safe解決**: 機種不明時にK1辞書へ自動fallbackしないようにしました。判定不能な場合は未分類としてraw値を表示します。
- **K1互換維持**: 明示的にK1系と分かる場合のみ、既存のlegacy K1 error mapを互換fallbackとして使います。
- **CFS guarded print-startの安全性強化**: K2/CFS の印刷開始ガードで、装填済みsourceの選択状態が異常または未観測の場合は送信前に停止します。物理CFS操作の未解決復旧ラッチも、保存keyとpayload内command IDが食い違う破損データを両IDで停止します。
- **Certification panelの証跡表示改善**: CFS Debug / Certification panel に、選択状態の完全性と未解決復旧ラッチをpreflight項目として表示します。固定表示用の未観測placeholder slotは誤ってLIVE可否を落とさないよう扱います。

### 既知の制限

- エラーコードマスターは、2026-08-30時点で公開アクセス可能だったCreality公式資料と既存3dpmon辞書を元にしています。未公開・将来firmware・factory診断コードは unknown としてraw値を残します。
- CFS/CFS-C standalone操作は引き続きlive certification registry登録前のためproduction無効です。

## English

v2.2.1045 is a release candidate that fixes Creality error-code display by separating K1 numeric, Creality OS, and CFS namespaces instead of interpreting every number through one shared map.

### Highlights

- **Namespace-aware Creality error catalog**: adds an `error_catalog` path for K1 numeric, Creality OS, and CFS records.
- **K2/CFS error display fix**: the observed K2 Pro Combo + CFS payload `errcode=1001,key=2843` now resolves to `FS2843 — RFID cannot be read` instead of the K1-only “unsupported file format” message.
- **Raw transport preservation**: `errcode/key/value` are kept separately from the display canonical code.
- **Fail-safe resolution**: unknown printer types no longer fall back to the K1 dictionary. Unknown cases show the raw values instead of a misleading message.
- **K1 compatibility retained**: the legacy K1 error map is still used only when the device is explicitly known to be a K1-family printer.
- **Safer guarded CFS print start**: K2/CFS print-start preflight now stops before sending when a loaded source has invalid or unobserved selection evidence. Physical CFS recovery quarantine also blocks both the persisted storage key and payload command ID when they disagree.
- **Improved Certification panel evidence**: the CFS Debug / Certification panel now shows selection completeness and unresolved recovery blockers as preflight items. Fixed-frame unobserved placeholder slots no longer cause false LIVE blocking.

### Known Limitations

- The catalog is based on publicly accessible Creality documentation and the existing 3dpmon legacy map as of 2026-08-30. Private, future firmware, and factory diagnostic codes remain unknown while preserving raw evidence.
- Standalone CFS/CFS-C operations remain disabled in production until live certification evidence is registered.
