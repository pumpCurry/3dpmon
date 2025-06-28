## ステップ②レビューまとめ

| 観点               | 状態 | コメント |
| ---------------- | -- | -------------------------------------------------------------- |
| **構造**           | ◯  | `src/core/ConnectionManager.js` / `EventBus.js` / `utils/hash.js` 追加済み。API シグネチャは要件通り。 |
| **WebSocket 動作** | ◯  | `npm run mock`＋`npm run dev` で Echo フレーム確認。 |
| **ユニットテスト**      | △  | `vitest` が **`ws` ESM 解決エラー**で failure。`crypto.subtle` も Node18 で Experimental 警告。 |
| **CI**           | ✕  | GitHub Actions 未設定。 |
| **ドキュメント**       | ✕  | テスト仕様書が未作成。 |

**結論**

* **テストと CI が RED** のため、まだ “All Green” ではない。
* 以下の **修正＋増強手順** を適用してからステップ③へ進むことを推奨。

---

## ステップ② ― 修正 & 増強手順書

### 2.1 作業概要

| タスクID | 内容 |
| ----- | ---------------------------------------- |
| T2-1  | `vitest.config.js` 追加、Node 環境指定 |
| T2-2  | `utils/hash.js` を `node:crypto` ベース実装へ変更 |
| T2-3  | `__mocks__/ws.js` を作成し Vitest で自動スタブ |
| T2-4  | ユニットテスト `tests/connection.test.js` 追加 |
| T2-5  | GitHub Actions CI（`ci.yml`）を追加 |
| T2-6  | **テスト仕様書** `docs/develop/tests.md` を新規作成 |
| T2-7  | README に “Run tests” セクションリンクを追加 |

### 2.2 具体手順

詳細コマンドやコード例は `step2_connection_manager.md` を参照。主な流れは以下の通り。
1. `vitest` と `sinon` を devDependencies へ追加し、`vitest.config.js` を作成する。
2. `utils/hash.js` を Node.js `createHash` ベースに書き換える。
3. テスト用 `WebSocket` モックを `tests/__mocks__/ws.js` に配置し、Vitest から自動読み込みするよう `tests/setup.js` を用意。
4. `ConnectionManager` の挙動を確認するユニットテスト `tests/connection.test.js` を実装。
5. `.github/workflows/ci.yml` を追加し、push/pull_request 時に `npm test` を実行。
6. テスト仕様書 `docs/develop/tests.md` を作成し、カバレッジ 80%以上を成功基準として明記。
7. README から当仕様書へリンクし、開発者がテストを実行しやすいよう説明を補足。

### 2.3 完了チェックリスト

- [ ] `npm test` 全緑 & カバレッジ表示
- [ ] `npm run dev` 問題なし
- [ ] `ci.yml` で GitHub 上も PASS
- [ ] `docs/develop/tests.md` 追加
- [ ] README 更新

以上を満たした状態を “ステップ②完了 (All Green)” と呼称する。
