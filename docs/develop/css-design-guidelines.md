# CSS設計ガイドライン — 3DPMON

> **Version**: 1.0 (Phase 1 完了時点)
> **Last Updated**: 2026-03-24
> **対象**: `3dp_panel.css`, `3dp_monitor.css`, 全JSファイル

---

## 1. デザイントークン

### 1.1 原則

**全てのスタイル値はCSS Custom Properties（トークン）経由で参照する。**

ハードコードのHexカラー、px固定値、z-indexの直書きは禁止。

```css
/* ✗ NG */
.my-button { background: #4090d0; font-size: 12px; z-index: 3000; }

/* ✓ OK */
.my-button { background: var(--color-btn-primary); font-size: var(--font-sm); z-index: var(--z-modal); }
```

### 1.2 トークン一覧

`:root` に定義済み（`3dp_panel.css` 冒頭）:

| カテゴリ | プレフィックス | 例 |
|---------|--------------|-----|
| 背景色 | `--color-bg-*` | `--color-bg-primary`, `--color-bg-secondary`, `--color-bg-tertiary`, `--color-bg-page`, `--color-bg-hover` |
| テキスト色 | `--color-text-*` | `--color-text-primary`, `--color-text-secondary`, `--color-text-muted`, `--color-text-inverse` |
| ボーダー色 | `--color-border*` | `--color-border`, `--color-border-light`, `--color-border-strong` |
| アクセント色 | `--color-accent*` | `--color-accent`, `--color-accent-hover`, `--color-accent-light` |
| セマンティック | `--color-{success\|warning\|danger\|info}*` | 各色に `-bg`, `-text`, `-hover` バリアント |
| UIコンポーネント | `--color-{modal\|panel\|table\|input}*` | モーダル、パネルヘッダ、テーブル系の色 |
| 状態バッジ | `--color-badge-*` | `mounted`, `stored`, `exhausted`, `inventory`, `discarded` |
| z-index | `--z-*` | `base(0)`, `sticky(10)`, `topbar(100)`, `confirm(1000)`, `modal(3000)`, `modal-sub(4500)`, `panel-menu(5500)`, `toast(9000)` |
| スペーシング | `--space-{1..6}` | 4px, 8px, 12px, 16px, 24px, 32px |
| フォントサイズ | `--font-{xs..2xl}` | 10px, 12px, 14px, 16px, 20px, 24px |
| ボーダー半径 | `--radius-{sm\|md\|lg\|full}` | 4px, 8px, 12px, 9999px |
| シャドウ | `--shadow-{sm\|md\|lg\|modal}` | 段階的シャドウ |
| トランジション | `--transition-{fast\|normal}` | 150ms, 250ms |

### 1.3 ダークテーマ

- `@media (prefers-color-scheme: dark)` で自動適用
- `.theme-dark` クラスで手動切替も可能
- 全てのトークンがダークテーマ用に再定義済み

### 1.4 新しいトークンを追加する場合

1. `:root` ブロックの適切なカテゴリに追加
2. ダーク用の `@media` ブロックと `.theme-dark` ブロックの**両方**に追加
3. コメントで用途を明記

---

## 2. インラインスタイル規約

### 2.1 禁止パターン

```javascript
// ✗ NG: 静的なレイアウトやテーマ色をインラインで設定
el.style.cssText = "display:flex;gap:8px;background:#fff;";
el.style.fontSize = "12px";
el.style.color = "#888";
```

### 2.2 許可パターン

```javascript
// ✓ OK: 動的に計算される値（ランタイム依存）
el.style.width = `${calculatedWidth}px`;
el.style.background = dynamicColor;  // ユーザー設定の色
el.style.display = isVisible ? "" : "none";  // 表示トグル
canvas.style.transform = `translate(${x}px, ${y}px)`;  // 3D描画
```

### 2.3 判断基準

| 値の種類 | 方法 | 例 |
|---------|------|-----|
| 固定色（テーマ色） | CSSクラス + トークン | `background: var(--color-bg-primary)` |
| 動的色（ユーザー指定色） | style属性 | `style="background:${userColor}"` |
| 固定レイアウト | CSSクラス | `.flex-row { display: flex; gap: 6px; }` |
| 動的サイズ | style属性 | `el.style.width = px` |
| 表示切替 | style.display | `el.style.display = "none"` |
| 3D描画 | style属性 | canvas の position/transform |

---

## 3. CSSクラス命名規約

### 3.1 コンポーネントプレフィックス

| コンポーネント | プレフィックス | ファイル |
|--------------|--------------|---------|
| フィラメント管理 | `fm-` | dashboard_filament_manager.js |
| フィラメント交換 | `fc-` | dashboard_filament_change.js |
| 印刷管理 | `pm-` | dashboard_printmanager.js |
| 接続設定 | `conn-` | dashboard_connection.js |
| パネル | `panel-` | dashboard_panel_*.js |
| 通知設定 | `notif-` | dashboard_notification_manager.js |
| 確認ダイアログ | `confirm-` | dashboard_ui_confirm.js |
| スプール編集 | `spool-dialog-` | dashboard_spool_ui.js |

### 3.2 ユーティリティクラス

| クラス | 用途 |
|-------|------|
| `btn-font-xs` / `btn-font-sm` | ボタンのフォントサイズ |
| `color-swatch-{sm\|md\|lg\|xl}` | カラースウォッチ表示 |
| `text-muted-xs` / `text-secondary-xs` | 副情報テキスト |
| `text-right` / `font-mono` | テキスト配置 |
| `flex-row` / `flex-col` / `flex-1` | フレックスレイアウト |
| `scroll-box` | スクロール可能ボックス |
| `chart-constrained` / `chart-constrained-lg` | チャート高さ制限 |

### 3.3 分析・統計カード

| クラス | 用途 |
|-------|------|
| `drilldown-panel` / `drilldown-header` / `drilldown-close` | ドリルダウン |
| `stat-cards` / `stat-card` | 統計カードグリッド |
| `stat-card-label` / `stat-card-value` / `stat-card-sub` | カード内容 |
| `analysis-fieldset` | 分析フィールドセット |
| `summary-grid` / `summary-card` | 集計レポートサマリー |

---

## 4. 新規コンポーネント追加時のチェックリスト

- [ ] 全色はトークン `var(--color-*)` を使用しているか
- [ ] フォントサイズは `var(--font-*)` を使用しているか
- [ ] z-index は `var(--z-*)` を使用しているか
- [ ] ボーダー半径は `var(--radius-*)` を使用しているか
- [ ] インラインスタイルは「動的値のみ」か
- [ ] 新CSSクラスは適切なプレフィックスを持つか
- [ ] `3dp_panel.css` に追加したか（JS内 `injectStyles` は使わない）
- [ ] ダークテーマで色が反転しても読めるか

---

## 5. 動的スタイルが許容されるファイル

以下のファイルは3D描画やキャンバス操作のため、`el.style.*` の使用が多数残る。
これらはCSSクラス化の対象外とする。

| ファイル | 残インラインスタイル数 | 理由 |
|---------|---------------------|------|
| `dashboard_filament_view.js` | ~99 | 3Dフィラメントプレビューのキャンバスリサイズ、transform、position |
| `dashboard_stage_preview.js` | ~57 | ヘッド位置プレビューのキャンバス座標計算、スケール変換 |
| `dashboard_filament_manager.js` | ~34 | テンプレート内の `text-align:right`、動的色、`display` トグル |
| `dashboard_printmanager.js` | ~20 | テンプレート内の動的色、サムネイルスタイル |

---

## 6. Phase 1 完了時の残タスク

### 将来のCSS改善

1. **`text-align: right` のクラス化**: テーブルヘッダーで `style="text-align:right"` が多用されている → `data-align="right"` 属性 + CSS `[data-align="right"] { text-align: right; }` に統一検討
2. **filament_view/stage_preview のリファクタ**: 3D描画ロジック自体をCSS Transform主体に移行する場合に検討
3. **CSS Modules / Scoped Styles**: Electron アプリのため現時点では不要だが、Web版展開時に検討
4. **テーマカスタマイズUI**: ユーザーがアクセントカラーやフォントサイズを設定パネルから変更できる仕組み

---

## 付録: Phase 1 実施統計

| 指標 | 値 |
|------|-----|
| 定義トークン数 | 60+ (ライト) + 60+ (ダーク) |
| CSS置換箇所（3dp_panel.css） | ~90色 + 35フォント + 15 z-index |
| CSS置換箇所（3dp_monitor.css） | ~66色（95→29残、3D描画用） |
| JS injectStyles抽出 | 4ファイル, 111 CSSルール |
| JSインラインスタイル削減 | connection: 21→1, filament_manager: 85→34, printmanager: 6→~20 |
| 新規CSSクラス定義 | ~80クラス |
| テスト | 123件 全グリーン維持 |
