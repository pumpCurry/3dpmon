# Codex タスク実行ガイド

このドキュメントでは Codex 環境上でテストを成功させるための設定手順をまとめます。Step② で発生した "RED" 状態の原因と対策を整理したものです。

## 1. ステップ② "Codex 上で RED" の原因まとめ

| 症状 | 原因 (Codex 環境) | ローカルとの差 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `npm test` が失敗 | **依存解決が途中で停止**<br>‐ Universal イメージの Node 20 は OK だが **devDependencies がまだ未取得**<br>‐ `ws` や `vitest` が global に存在しない | ローカルでは `npm i` で取得済み |
| crypto.subtle 警告 | Universal=Node 20 → `crypto.subtle` 依存は Experimental | ローカルで createHash に置換済みなら問題なし |
| ネット遮断タスクで registry に到達できず install 失敗 | **setup script 未定義** で `npm ci` が動かない | ローカルはオンライン |

> Codex はタスク開始時に指定された「セットアップスクリプト」だけがネットワークを許可します。ここで `npm ci` や `playwright install` を実行しないとテストが走りません。

## 2. Codex 環境に入れるべき設定一覧

| セクション | 推奨設定 | 理由 |
| ---------------- | ------------------------------------------- | -------------------- |
| **環境変数** | `NODE_ENV=ci` / `CI=true` | npm スクリプトで CI 挙動に切替 |
| **シークレット** | (不要) | npm install のみにネット使用 |
| **セットアップスクリプト** | `run/codex/setup.sh` | 依存取得 → テスト実行 |
| **ドメイン許可** | `registry.npmjs.org` `registry.yarnpkg.com` | npm ci が通る最小構成 |
| **許可 HTTP メソッド** | `GET`, `HEAD` | 依存ダウンロードのみ |
| **インターネットアクセス** | **ON（setup 時のみ）** | テストラン時は OFF のまま |

### 2-1. セットアップスクリプト例

```bash
#!/usr/bin/env bash
# Codex setup script for 3dpmon
set -euxo pipefail

cd /workspace/3dpmon
corepack enable
npm ci --ignore-scripts
npm run -s test || true
```

## 3. リポジトリ側の追加ファイル

```
/run/codex/setup.sh        ★セットアップスクリプト
docs/develop/tests.md      ★テスト仕様書
.github/workflows/ci.yml   ★GitHub CI
tests/setup.js             ★Vitest WebSocket モック登録
tests/__mocks__/ws.js
tests/connection.test.js
vitest.config.js
```

## 4. テスト仕様書リンク

詳細なテスト方針は [docs/develop/tests.md](tests.md) を参照してください。
