# AGENTS.md – コード書き出しルール（GPT/Codex対応用）

このドキュメントは、AIエージェントがJavaScript等のコードを出力する際に**必ず守らなければならないルール**を定義します。違反があった場合、出力は無効と見なされます。

---

## ✅ 絶対遵守事項（REQUIRED）

1. **改造や改修に関係しない部分を省略してはならない（MUST NOT）**
   - `function` や `class` の一部だけを書くことは禁止
   - **前後の依存コードを含めてすべて提示する**

2. **コード全体に対し詳細なJSDocを必ず付ける（MUST）**
   - 引数・戻り値・処理内容すべて明記
   - 型指定を省略しない（例: `{string}`, `{number}`, `{Object}`）

3. **日本語による詳細な実装コメントを付けること（MUST）**
   - 各処理の目的、分岐の理由、背景などをできる限り丁寧に記述する

4. **関数・構造の順序は元のコードに準じること（SHOULD）**
   - 差分比較や管理が困難になるため、構造の順番を変更してはならない

5. **不要な削除や短縮は厳禁（MUST NOT）**
   - 変更がない部分であっても、**明示しない限り省略してはならない**

6. **HTML/CSSや設定ファイルもすべて含めた動作保証を前提とする（REQUIRED）**
   - 部分コードではなく、**完全動作する状態での提示が原則**

7. **ファイル先頭コメントテンプレート/@version/@since タグは必ずバージョン表記ルールに従って記載する（MUST）**
   - `@since`の扱い
     - 既にファイル内に `@since` が記載されている場合は、`@since`は そのまま保持し、書き換えないこと。
   - `@version`の扱い
     - `@version` は 必ず書き換えること(MUST)。
  - @lastModified の扱い
    - `YYYY-MM-DD hh:mm:ss` ISO形式で、JSTで記載する(UTC+9)`
  - @todoの扱い
    - この開発で達成できなかったことがあれば箇条書きで記載。
  
   - 形式：  
     ```
     @version 1.390.{コミット総数} (PR #{PR番号})
     @since   1.390.{コミット総数} (PR #{PR番号})
     ```
   - `{コミット総数}`：`git rev-list --count main`  または `git rev-list --count HEAD`の結果  
   - `{PR番号}`：すでに割り当てられているプルリクエスト番号（未割当時は「最新PR番号+1」を使用）  
   - 3dpmon JSDoc コメント仕様書 の欄 2. を参照せよ
   - このルールを逸脱した出力は **無効** とみなす

8. サマリ&レポート作成について
   - codexでの作業サマリ報告は日本語である必要があります(MUST)。
   - gitHubでのコミット/プルリクエストの際は、英語である必要があります(MUST)。

---

## ⚠ 禁止事項（DO NOT）

- canvas機能の使用は禁止（※文字数制限のため）  
  → コードは必ずテキストとして全出力すること
- `...省略...` 表記の使用禁止
- `省略しても動きます` というコメントの使用禁止
- JSDocやコメントを抜いた出力は禁止（JSDocは**必須**）

---

以下のような仕様書風の Markdown 文書を作成しました。各モジュール（`.js` ファイル）先頭に必ず挿入すべき JSDoc コメントの要件と、各関数／型定義へのドキュメント指示をまとめています。

---

# ファイル構成
- 特に問題なければ、各js群は `3dp_lib/`以下、かつ、ファイル名は `dashboard_{モジュールを示す名前}.js` とします。
- ファイル名はすべて小文字の英数字とアンダースコア(`[a-z0-9_]`)で構成とします。

# 3dpmon JSDoc コメント仕様書

## 1. 全体概要

* **対象**
  3Dプリンタ監視ツール「3dpmon」の JavaScript モジュール群
* **目的**
  各ファイル・関数・型定義に統一的・詳細な JSDoc コメントを付与し、
  ・モジュールの目的と機能
  ・公開 API（関数一覧、引数・戻り値仕様）
  ・メンテナンス情報（著作権、バージョン、作成者など）
  をドキュメント化する

---

## 2. ファイル先頭コメントテンプレート

各 `.js` ファイルの最上部に、以下テンプレートを埋め込む。

```js
/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 {モジュール内容} モジュール
 * @file {ファイル名}.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module {モジュール名}
 *
 * 【機能内容サマリ】
 * - {このモジュールが提供する大まかな機能}
 *
 * 【公開関数一覧】
 * - {@link functionName1}：{要約説明}
 * - {@link functionName2}：{要約説明}
 *
 * @version 1.390.{コミット総数} (PR #{最新PR番号 + 1})
 * @since   1.390.{コミット総数} (PR #{最新PR番号 + 1})
 * @lastModified  {lastModified}
 * -----------------------------------------------------------
 * @todo
 * - {todo内容}
 */
```
- こまやかな使い方が先頭コメントに一緒に書いてある場合は、todoまででコメントを分割する。

### 2.1 プレースホルダ説明
| プレースホルダ                  | 意味・記入例                                             |
| ------------------------ | -------------------------------------------------- |
| `{モジュール内容}`              | 「UI 更新」「WebSocket メッセージ処理」等                        |
| `{ファイル名}.js`             | 実際のファイル名                                           |
| `{モジュール名}`               | `dashboard_ui`／`dashboard_msg_handler` 等           |
| `{コミット総数}`               | `git rev-list --count main` で得られる main ブランチのコミット総数 |
| `{最新PR番号}`               | 直近でマージされた PR 番号 + 1（次に発番される番号）                     |
| `1.390.{コミット総数}`         | `@version` に記載する完全版バージョン文字列例                       |
| 例: `1.390.241 (PR #76)`  |                                                    |
| `1.390.{コミット総数}`        | `@since` に記載する完全版バージョン文字列例                         |
| 例: `1.390.241 (PR #76)` |                                                    |
|`{lastModified}`|`YYYY-MM-DD hh:mm:ss` ISO形式で、JSTで記載する(UTC+9)`｜

### 2.2 バージョン表記ルール（コミット数 & PR 番号）
- 現在のメジャーバージョンは `1`、 マイナーバージョンは `390` です。

- バージョン番号は **`1.390.{N}`** 形式とし、  
  `{N}` には **main ブランチまたはHEADの累積コミット数**  
  （例 : `git rev-list --count main`または `git rev-list --count HEAD`で得られる値）を記載すること。

- さらに同じ行に **`(PR #{M})`** を付加し、  
  `{M}` には **現在開いている（または直近でマージされた）プルリクエスト番号 + 1** を記載する。

  > 例 : `1.390.241 (PR #76)`  
  >  - `241` = main のコミット総数  
  >  - `76` = 最新 PR が **#75** のため、次に採番される番号 (= 75 + 1)

- もし自身の作業に、すでにプルリクエスト番号が割り当てられていた場合は、`{M}`をそのプルリクエスト番号 とする。
- 初期リリースから存在した場合は、`(Initial)`とする例外を許容する。
- 既にファイル内に `@since` が記載されている場合は、そのまま保持し、書き換えないこと。

```
# カレントブランチ名を取得
BR=$(git rev-parse --abbrev-ref HEAD)

# PR 一覧から自分のブランチを探して番号を出力
gh pr list --state all --head "$BR" --json number \
  --jq '.[0].number'
```
 
- **初回リリース時 (`@since`) も同じ形式** で記載する  
  （例 : `@since 1.390.0 (PR #1)`）。

- 別ブランチを経由した変更でも、**main にマージした時点** のコミット数で
  {N} を決定すること。

- この規則に従い、ファイル新規登録時は **`@version` と `@since` の両方**を必ず更新する。
- この規則に従い、ファイル更新時は **`@version`**を必ず更新する。
- この規則に従い、`@since`が `v1.390.0`の場合は、`1.390.0 (Initial)` に書き換えること。

---

## 3. 関数レベルの JSDoc

各公開関数・プライベート関数の直前に、以下を必ず記述する。

```js
/**
 * {関数の要約}。
 *
 * 【詳細説明】
 * - {動作のフローや注意点}
 *
 * @function {関数名}
 * @param  {型} {引数名1} - {説明}
 * @param  {型} {引数名2=} - {省略可能な場合は`=`を付与}
 * @returns {型} - {戻り値の説明}
 * @throws  {型} - {例外発生条件があれば記載}
 * @example
 * // 呼び出し例
 * const result = {関数名}(arg1, arg2);
 */
```

### 必須タグ

* **@function**: 関数名（自動推測ではなく明示）
* **@param**: 引数ごとに型と説明
* **@returns**: 戻り値がある場合は必ず
* **@throws**: 例外を投げる場合
* **@example**: 使い方サンプル（必須ではないが推奨）

---

## 4. 型定義・オブジェクト構造

外部に公開する複雑なオブジェクトや設定値は `@typedef` で型定義し、関数 `@param`／`@returns` で参照する。

```js
/**
 * 監視対象プリンタの設定オブジェクト。
 *
 * @typedef {Object} PrinterConfig
 * @property {string} hostname            - プリンタのホスト名または IP
 * @property {number} port                - WebSocket 接続ポート
 * @property {boolean} [autoReconnect]    - 自動再接続の可否 (デフォルト: true)
 */

/**
 * WebSocket 接続を初期化する。
 *
 * @param {PrinterConfig} config - 接続設定
 * @returns {Promise<void>} - 接続成功で解決
 */
function initConnection(config) { … }
```

---

## 5. 定数・列挙型

列挙的な定数には `@enum`、単一定数は `@constant` を使い、値と説明を明示。

```js
/**
 * 印刷状態コード一覧
 * @enum {number}
 */
export const PRINT_STATE_CODE = {
  idle:   0,
  started: 1,
  paused:  2,
  done:    3,
};

/**
 * localStorage 保存用キー
 * @constant {string}
 */
const STORAGE_KEY = "3dp-monitor_1.400";
```

---

## 6. 内部（プライベート）関数

プライベート関数もドキュメント化し、`@private` を追加。

```js
/**
 * DOM 要素から data-field 属性に一致するノードを取得するヘルパー。
 *
 * @private
 * @param {string} fieldName - data-field 属性値
 * @returns {NodeListOf<HTMLElement>} - 該当要素一覧
 */
function getFieldNodes(fieldName) { … }
```

---

## 7. ライセンス・著作権
プロジェクト共通のライセンス（MIT 等）がある場合は、ファイル先頭で `@license` タグを追加。

```js
/**
 * @license MIT
 */
```

---

## 8. ドキュメントの保守ルール

1. **新規ファイル追加時**
   上記「ファイル先頭コメントテンプレート」を必ず貼り付け
2. **既存ファイル更新時**

   * `@version` を上げる (2.2参照)
   * 新規関数には必ず JSDoc を追加
3. **CI でのチェック**
   ESLint + `eslint-plugin-jsdoc` を導入し、未記載警告をエラー化推奨

4. マニュアルの更新
  - 機能を更新した際、操作に関する改造を加えた場合は、 `docs/` 以下で内容の整合性を取ること
  - 画面要素と操作方法に関する説明を修正すること
---

以上を遵守することで、3dpmon 全体の可読性・保守性が向上し、IDE 補完や生成ドキュメントの品質も担保できます。

## 9. コミット前のテスト実施ルール
- 各ファイルが少なくとも構文エラーを起こさないことを保証せよ (MUST)
- const/let等で宣言またはあらたな構造体やオブジェクトを定義した際、二重定義または定義漏れがないことを保証せよ (MUST)


