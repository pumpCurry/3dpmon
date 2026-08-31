# 開発ドキュメント索引

本ディレクトリには 3dpmon の開発に関する設計書・仕様書を集約しています。v2.2.1045 RC 時点では、従来のマルチプリンタ監視に加えて Printer Core v3、K2/CFS、Hybrid Filament UI、CFS command certification の設計資料を含みます。

## アーキテクチャ・設計

| ファイル | 内容 |
| ------- | ---- |
| `architecture.md` | システムアーキテクチャ仕様書（歴史的なv2.1基盤を含む） |
| `printer-core-v3-open-work.md` | Printer Core v3 / K2+CFS / CFS-C の現時点の未完了項目 |
| `printer-core-v3-gate19-cfs-control-spec-investigation.md` | K2/CFS操作コマンド調査とGate 19設計境界 |
| `printer-core-v3-gate19-hybrid-filament-ui.md` | Hybrid Filament UI とCFS表示・操作候補の設計 |
| `printer-core-v3-live-certification-runbook.md` | 実機certificationの手順 |
| `printer-core-v3-live-certification-results-2026-08-26.md` | 2026-08-26時点の実機確認結果 |

## ADR (Architecture Decision Records)

| ファイル | 内容 |
| ------- | ---- |
| `../ADR/0001-connection-manager.md` | WebSocket 接続管理の設計選定 |
| `../ADR/0002-panel-system.md` | GridStack パネルシステムの採用理由 |
| `../ADR/0003-per-host-isolation.md` | per-host データ分離の設計方針 |
| `../ADR/0033-printer-core-gate18-ui-cutover-readiness.md` | UI authority cutover readiness |
| `../ADR/0034-printer-core-gate20-k2-cfs-command-transport.md` | K2/CFS command transport |
| `../ADR/0035-printer-core-gate18-7-material-source-observations.md` | read-only material source observations |

## 関連ドキュメント

| ファイル | 内容 |
| ------- | ---- |
| `../future.md` | 将来計画・未実装要件 |
| `../index.md` | ドキュメントトップページ |
| `../../CHANGELOG.md` | バージョン別変更履歴 |
