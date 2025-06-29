# Windows + WSL (Ubuntu 22.04.5 LTS) で 3dpmon v2 を Docker なしで動かす

このドキュメントでは、Windows 上の WSL2 環境で Ubuntu 22.04.5 を利用し、3dpmon v2 を Docker を使わずに実行する手順をまとめます。インストール先は `D:\3dmon` (WSL 側では `/mnt/d/3dmon`) を想定します。

---

## ⚡ 概要

1. WSL2 と Ubuntu 22.04.5 を準備
2. 必要なパッケージを導入 (Git・Node.js 18/20 LTS・Corepack 等)
3. D ドライブにクローン → `npm install` → `npm run dev` で開発開始
4. `npm run build` → `npx serve dist` で本番配信
5. (任意) systemd / `serve` をサービス化

---

## 1. 前提: WSL と D ドライブのマウント

Windows 側で WSL2 を有効化し、Ubuntu 22.04.5 をインストール済みとします。`wsl -l -v` で VERSION=2 を確認してください。D ドライブは `/mnt/d` として自動マウントされます。

```bash
# Ubuntu ターミナル (WSL) を起動
cd /mnt/d
mkdir -p 3dmon
```

---

## 2. 必須パッケージのインストール

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential curl git

# Node.js 20 LTS (NodeSource PPA)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Corepack を有効化
corepack enable
```

> 別案として `nvm` で Node.js を入れることも可能です。

---

## 3. ソース取得 (/mnt/d/3dmon)

```bash
cd /mnt/d/3dmon
git clone https://github.com/pumpCurry/3dpmon.git .
```

SSH キーを利用する場合は Microsoft Learn などの手順を参照してください。

---

## 4. 開発モードで起動

```bash
npm install    # lockfile があれば npm ci でも可
npm run dev    # http://localhost:5173 でダッシュボード表示
```

開発サーバーは WSL 内からでも Windows ブラウザでそのまま利用できます。

---

## 5. 本番ビルド & 静的サーバー

```bash
npm run build
npx serve dist -l 8080
```

`serve` をグローバルインストールする場合は `sudo npm install -g serve` を実行してください。

---

## 6. (任意) systemd サービス化

```ini
# /etc/systemd/system/3dmon.service
[Unit]
Description=3dpmon Dashboard
After=network.target

[Service]
WorkingDirectory=/mnt/d/3dmon
ExecStart=/usr/bin/serve dist -l 8080 -s
Restart=on-failure
User=$USER
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now 3dmon
```

---

## 7. GitHub Actions の無通信タイムアウト対策

```yaml
timeout-minutes: 25
- name: keep-alive
  run: |
    (while sleep 540; do echo 'alive'; done) &
```

---

## 8. 動作確認チェックリスト

| 項目 | コマンド例 |
| ---- | ---------- |
| Node & npm 版本 | `node -v && npm -v` |
| Corepack 有効化 | `corepack enable && corepack prepare pnpm@latest --activate` |
| 依存 install 済 | `npm ls --depth 0` |
| Vite dev 起動 | `npm run dev` 実行後、`Local:` URL が表示されること |
| ビルド成功 | `npm run build` 実行後、`dist/` に `index.html` が生成されること |
| 本番配信 | `curl -I http://localhost:8080` で 200 OK が返ること |

---

以上で、Windows 上の Ubuntu 22.04 LTS (WSL2) に Docker を使用せず 3dpmon を導入・起動する手順は完了です。
