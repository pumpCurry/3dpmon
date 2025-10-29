# オリジナルリポジトリへのパッチ反映手順

fork したリポジトリで行った変更を元のプロジェクトに安全に送り返すための作業手順をまとめます。

## 1. `_orig.py` ファイルの役割

- 各 Python スクリプトのオリジナル版を `*_orig.py` として保持しておくことで、
  改修点を容易に比較できます。
- 変更箇所を確認する際は `diff -u module_orig.py module.py` を利用してください。

## 2. 機能ごとのブランチ戦略

1. `main` ブランチを最新状態に更新する
   ```bash
   git checkout main
   git pull upstream main
   ```
2. 追加機能や修正単位で新しいブランチを切る
   ```bash
   git checkout -b feature/<topic>
   ```
3. 対応する `*_orig.py` と差分を確認しながら修正を行う
   ```bash
   diff -u script_orig.py script.py
   ```
4. 修正内容ごとにコミットを小さくまとめる
   ```bash
   git add -p script.py
   git commit -m "feat: add new option to script"
   ```
5. ブランチ単位で GitHub に push し、fork 元へ PR を作成する
   ```bash
   git push origin feature/<topic>
   ```
6. PR では改修内容・背景・影響範囲を明記します。

## 3. 事故を防ぐポイント

- `main` では直接作業せず必ずブランチを切る
- こまめに `git fetch upstream` し、衝突を防ぐ
- `git rebase` ではなく `git merge` を用いて履歴を保持する
- レビューでは `_orig.py` との diff を添付し、変更意図を明確にする

## 4. PR 履歴の確認方法

- `node scripts/pr_history_generator.js` を実行すると、`docs/develop/pr_history.md` が再生成されます。
- このファイルにはこれまでの PR 番号と簡易的な概要が一覧化されています。

このワークフローを守ることで、オリジナルプロジェクトへ安全かつ効率的に変更を提案できます。
