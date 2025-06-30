### ⑦b ― テーマ切替（ライト／ダーク／「機器と同期」）実装仕様書

> **ファイル名**: `docs/develop/step7b_theme_switch.md` へ追加し、
> Codex / PR タイトル **`feature/v2-step7b-theme-switch`** で着手

---

## 1. ゴール

1. **ハンバーガーメニュー**（TitleBar 右端）に

   ```
   ├ Theme ▸
   │   ├ Light   (default)
   │   ├ Dark
   │   └ Match Printer   (model color)
   └ … (既存メニュー)
   ```
2. クリックで **即時テーマ反映**（CSS 変数切替）
3. **起動時**：

   * `localStorage.theme` があればそれを適用
   * 無ければ **Light**
4. “Match Printer” はプリンタごとの `connection.color` を CSS Root に反映（将来拡張可）

---

## 2. ファイル構成追加

```
src/
 ├ bars/Bar_Title.js      ← メニュー項目を追加
 └ core/ThemeManager.js   ★新規
styles/
 └ themes.scss            ★新規（変数セット）
tests/
 ├ unit/theme.test.js     ★Vitest
 └ e2e/theme.spec.ts      ★Playwright
docs/develop/step7b_theme_switch.md
```

---

## 3. ThemeManager API

```js
export const THEMES = ['light', 'dark', 'printer'];

/**
 * 現在テーマを返す
 * @returns {'light'|'dark'|'printer'}
 */
export function getTheme();

/**
 * テーマを適用し、localStorage へ保存
 * @param {'light'|'dark'|'printer'} t
 */
export function setTheme(t);

/** 起動時に自動適用 (startup.js から呼ぶ) */
export function initTheme();
```

* `printer` の場合は `--color-bg` 等を `connection.color` で上書き
  （暫定：K1 = teal, K1-Max = orange）。

---

## 4. styles/themes.scss

```scss
:root[data-theme='light'] {
  --color-bg: #ffffff;
  --color-text: #1b1b1b;
  --card-bg: #f2f2f2;
}
:root[data-theme='dark'] {
  --color-bg: #181818;
  --color-text: #fafafa;
  --card-bg: #1a1a1a;
}
```

`root.scss` で `@use "styles/themes" as *;`

---

## 5. Bar_Title.js – メニュー追加

```js
const themeSub = [
  { id:'light',  label:'Light' },
  { id:'dark',   label:'Dark'  },
  { id:'printer',label:'Match Printer' }
];

menu.addSubMenu('Theme', themeSub, (id)=>{
  ThemeManager.setTheme(id);
});
```

* 既存ハンバーガーの dropdown 実装に合わせる
* `ThemeManager.getTheme()` と照合してチェックマーク表示

---

## 6. 起動フロー変更

```js
import { initTheme } from './core/ThemeManager.js';
initTheme();       // ← startup.js の一行目に追加
```

---

## 7. ストレージ方式の選択

| 方法                    | メリット      | デメリット            |
| --------------------- | --------- | ---------------- |
| **localStorage (採用)** | 単純・同期処理   | 同一ブラウザのみ／容量 5 MB |
| `indexedDB`           | 将来大量設定に強い | async API・実装コスト  |
| `file` (JSON インポート)   | バックアップ容易  | 手動操作必要           |

\*設定 1 レコード（テーマ名）のみ→ **localStorage で十分**。
今後プリンタ設定も保存する場合は `indexedDB` に切替できるよう **ThemeManager** 内部で

> `export const store = { get(k), set(k,v) }`
> のラッパーを用意しておく。

---

## 8. テスト仕様

### 8.1 Vitest unit (`theme.test.js`)

* `setTheme('dark')` → `document.documentElement.dataset.theme === 'dark'`
* localStorage に書かれる
* `initTheme()` が保存値を適用

### 8.2 Playwright e2e (`theme.spec.ts`)

1. 起動 → メニュー → **Dark** を選択
2. `body` の背景色が `rgb(24, 24, 24)` になる
3. Reload → Dark が保持される

---

## 9. CI 追加

`tests/unit/theme.test.js` は既存 Vitest ジョブで実行される。
Playwright ジョブに `theme.spec.ts` を追加するだけ。

---

## 10. 受け入れ基準 ✅

* ハンバーガー → Theme → 3 つ表示
* 選択即反映・リロード後も保持
* Vitest / Playwright グリーン
* Docs 追記完了（spec 反映）

---

### Codex 依頼例

```
Add theme switching (light/dark/printer) as per docs/develop/step7b_theme_switch.md:
- implement core/ThemeManager.js
- add styles/themes.scss + token overrides
- extend Bar_Title.js dropdown
- call initTheme in startup.js
- unit & e2e tests
```

---
