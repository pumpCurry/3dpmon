## ステップ② ― ConnectionManager 実装 & 単体 WebSocket 通信

この文書はステップ②で実装した内容とレビュー結果をまとめたものです。

### 1. レビュー結果

| 評価項目 | 結果 | コメント |
| --- | --- | --- |
| **構造** | ◯ | `/src/core/ConnectionManager.js`, `EventBus.js`, `utils/hash.js` が追加され、API シグネチャは仕様通り。 |
| **エコー通信** | ◯ | `npm run mock` → `dev` で `{\"hello\":\"world\"}` が往復することを確認。 |
| **ESM & Vite 統合** | △ | 接続テストは動くが、`@shared/utils/hash.js` のパスが Vite alias 未登録 (`vite.config.js` 追加済)。 |
| **Vitest テスト** | ✕ | `npm test` が **module not found (`ws`, ESM)** エラーで落ちる。Windows/Nix 共に再現。 |
| **CI 連携** | ✕ | GitHub Actions にはジョブ未追加。 |

### 2. 問題点の原因と対策

| 症状 | 原因 | 解決策 |
| --- | --- | --- |
| **1. Vitest が `ws` を解決できない** | `workspace:devDependencies` にはあるが、Vitest は ESM-only モジュールを *CJS で stub* しようとして失敗。 | ① `vitest.config.js` に `define:{global: {}}` と `test.environment:"node"`<br>② `ws` を `--no-external=ws` でバンドル or `vi.mock('ws', …)` でスタブ |
| **2. crypto.subtle が Node18 で Experimental** | hash.js で `crypto.subtle` を使用 | `import { createHash } from 'node:crypto';` ⇒ `createHash('sha1').update(buf).digest('hex');` へ置換 |
| **3. tests/ ディレクトリがリポジトリ外** | `tests` が `.gitignore` されている | `.gitkeep` を置き、**サンプルテストを常設** |
| **4. CI ジョブが無い** | actions 未設定 | `ci.yml` を追加し `npm ci && npm test` を実行。`services: websocket-mock` で `ws` コンテナを起動するか、`mock-printer` を node プロセスで前起動。 |

### 3. 修正版設計 & 作業手順

1. 依存追加
   ```bash
   npm i -D vitest @vitest/ui
   npm i -D sinon
   ```
2. `vitest.config.js`
   ```js
   import { defineConfig } from 'vitest/config';

   export default defineConfig({
     test: {
       environment: 'node',
       globals: true,
       include: ['tests/**/*.test.js'],
       coverage: { reporter: ['text', 'lcov'] }
     },
     resolve: { alias: { '@core': '/src/core' } }
   });
   ```
3. `utils/hash.js` 修正
   ```js
   import { createHash } from 'node:crypto';

   export function sha1Hex(str) {
     return createHash('sha1').update(str).digest('hex');
   }
   ```
4. モック WebSocket（テスト用スタブ）
   ```js
   // tests/__mocks__/ws.js
   export default class WebSocketMock {
     constructor(url) {
       this.url = url;
       setTimeout(() => this.onopen?.(), 5);
     }
     send(msg) { setTimeout(() => this.onmessage?.({ data: msg }), 5); }
     close() { this.onclose?.(); }
   }
   ```
5. サンプルテスト `tests/connection.test.js`
   ```js
   import { ConnectionManager } from '@core/ConnectionManager.js';
   import { bus } from '@core/EventBus.js';

   vi.mock('ws', () => ({
     default: (await import('./__mocks__/ws.js')).default
   }));

   describe('ConnectionManager', () => {
     it('opens, echoes and closes', async () => {
       const cm = new ConnectionManager(bus);
       const id = await cm.add({ ip: '127.0.0.1', wsPort: 9999 });
       await cm.connect(id);
       expect(cm.getState(id)).toBe('open');

       const p = new Promise(r => bus.on('cm:message', r));
       cm.send(id, { ping: 1 });
       const frame = await p;
       expect(frame.data).toEqual({ ping: 1 });

       cm.close(id);
       expect(cm.getState(id)).toBe('closed');
     });
   });
   ```
6. npm scripts 更新
   ```jsonc
   "scripts": {
     "dev": "vite",
     "mock": "node src/core/mock-printer.ws.js",
     "test": "vitest run",
     "test:ui": "vitest --ui"
   }
   ```
7. GitHub Actions (`.github/workflows/ci.yml`)
   ```yaml
   name: CI
   on: [push, pull_request]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
           with: { node-version: 20 }
         - run: npm ci
         - run: npm test
   ```
8. 完了チェック
   * `npm test` 緑
   * Coverage ≥ 80 %
   * `npm run dev` で "Hello skeleton" 表示
   * `mock-printer.ws.js` を立てなくてもテストが動く

---

以上がステップ②で行う内容の要約である。これらを適用することで v2 開発の基盤が整う。
