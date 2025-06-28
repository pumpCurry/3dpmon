## 3 dp mon ― ダッシュボード再分割／ディレクトリ再編

**追加要求仕様 v2.0（カード・ディレクトリ分割／マイクロモジュール化）**
承認済み要件 1〜5 を踏まえ、現行 v1 系から v2 系へ安全に移行するための詳細仕様を下記にまとめる。

---

### 0. 目的

1. **UI 部品（カード／バー）を完全コンポーネント化**し、将来の機能追加・削除・テーマ変更を容易にする。
2. **ディレクトリ構造を再設計**し、カード単位・コア単位で責務を明確化。
3. 旧版 (`3dp_monitor.html`＋`3dp_lib/*.js`) を当面動作させつつ、**段階的に v2 へ移行**できる互換レイヤを用意。

---

### 1. 新ディレクトリ／ビルド構成

| パス              | 用途            | 備考                                                                  |
| --------------- | ------------- | ------------------------------------------------------------------- |
| **/docs**     |ドキュメント・マニュアル   | 説明などを書く                                 |
| **/docs/ja**     |日本語ドキュメント・マニュアル   | 説明などを書く                                 |
| **/docs/ja/manual**     |マニュアル   | 操作に対する説明などを書く                                 |
| **/docs/ja/develop**     |開発仕様書   | 開発に対する説明などを書く                                 |
| **/docs/en/**     |英語ドキュメント・マニュアル   | 日本語と同内容の説明などを英語で書く                                 |
| **/res**     | リソース         | 音、画像、他（マニュアル群の画像はここにはおかない）                                 |
| **/src/core**   | フレームワーク層      | `ConnectionManager.js`, `DashboardManager.js`, `ResourceWatch.js` … |
| **/src/cards**  | UI カード        | 各カード 1 ファイル＋ SCSS (同名)                                              |
| **/src/shared** | 共通ユーティリティ     | `utils/`, `i18n/`, `constants.js`, `themeTokens.css`                |
| **/src/legacy** | v1 互換         | 旧 `3dp_lib/` を ES6 module 化してラップ                                    |
| **/styles**     | css/ビルド前 SCSS まとめ | `root.scss`, `light.scss`, `dark.scss`                              |
| **/dist**       | ビルド出力         | ESBuild / Vite で吐き出す                                                |
| **/docs**       | 仕様書類          | README, future.md, ADR, Mermaid 図                                   |

> **ビルドツール候補** : **Vite**（ESM, HMR, Code-Splitting, SCSS ネイティブ）
> Node 18+、package.json に "type":"module" を宣言。

---

### 2. カード／バー コンポーネント仕様

#### 2.1 命名ルール
- ファイル名は`{要素}_{名前}.js` または、 `{要素}_{名前}_{副名称}.js` とする。
  -
- IDサフィックスは基本は4文字とする

#### 2.2 要素
|name|内容|説明|
|---|---|---|
|Bar|タイトルバー、メニューバーなど|縦または横に展開または閉じられる要素|
|Card|カード|移動できる配置要素|
|Popup/Pop|ポップアップ要素|メッセージボックスなどで提示する要素|
|Lib|ライブラリ|共通化要素|


| IDサフィックス | コンポーネント (新ファイル)       | 必須 Props                         | 主要責務                |
| --------- | --------------------- | -------------------------------- | ------------------- |
| **TTLB**    | `Bar_Title.js`         | `appName`, `build`, `tabData[]`  | 最上位バー、接続メニュー・タブバー統合 |
| **SIDE**    | `Bar_SideMenu.js`         | `appName`, `build`, `tabData[]`  | 左端に提供されるサイドメニューバー(予定) |
| **CAMV**   | `Card_Camera.js`       | `streamUrl`, `minSize`, `aspect` | アスペクト維持・再接続・スナップ    |
| **HDPV**   | `Card_HeadPreview.js`  | `position`, `model`              | X-Y-Z アイコン描画、モデル差分  |
| **STAT**  | `Card_Status.js`       | `statusObj`                      | 印刷・温度・エラー一覧         |
| **CTRL**  | `Card_ControlPanel.js` | `commands[]`                     | 手動操作ボタン群            |
| **PRNT** | `Card_CurrentPrint.js` | `jobInfo`                        | 進捗バー・残り時間           |
| **TEMP**  | `Card_TempGraph.js`    | `dataset`                        | Chart.js ラッパ        |
| **INFO**  | `Card_MachineInfo.js`  | `firmware`, `uptime`             | 機体情報・シリアル           |
| **FILE**  | `Card_HistoryFile.js`  | `history[]`, `fileList[]`        | 印刷履歴＋ファイルブラウザ       |
| **SETG**   | `Card_Settings.js`     | `configObj`                      | アプリ全体設定／JSON インポート  |

#### 共通 API / ライフサイクル

```js
export default class CameraCard extends BaseCard {
  static id = 'CAM';
  init(config, bus)          // 初期化
  mount(container)           // DOM 生成
  update(data)               // 状態反映
  destroy()                  // 破棄
}
```

* `BaseCard` が `scale`, `toggle`, `dragHandle` など標準機能を提供。
* **イベントバス** `bus.emit('CAM:update', payload)` でカード間通信。

---

### 3. index.html とブートシーケンス

```
/public/index.html
└ <body>
   ├ <div id="app-root"></div>
   ├ <noscript>警告</noscript>
   └ <script type="module" src="/src/startup.js"></script>
```

1. `startup.js`

   ```js
   import { initAuth } from './core/AuthGate.js';
   if (await initAuth()) {
     const { App } = await import('./core/App.js');         // Lazy
     new App('#app-root');
   }
   ```
2. `App` → `ConnectionManager.init()` → `DashboardManager.render()`
3. 各カードは `import()` による **Code-Splitting** で必要時ロード。

---

### 4. CSS / テーマ戦略

* **CSS 変数トークン** (`themeTokens.css`) で色・スペースを定義。
* 各カード SCSS は

  ```scss
  @use '../shared/mixins' as *;
  .camera-card { background: var(--card-bg); ... }
  ```
* ユーザー設定で **light / dark / custom HEX** を `:root` へ注入。
* 外部テーマファイル (`user-theme.css`) を SettingsCard からドラッグ＆ドロップ登録 → 自動 `<link>` 追加。

---

### 5. 互換レイヤ（過渡期）

| 項目         | 対応内容                                                    |
| ---------- | ------------------------------------------------------- |
| **旧 HTML** | `3dp_monitor.html` は現状維持し、バージョンアップ時 `/public/legacy.html` へリネームし移動、そのまま残す予定 |
| **名前空間**   | `window.DP_Legacy` に旧グローバルを再公開 (`export *` 経由)          |
| **互換 API** | `legacyAdapter.js` が v1 → v2 イベントをブリッジ                  |
| **切替スイッチ** | `index.html?mode=legacy` で自動リダイレクト                      |

---

### 6. 移行手順

| ステップ | 作業                                   | 完了条件                        |
| ---- | ------------------------------------ | --------------------------- |
| ①    | **Vite 雛形** 作成                       | `npm run dev` で空白画面         |
| ②    | `core/ConnectionManager.js` を ES6 化  | WebSocket1台で通信 OK           |
| ③    | `TitleBar` 実装＋タブレンダリング               | v1 と同等表示                    |
| ④    | CameraCard を分離                       | 旧プレビューを差替え、動作確認             |
| ⑤    | 各カードを順次分割                            | 1カードずつ移行、ユニットテスト緑           |
| ⑥    | SettingsCard 実装 → 起動認証 ON/OFF UI も統合 | 新設定保存復元 OK                  |
| ⑦    | legacyAdapter 完成                     | legacy.html と index.html 両立 |
| ⑧    | Playwright E2E パス                    | CI で緑                       |
| ⑨    | v2.0 タグ打ち、リリースノート公開                  | GitHub Release 掲載           |

---

### 7. 開発ガイドライン（抜粋）

1. **すべて ES2022+、`import.meta.url` 基準パス**
2. **JSDoc 必須**（現行ルール踏襲）
3. **カード 1 ファイル 1 クラス**、依存は `shared/` のみ
4. **外部ライブラリ追加時は `/docs/ADR/` に採用理由を記録**
5. **SCSS** は BEM + CSS 変数、!important 禁止

---

### 8. 期待効果

* 機能追加・除去が **カード単位** で完結 → メンテ容易
* ビルド時 Code-Splitting により **初期ロード 30 % 短縮**
* テーマ／拡張 CSS をユーザーが差し替え可能
* v1 を温存することで **既存運用を止めず** テスト移行できる

---

以上を **v2.0 要求仕様** として確定とし、スプリント計画に沿って実装を進める。
追加質問・修正希望があれば随時フィードバックください。

