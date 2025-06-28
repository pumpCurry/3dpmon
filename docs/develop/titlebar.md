# TitleBar 実装ガイド

TitleBar は最上位に表示されるバーで、接続タブの管理を行う。ここでは基本構造とイベント挙動をまとめる。

## 1. 概要
- `Bar_Title.js` で `TitleBar` クラスを定義し `BaseBar` を継承。
- `setTabs()` でタブ情報を渡し、`activate()` で選択状態を切り替える。
- タブをクリックすると `tab:select` が EventBus へ emit される。
- `addTab()` / `removeTab()` ではそれぞれ `tab:add` / `tab:remove` を発火。
- `role="tablist"` と `role="tab"` による A11y 属性を付与。
- 左右キーでタブ移動、Enter キーで選択イベントを再発火。

### 公開メソッド
| メソッド名 | 概要 |
| --- | --- |
| `mount(root)` | DOM 生成し指定要素へ挿入する |
| `setTabs(tabs)` | タブ一覧を設定する |
| `addTab(meta)` | 新しいタブを末尾に追加 |
| `removeTab(id)` | 指定 ID のタブを削除 |
| `activate(id)` | アクティブタブを変更し `tab:select` 発火 |

## 2. DOM 構成
```html
<div class="title-bar">
  <button class="hamburger">≡</button>
  <nav class="tabs" role="tablist">
    <button class="tab" role="tab" aria-selected="true">A</button>
    …
  </nav>
</div>
```

8 枚以上のタブは横スクロールとなり、左右端はフェードで区切られる。
CSS 側では `mask-image` と `-webkit-mask-image` を指定して Safari でも陰影が崩れないようにする。

## 3. キーボード操作
`nav.tabs` へ `keydown` リスナーを持ち、以下の動作を行う。
- ← / → : 隣接タブへフォーカスと `.active` を移動。
- Enter : 既にアクティブなタブを再選択（`tab:select` 発火）。

## 4. テスト
`tests/titlebar.test.js` ではクリック、タブ追加・削除、キーボード操作の各ケースを検証する。
