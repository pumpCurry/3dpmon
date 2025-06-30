### ⑦c ― Connections UI

- ハンバーガーメニューから "Connections" を開くモーダルを実装。
- IP とポートを入力して保存すると接続タブが追加され、localStorage に保持される。
- 保存済みの一覧では Delete ボタンで削除でき、EventBus へ `conn:remove` を送信。
- IP は `25[0-5]` 形式の正規表現で、ポートは 1-65535 を検証。
- ページ再読込後もタブが復元される。
