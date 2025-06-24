@echo off
REM 3dpmon 起動バッチ
REM バッチファイルの存在するディレクトリに移動して HTTP サーバーを起動します
cd /d "%~dp0"
python -m http.server 8000

