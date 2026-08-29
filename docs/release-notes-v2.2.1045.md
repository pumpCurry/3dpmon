# v2.2.1045 Release Notes

## 日本語

v2.2.1045 は、Creality K1 numeric / Creality OS / CFS のエラーコードを同じ数値辞書へ混ぜて表示していた問題を修正する Release Candidate です。

### 主な変更

- **Crealityエラーコードの名前空間分離**: K1 numeric、Creality OS、CFS を別namespaceとして扱う `error_catalog` を追加しました。
- **K2/CFSエラー表示の修正**: K2 Pro Combo + CFS で観測した `errcode=1001,key=2843` を、K1の「使用できないファイル形式」ではなく `FS2843 — RFIDを読み取れません` と表示します。
- **raw値の保持**: 表示用canonical codeとは別に、機器から受け取った `errcode/key/value` を保持します。
- **fail-safe解決**: 機種不明時にK1辞書へ自動fallbackしないようにしました。判定不能な場合は未分類としてraw値を表示します。
- **K1互換維持**: 明示的にK1系と分かる場合のみ、既存のlegacy K1 error mapを互換fallbackとして使います。

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

### Known Limitations

- The catalog is based on publicly accessible Creality documentation and the existing 3dpmon legacy map as of 2026-08-30. Private, future firmware, and factory diagnostic codes remain unknown while preserving raw evidence.
- Standalone CFS/CFS-C operations remain disabled in production until live certification evidence is registered.
