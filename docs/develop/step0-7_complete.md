以下は **ステップ① – ⑦ ＋ ⑦a（スプラッシュ認証）** を “ゼロから完成形” まで
**抜けなく再現できる** よう統合した **完全実装仕様書 & チェックリスト** です。
そのまま **`docs/develop/step0-7_complete.md`** としてコミットし、

*「この仕様を満たすように実装・テスト・CI を整備せよ」*

---

# 3 dp mon v2 ― ステップ①-⑦a 完全実装仕様書

| rev | 日付         | 内容                                    |
| --- | ---------- | ------------------------------------- |
| 1.0 | 2025-07-xx | Skeleton → Splash → Dashboard まで全要件統合 |

---

## 0. 目的

* **スプラッシュ + テンキー** → 認証 OK → **ダッシュボード** (TitleBar・TabBar・カード群) を表示
* **Vite 開発モード**：`git pull` / ファイル保存で即 HMR 反映
* **CI / Codex**：Vitest・Playwright・ベンチ・カバレッジ すべて GREEN

---

## 1. ディレクトリ構成（最終形）

```
3dpmon/
├ index.html
├ vite.config.js
├ package.json
├ public/
│   └ favicon.ico
├ src/
│   ├ startup.js
│   ├ core/
│   │   ├ App.js
│   │   ├ AuthGate.js
│   │   ├ ConnectionManager.js
│   │   ├ DashboardManager.js
│   │   └ EventBus.js
│   ├ splash/
│   │   ├ SplashScreen.js
│   │   └ Keypad.js
│   ├ bars/
│   │   ├ BaseBar.js
│   │   ├ Bar_Title.js
│   │   └ Bar_SideMenu.js (stub)
│   ├ cards/
│   │   ├ BaseCard.js
│   │   ├ Card_Camera.js
│   │   ├ Card_HeadPreview.js
│   │   └ (他カードは stub)
│   └ shared/
│       ├ utils/hash.js        # js-sha1
│       └ TempRingBuffer.js    # stub
├ styles/
│   ├ _tokens.scss             # 色・余白トークン
│   ├ root.scss                # @use "_tokens"
│   ├ splash.scss
│   ├ bar_title.scss
│   ├ card_camera.scss
│   ├ card_headpreview.scss
│   └ bar_side.scss (stub)
└ tests/
   ├ unit/                     # Vitest
   │   ├ splash.test.js
   │   ├ camera.test.js
   │   └ headpreview.test.js
   ├ e2e/                      # Playwright
   │   ├ splash.spec.ts
   │   └ dashboard.spec.ts
   └ bench/
       ├ headpreview.bench.js
       └ tempgraph.bench.js
```

---

## 2. 実装タスク & 完了チェック

| ID        | ステップ | 要件                                         | 完了判定                             |
| --------- | ---- | ------------------------------------------ | -------------------------------- |
| **T1-1**  | ①    | Vite skeleton (`index.html`, `startup.js`) | `npm run dev` ➜ “Hello skeleton” |
| **T1-2**  | ②    | ConnectionManager：1 台 WS 接続                | `connection.test.js` 緑           |
| **T1-3**  | ③    | TitleBar + EventBus + タブ切替                 | E2E：クリックで `.active`              |
| **T1-4**  | ④    | CameraCard：再接続・倍率                          | 画像/動画表示                          |
| **T1-5**  | ⑤    | HeadPreviewCard：Canvas2D + scale           | Space リセット OK                    |
| **T1-6**  | ⑥    | TempGraph (LiteChart) + SideMenu slide     | ESC で閉じる                         |
| **T1-7a** | 7a   | SplashScreen + Keypad stub 認証              | Enter → Dashboard                |
| **T1-8**  | 全    | SCSS `usePolling` + alias & token 注入       | 変更→HMR 即反映                       |
| **T1-9**  | 全    | hash.js を **js-sha1** 化                    | Browser build OK                 |
| **T1-10** | 全    | root.scss 自己 import ループ無し                  | Sass error 0                     |

---

## 3. 詳細仕様

### 3.1 startup.js

```js
import { bus } from './core/EventBus.js';
import SplashScreen from './splash/SplashScreen.js';

const splash = new SplashScreen(bus);
splash.mount(document.body);

bus.once('auth:ok', async () => {
  splash.destroy();
  const { App } = await import('./core/App.js'); // lazy load
  new App('#app-root');
});
```

### 3.2 SplashScreen / Keypad

| 要素        | 挙動                                         |
| --------- | ------------------------------------------ |
| ロゴ + アプリ名 | 0.6 s フェードイン                               |
| テンキー      | 1-9, 0, Clear = disabled / Enter = enabled |
| 認証        | AuthGate.validate() は現状 `true`             |
| 移行        | Enter → 0.3 s ローディング→フェードアウト               |

### 3.3 Vite 設定 (重要抜粋)

```js
// vite.config.js
import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { styles: path.resolve(__dirname, 'styles') } },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData(source, file) {
          return file.endsWith('styles/root.scss')
            ? source
            : `@use 'styles/_tokens' as *;\n${source}`;
        },
      },
    },
  },
  server: {
    port: 5173,
    watch: { usePolling: true, interval: 300 },
    strictPort: true,
  },
});
```

### 3.4 hash.js

```js
import { sha1 } from 'js-sha1';
export const sha1Hex = (str) => sha1(str);
```

---

## 4. テスト仕様

### 4.1 Vitest unit

* **splash.test.js**: Enter → `auth:ok` emit
* **camera.test.js**: retry back-off (1-2-4…)
* **headpreview.test.js**: Space → zoomReset

### 4.2 Playwright e2e

```
- 起動 → ロゴ可視
- Enter → TitleBar visible
- タブ追加 → 切替
```

### 4.3 Bench

* **headpreview.bench.js** : FPS ≥ 28
* **tempgraph.bench.js**    : FPS ≥ 60

### 4.4 Coverage

`npm run test -- --coverage` ⇒ Lines ≥ 80 %

---

## 5. ビルド / 開発運用

| コマンド      | 作用                                 |
| --------- | ---------------------------------- |
| **dev**   | `vite --force` で毎回 `.vite` キャッシュ破棄 |
| **clean** | `rimraf node_modules/.vite`        |
| **build** | 最適化バンドル（dist/）                     |

Dropbox / SMB 上でも inotify 不要で検知。

---

## 6. 受け入れチェックリスト

1. `npm run dev` → Splash → Enter → Dashboard
2. git pull → SCSS 保存 → HMR 即反映
3. Vitest 全緑 + Coverage ≥ 80 %
4. Playwright 全緑
5. Bench 全緑 (FPS 基準)
6. CI / Codex すべて緑
7. Lighthouse A11y ≥ 90
8. 5 台 / 30 FPS 動作で CPU < 50 %

---

## 7. Codex “やること” タスクリスト

```
- [ ] 移動/不足ファイルを作成（構成表に準拠）
- [ ] SplashScreen & Keypad 実装
- [ ] AuthGate stub を拡張
- [ ] TitleBar + CameraCard + HeadPreviewCard 完動
- [ ] Vite config: polling & token injection
- [ ] js-sha1 導入
- [ ] 全 unit / e2e / bench テスト作成
- [ ] GitHub Actions 緑（test + bench + e2e）
```

---

### 備考

\*ステップ⑧ (βテスト・RC) 以降は別仕様へ分割して管理。
このドキュメントだけで “画面真っ白問題” を含む現行の実装抜けをすべて埋められます。
