# TitleBar 実装ガイド

TitleBar は最上位に表示されるバーで、接続タブの管理を行う。ここでは基本構造とイベント挙動をまとめる。

## 1. 概要
- `Bar_Title.js` で `TitleBar` クラスを定義し `BaseBar` を継承。
- `setTabs()` でタブ情報を渡し、`activate()` で選択状態を切り替える。
- タブをクリックすると `tab:select` が EventBus へ emit される。

## 2. DOM 構成
```html
<div class="title-bar">
  <button class="hamburger">≡</button>
  <nav class="tabs">
    <button class="tab">A</button>
    …
  </nav>
</div>
```

8 枚以上のタブは横スクロールとなり、左右端はフェードで区切られる。

## 3. キーボード操作
左右キーで `.active` を移動させ、変更時にも `tab:select` を発火させる予定。

## 4. テスト
`tests/titlebar.test.js` ではクリックでイベントが発火するかを確認する。
