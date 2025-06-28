## ステップ① ― 「Vite 雛形」設計書・手順書

（v2.0 ディレクトリ再編への最初のコミットに相当）

---

### 1. ゴール

| 項目 | 完了条件 |
| --- | --- |
| Vite 開発サーバーが `/src/startup.js` をエントリに **空白画面**（`#app-root` のみ）を表示する | |
| すべてのディレクトリ／基本ファイルが **Git 管理** 下に生成される | |
| `npm run dev` / `npm run build` がエラーなく完走する | |
| Node 18+ 環境でクロスプラットフォーム（Win/Mac/Linux）動作を確認 | |

---

### 2. 前提ソフトウェア

| ツール | バージョン | 備考 |
| --- | --- | --- |
| Node.js | 18 LTS 以上 | `corepack enable` で npm 10 系か pnpm/yarn でも可 |
| Git | 2.40+ | `core.autocrlf=input` 推奨 |
| VS Code | 最新 | 推奨拡張：ESLint、Prettier、Stylelint、volar-eslint (JS/TS) |

---

### 3. ディレクトリ初期生成

```bash
# ❶ 新ブランチ（例: feature/v2-init）
git switch -c feature/v2-init

# ❷ ルート配下でディレクトリ作成
mkdir -p public src/{core,cards,shared,legacy} styles res \
         docs/{ja/{manual,develop},en} docs/ADR \
         docs/develop

# ❸ 空のプレースホルダー(.gitkeep)を入れる
find res src cards legacy styles docs -type d -exec touch {}/.gitkeep \;
```

---

### 4. package.json ひな型

> **備考**：すべて ESModules 前提なので `"type": "module"` を必ず指定。
> Lint/Format は *後工程*（ステップ②）で追加 OK。

```jsonc
{
  "name": "3dpmon-dashboard-v2",
  "version": "2.0.0-alpha.0",
  "description": "3dpmon multi-printer dashboard (v2 skeleton)",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "engines": { "node": ">=18" },
  "dependencies": {},
  "devDependencies": {
    "vite": "^6.0.0",
    "sass": "^1.80.0"
  }
}
```

インストール:

```bash
npm install        # または pnpm install / yarn install
```

---

### 5. Vite 設定 (`vite.config.js`)

```js
import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: '.',                 // プロジェクト直下
  base: './',                // 相対パスビルド
  publicDir: 'public',       // そのままコピー
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  css: {
    preprocessorOptions: {
      scss: { additionalData: `@use 'styles/root';` } // トークンを全 SASS に差し込み
    }
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@cards': path.resolve(__dirname, 'src/cards'),
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  server: {
    port: 5173,
    open: true,
    strictPort: true
  }
});
```

---

### 6. ベース HTML (`public/index.html`)

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3dpmon v2 – skeleton</title>
    <link rel="icon" href="/favicon.svg" />
  </head>
  <body>
    <div id="app-root"></div>
    <noscript>このアプリは JavaScript が必要です。</noscript>
    <script type="module" src="/src/startup.js"></script>
  </body>
</html>
```

---

### 7. エントリ (`/src/startup.js`)

```js
/* eslint-env browser */
console.log('[startup] bootstrap v2 skeleton');

async function main() {
  // 仮 AuthGate をスキップ・直接描画
  const root = document.querySelector('#app-root');
  root.textContent = 'Hello, 3dpmon v2 skeleton!';
}

main();
```

> **ポイント**
>
> * まだ `AuthGate` / `App` を作らず、プレースホルダーで空画面を実現
> * Step② 以降で `core/AuthGate.js`, `core/App.js` を実装し差し替える

---

### 8. SCSS トークン (`/styles/root.scss`)

```scss
/* 基本トークンのみ (追加は後工程) */
:root {
  --color-bg: #0e0e0e;
  --color-text: #fafafa;
  --card-bg: #1a1a1a;
  --border-radius: 8px;
}

/* デフォルトで簡易リセット */
*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  font-family: system-ui, sans-serif;
  background: var(--color-bg);
  color: var(--color-text);
}
```

---

### 9. `.gitignore`

```gitignore
# Node / Vite
node_modules/
dist/
.cache/
.vite/

# IDE
.idea/
.vscode/
```

---

### 10. 動作確認フロー

```bash
npm run dev     # 5173 ポートでブラウザ自動起動
# ⇒ 画面中央に "Hello, 3dpmon v2 skeleton!" が表示されれば成功

npm run build   # dist/ 配下に本番ビルド生成
npm run preview # 静的ファイルをローカルサーバーで確認
```

---

### 11. Git コミット例

```bash
git add .
git commit -m "feat(v2): step① – vite skeleton & directory scaffold"
git push origin feature/v2-init
```

---

### 12. 次ステップ（予告）

| 次回要求 | 予定タスク |
| --- | --- |
| **ステップ②** | `core/ConnectionManager.js` ES6 化＋単体 WebSocket 通信テスト |
| **ステップ③** | `Bar_Title` 実装 → タブレンダリング |

---

### 付録 ― FAQ

| Q | A |
| --- | --- |
| **Vite で TypeScript に替えられる？** | 可能。`vite-plugin-checker` などを入れ、`/src/**/*.ts` へリネームすればよい。まずは JS で開始する方針。 |
| **SCSS を CSS Modules に？** | 後日 `vite-plugin-css-modules` 導入も検討。ただしカード単位でスコープ管理予定なので必須ではない。 |
| **旧 v1 リポジトリと混在?** | `src/legacy` 以下に旧 `3dp_lib` をコピーしたら **インポートしない限りビルド対象外**。互換レイヤはステップ⑦で実装。 |

---

これで **ステップ①** の設計と作業手順は完了です。
着手後、疑問や環境差異があればいつでもご相談ください。
