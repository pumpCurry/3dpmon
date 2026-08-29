# 3dpmon 将来計画・未実装要件

本ドキュメントでは v2.2.1044 RC 時点の実装済み項目、Release Candidateとしての制限、今後の拡張候補をまとめます。

## 実装済み

### マルチプリンタ並行監視
- [x] ホストごとに独立した WebSocket 接続・データモデル
- [x] per-host パネル生成 (GridStack)
- [x] per-host データ分離
- [x] 接続設定UI (複数接続先管理、色設定、再接続)
- [x] per-host カメラ ON/OFF
- [x] per-host TTS 音声設定
- [x] Moonraker / IR3 V2 をK1/K2固有identity/control pathから分離

### パネルシステム
- [x] GridStack によるドラッグ&リサイズ
- [x] レイアウト永続化
- [x] パネル追加メニュー (ホスト x パネル種別)
- [x] ホスト別パネルヘッダー色
- [x] Hybrid Filament UI による外部スプール/CFS slotの分離表示

### フィラメント管理
- [x] スプール CRUD、在庫管理、使用履歴
- [x] per-host スプール装着 (`hostSpoolMap`)
- [x] フィラメント交換モーダル
- [x] 印刷中フィラメント交換対応
- [x] 3Dプレビュー
- [x] `materialSourceObservations` によるK2/CFS・K1C/CFS-Cのread-only最終観測保存
- [x] CFS 0-4台 + 外部スプール1本、最大17巻表示の土台

### K2 / CFS
- [x] K2 Pro Combo / CFS の `/info`、WS9999、`boxsInfo` 観測
- [x] K2 WebRTCカメラ表示
- [x] K2ファイル一覧、印刷履歴、サムネイル互換
- [x] CFS slot選択、装填状態、材料色、残量のread-only表示
- [x] K2/CFS print-start guard (`colorMatch` -> `multiColorPrint`) の実装
- [x] CFS Debug / Certification panel のdeveloper/tester向け土台

### ストレージ
- [x] IndexedDB バックエンド
- [x] localStorage フォールバック
- [x] 現行形式のエクスポート/インポート
- [x] `materialSourceObservations` の保存・復元

### 通知
- [x] per-host TTS 設定
- [x] 印刷完了・失敗・一時停止通知
- [x] カメラ異常通知

## v2.2.1044 RC の制限

- [ ] K2/CFS・K1C/CFS-C の standalone `load` / `unload` / `feed` / `retract` / `slot select` はproduction操作として有効化しない。
- [ ] CFS Debug / Certification panel の LIVE SEND は、v2.2.1044ではproduction commandではない。
- [ ] K2/CFS print-start はguarded pathとして利用するが、CFS feed、押出、完了までの長時間certificationは継続する。
- [ ] K1C + CFS-C は実装土台のみで、実機certificationは外部テスター確認が必要。
- [ ] CFS観測残量はread-only証跡であり、通常スプール台帳や使用履歴へ自動確定しない。
- [ ] Data Schema v3、Command Authority、Filament Ledger Authority、UI Authority Cutover は段階移行中であり、全面authority化は未完。

## 優先度: 高

- [ ] Gate 10 / Gate 12 live certification: K2/CFS と K1C+CFS-C の attach / detach / runout / reconnect / slot選択 / remaining変化を物理操作と対応付ける。
- [ ] Gate 21 release certification: v2.2.1044 artifactをmerge SHAから再buildし、複数機、複数回再起動、通信断復旧、誤操作防止を確認する。
- [ ] CFS単体操作のLAN command key調査と、実機certification済みregistry entryの追加。
- [ ] 3DPmon台帳とCFS観測残量の手動紐付けUIを設計し、RFIDなしフィラメントでも残量管理できるようにする。

## 優先度: 中

- [ ] Data Schema v3 の本番write / migration。
- [ ] Command Authority の本番dispatcher化とexpected-state confirmation拡充。
- [ ] Single-color / Multicolor / CFS PrintPlan authorityの段階的切替。
- [ ] モデル依存UI (K1 Max 300x300x300mm / K1C 220x220x250mm / K2系ステージ) の自動切替。
- [ ] i18n (日本語/英語ラベル外部化)。
- [ ] ResourceWatch (RAM/DOM/WS 状態チェック)。

## 優先度: 低

- [ ] CR-30 Y方向無限ベルト対応。
- [ ] TLS/トークン認証 (外部公開対応)。
- [ ] lint / stylelint debt整理とCI完全gating化。
- [ ] アクセシビリティ (WAI-ARIA / キーボードナビ)。

---

*本ドキュメントは v2.2.1044 RC (2026-08-29) 時点の状況を反映しています。*
