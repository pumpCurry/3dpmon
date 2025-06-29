## ステップ⑦ ― E2E & リリース準備計画

`future.md` ステップ⑦相当の作業を整理したドキュメント。Playwright による統合テストと Docker パッケージングを追加し、v2.0 RC へ向けたリリース体制を整える。

### 1. 背景と目的
- TempGraphCard + SideMenu が実装済み（PR #259）で UI 全体が揃った。
- これ以降はブラウザ上での動作を包括的に検証し、配布物を生成してリリース候補とする。

### 2. 主要ファイル構成
```
.github/workflows/e2e.yml      ★新規
Dockerfile                     ★新規
release.zip                    ★CI生成
src/**                         既存コードを使用
```

### 3. 実装タスク
| ID   | 内容                                                         | 完了基準                           |
|------|------------------------------------------------------------|------------------------------------|
|T7-A |Playwright 導入 (`@playwright/test`)                          |`npm run e2e` がローカルで緑          |
|T7-B |E2E シナリオ作成：複数接続→タブ切替→カメラ再接続、温度グラフ hover 等|テスト動画アーティファクト確認       |
|T7-C |CI ワークフロー `e2e.yml` 追加、`timeout-minutes:25` と keep-alive |GitHub Actions で PASS               |
|T7-D |`Dockerfile` 作成、`docker run -p8080` で dist を配信          |ローカル確認で index.html 表示       |
|T7-E |GitHub Release へ dist.zip と docker image を添付             |draft v2.0-rc が生成される           |
|T7-F |ユーザーマニュアル `docs/ja/manual/` 充実                      |スクリーンショット付きで操作解説完備   |
|T7-G |OSS ライセンスとサードパーティ表記整理                         |NOTICE ファイル作成                   |

### 4. ブランチ & ワークフロー
```
git checkout -b feature/v2-step7-e2e-release
# 上記タスク T7-A ... T7-G を順に実施
```
