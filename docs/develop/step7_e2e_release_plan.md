## ステップ⑦ ― E2E とリリース準備計画

`future.md` に基づき、ステップ⑦で実施する E2E 自動テスト導入とリリースパッケージ化の作業内容をまとめる。

### 1. 目的
- UI 統合テストを Playwright で自動化し回帰を防ぐ。
- dist.zip と Docker イメージを生成し、GitHub Release へ添付する。

### 2. 新タスク
| ID | 内容 | 完了基準 |
|----|------|---------|
|T7-A|Playwright 導入 (`@playwright/test`) | `npm run e2e` 実行でテスト成功|
|T7-B|E2E シナリオ追加 | テスト緑かつ動画アーティファクト保存|
|T7-C|e2e.yml Workflow | CI 緑、timeout-minutes 25 設定|
|T7-D|Dockerfile 作成 | `docker run -p8080` で起動確認|
|T7-E|GitHub Release assets | dist.zip とイメージ push|
|T7-F|ユーザーマニュアル更新 | 操作説明とスクリーンショット完備|
|T7-G|ライセンス一覧整理 | OSS ライセンス記載|

### 3. CI 拡張
```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 18 }
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npm run build
      - run: npm run e2e
```
`while sleep 540; do echo 'still running'; done &` をテスト前に実行し、無出力 10 分タイムアウトを防止する。

### 4. ブランチ
```bash
git checkout -b feature/v2-step7-e2e-release
```
