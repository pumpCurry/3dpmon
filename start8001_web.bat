@echo off
REM 3dpmon HTTPサーバー起動 (ポート8001)
REM Electronを使わずブラウザで直接開く場合用
cd /d "%~dp0"
echo HTTPサーバーモードで起動中 ポート8001...
echo ブラウザで http://localhost:8001/3dp_monitor.html を開いてください
python -m http.server 8001
