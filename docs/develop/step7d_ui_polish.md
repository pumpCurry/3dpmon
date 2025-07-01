## 1. 目標

1. **スプラッシュ / テンキー / TitleBar / メニュー** の見栄え統一
2. **固定 TitleBar**：スクロールしても常に画面上部に残る
3. **カード & ダイアログの階層表示**：重なっても前後が分かりやすい
4. PC（マウス）＆ スマホ／タッチの両立（24 px 以上タップ幅）

## 2. CSS/SCSS 方針

| 項目 | 指針 |
| --- | --- |
| **変数** | `styles/_tokens.scss` に追加<br>`scss --z-title:1000; --z-dialog:1100; --z-tooltip:1200;` |
| **TitleBar** | `position: fixed; top: 0; left:0; right:0; height:48px; box-shadow:0 2px 4px #0003; z-index:var(--z-title);` |
| **Body padding** | `body { padding-top: 48px; }` ← TitleBar 高さぶん余白 |
| **ハンバーガー / メニュー** | 44 × 44 px hit -area (`padding: 10px;`) |
| **カード** | `border-radius: var(--border-radius); box-shadow:0 1px 4px #0006;` |
| **フォアグラウンド強調** | 前面カードに `outline:2px solid #40a9ff;` |
| **スプラッシュ** | `display:flex; flex-direction:column; gap:24px;` → 中央配置 |
| **メディアクエリ** | `@media (max-width: 640px) { .card { margin:4px; } .titlebar h1 { font-size:1rem; } }` |
| **CSS モジュール分離** | `bar_title.scss`, `splash.scss`, `card_*.scss` を root 以外に変数依存で書く |

## 3. 実装タスク

| ID | 作業 | 完了条件 |
| --- | --- | --- |
| **T7d-A** | TitleBar を `position: fixed` ＋ body padding 追加 | スクロールで固定 |
| **T7d-B** | メニュー / ハンバーガー touch-target 拡大 | Lighthouse Tap-target ≥ 90 |
| **T7d-C** | スプラッシュ画面 SCSS 改良（中央寄せ & レスポンシブ） | 320×568 でも崩れない |
| **T7d-D** | カード shadow + 前面 outline | Drag 時に最前面強調 |
| **T7d-E** | z-index トークン導入 | Dialog が TitleBar を覆わない |
| **T7d-F** | Unit: Splash uses flex, TitleBar fixed test (jsdom getComputedStyle) | Vitest 緑 |
| **T7d-G** | E2E: Scroll 1000px → TitleBar 位置 same | Playwright 緑 |

## 4. テスト例

```ts
// e2e/titlebar_fixed.spec.ts
test('TitleBar sticks', async ({ page }) => {
  await page.goto('/');
  const bar = page.locator('header.titlebar');
  const y1 = await bar.boundingBox();
  await page.mouse.wheel(0, 1200);
  const y2 = await bar.boundingBox();
  expect(y2?.y).toBeCloseTo(y1?.y, 1);
});
```

## 5. ローカルビルドキャッシュ問題の恒久策

`package.json`

```json
"scripts": {
  "dev": "vite --force --clearScreen false",
  "clean": "rimraf node_modules/.vite"
}
```

* `.git/hooks/post-merge`

  ```sh
  #!/bin/sh
  rm -rf node_modules/.vite
  ```

## 6. 受け入れ基準

1. TitleBar 固定・メニュー操作 44 px 以上
2. スプラッシュ＆テンキー モバイル幅対応
3. カード重なり時の outline 強調
4. Lighthouse モバイル：A11y ≥ 95 / Best-Practices ≥ 90 / SEO ≥ 90
5. 既存機能（テーマ・接続マネージャ）の動作維持
6. Unit / E2E / CI 全緑

## 次アクション

1. **T7c-R1〜R3** を PR #278 に追加コミットしマージ。
2. `feature/v2-step7d-ui-polish` ブランチで **T7d-A〜G** を実装。

これで ⑦d の UI 仕上げに着手できます。質問があればどうぞ。
