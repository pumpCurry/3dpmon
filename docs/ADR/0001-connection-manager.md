# ADR-0001 WebSocket 接続管理の設計選定

## ステータス
採用・実装済み (v2.1)

## コンテキスト
ダッシュボードは複数台のプリンタを同時に監視し、接続断時には自動再接続する必要がある。軽量なライブラリは再接続が不十分か、機能が過剰で不要な依存を持ち込む。アプリ固有の per-host 状態管理と密結合した接続管理が求められる。

## 決定
`dashboard_connection.js` に自前の接続管理を実装する。

- ホストごとに独立した WebSocket インスタンスを `connectionMap` で管理
- 再接続は exponential backoff (最大 60 秒)
- Heartbeat で接続状態を監視し、zombie 検知時に再接続
- `sendCommand()` / `sendGcodeCommand()` でタイムアウト付きコマンド送信
- `getConnectionState(hostname)` で任意ホストの接続状態を取得

## 結果
- 通信層が per-host データモデル (`monitorData.machines[hostname]`) と直接連携
- 接続/切断イベントで aggregator タイマーの起動/停止を自動制御
- パネルシステムが接続イベントを監視し、新規ホスト用パネルを自動生成
- 外部ライブラリ依存ゼロ

## 変更履歴
| 日付 | 内容 |
|------|------|
| 2025-06-27 | 初版: EventBus 連携の ConnectionManager クラス |
| 2026-03-10 | v2.1: 関数ベースに書き換え、per-host connectionMap 化 |
