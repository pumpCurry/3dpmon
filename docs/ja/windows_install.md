# Windows 版セットアップガイド

このドキュメントは Windows 環境で 3dpmon を動作させるための Python 環境構築手順を説明します。

## 1. 前提条件
- Windows 10 以降
- Python 3.10 以上
- Internet 接続環境
- NVIDIA GPU (不要ですが使用可能)

## 2. venv を用いた初回セットアップ
1. リポジトリを展開し、そのフォルダでコマンドプロンプトまたは PowerShell を開きます。
2. 仮想環境を作成
   ```bat
   python -m venv venv
   ```
3. 仮想環境を有効化
   ```bat
   .\venv\Scripts\activate
   ```
4. pip の更新と必要なモジュールをインストール
   ```bat
   python -m pip install --upgrade pip
   pip install -r requirements.txt
   ```
   `requirements.txt` にモジュール一覧が含まれているので、経験が無いマシンでも以下の `setup_windows.bat` を実行すれば一括で済みます。
5. 自動化スクリプト
   ```bat
   setup_windows.bat
   ```

## 3. nvidia-smi が無い環境
NVIDIA GPU を利用する場合、`nvidia-smi` コマンドが存在することを確認します。存在しない場合は
CUDA 対応ドライバ・ドライバ・パッケージをインストールし、再度実行してください。GPU が不要な場合は CPU 版の PyTorch のみインストールすれば十分です。

## 4. GPU 利用確認
インストール後、以下のコマンドで GPU が利用可能か確認できます。

```bat
python check_gpu.py
```

```python
import torch

def main():
    """GPU 利用可否を出力します。"""
    avail = torch.cuda.is_available()
    print(f"GPU available: {avail}")

if __name__ == "__main__":
    main()
```

`check_gpu.py` をファイルとして保存し、リポジトリ直下で実行してください。

## 5. ディレクトリ構造
```
3dpmon/
├── 3dp_monitor.html
├── 3dp_monitor.css
├── 3dp_lib/
│   ├── *.js
│   └── res/
│       └── sound/
├── docs/
│   ├── ja/
│   └── en/
├── favicon.ico
└── README.md
```

## 6. 初回に用意すべきファイル
- `3dp_lib/res/fonts/` へ、表示に使用するフォントファイル (`NotoSansJP-Regular.woff2` など) を配置
- `3dp_lib/res/sound/notice.mp3` は通知音に利用されます
- 設定ファイルを作成する場合は `config/` ディレクトリを用意し、テンプレートをコピーしてください
