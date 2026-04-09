# レガシー単一ホストUI要素 — 触ってはいけないリスト

> **重要:** 以下の要素はシングルプリンター時代の遺物です。マルチホスト環境では正しく動作しません。
> 新機能のイベントリスナーを追加したり、これらの要素を再利用してはいけません。

## 背景

3dpmon は元々1台のプリンターを監視するアプリとして設計されました。v2.x でマルチホスト対応が進みましたが、トップバーの接続関連 UI 要素は単一ホスト前提のまま残存しています。

これらの要素は `updateConnectionUI()` が最後に呼ばれたホストの状態だけを反映するため、複数台接続時に:
- どのホストの状態が表示されているかわからない
- 操作対象が不明確（全台に影響 or 最後のホストだけに影響）
- 複数ホストの状態更新が競合して表示がちらつく

## 危険な要素一覧 (3dp_monitor.html)

| 要素 ID | 行 | 種類 | 問題 |
|---|---|---|---|
| `connect-button` | L196 | button | `connectWs()` に引数なしで呼ばれる。マルチホストでは対象不明 |
| `disconnect-button` | L197 | button | イベントリスナーなし。リスナーを付けても全台切断 or 対象不明 |
| `destination-input` | L176 | input | 最後に更新されたホストの IP のみ表示。入力しても接続先の特定不可 |
| `destination-display` | L177 | span | 同上 |
| `connection-status` | L198 | span | 最後に更新されたホストのステータスのみ表示 |
| `audio-muted-tag` | L172 | span | 単一のミュート状態。per-host ミュートに未対応 |

## 完全に死んでいる要素 (除去推奨)

| 要素 ID | 行 | 種類 | 状態 |
|---|---|---|---|
| `auto-connect-toggle` | L191 | checkbox | JS から一切参照されていない |
| `add-printer-input` | L183 | input | JS から一切参照されていない |
| `add-printer-button` | L184 | button | JS から一切参照されていない |

## 安全な要素 (マルチホスト対応済み)

| 要素 ID | 状態 |
|---|---|
| `printer-select` | per-host ドロップダウン。安全 |
| `printer-status-list` | per-host ステータスリスト。安全 |
| `top-status-dot`, `top-conn-label`, `top-printer-list` | マルチホスト対応済み |
| `conn-modal-*` (接続モーダル内要素) | マルチホスト対応済み |

## 対応方針

### Phase 1: 現状維持 + 保護 (完了)
- 旧ボタンにイベントリスナーを追加しない
- `updateConnectionUI()` 内の旧要素操作は残存（除去すると表示が壊れる可能性）

### Phase 2: 接続モーダル内に per-host トグル追加 (TODO)
- `conn-modal-printer-list` 内の各ホスト行に接続/切断ボタンを追加
- `connectWs(host)` / `disconnectWs(host)` を個別ホストで呼び出し
- 接続状態インジケーター (🟢/🔴) を per-host で表示

### Phase 3: 旧要素除去 (Phase 2 完了後)
- 上記「危険な要素」と「死んでいる要素」を HTML から除去
- `updateConnectionUI()` 内の旧要素参照コードを削除
- `setupConnectButton()` を削除

## 関連コード

- `dashboard_connection.js` L1294-1411: `updateConnectionUI()` — 旧要素の show/hide 制御
- `dashboard_connection.js` L1191-1196: `setupConnectButton()` — 使用禁止
- `dashboard_panel_boot.js` L388-470: 接続モーダル — Phase 2 の実装先
