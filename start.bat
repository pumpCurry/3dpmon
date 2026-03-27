@echo off
REM 3dpmon 起動バッチ
REM Electron版またはHTTPサーバー版を起動します
cd /d "%~dp0"

REM node_modules が存在しない場合は npm install を実行
if not exist "node_modules" (
  echo 依存パッケージをインストール中...
  npm install
)

REM 引数に "http" が指定された場合は従来のHTTPサーバーモード
if "%1"=="http" (
  echo HTTPサーバーモードで起動中 ポート8313...
  python -m http.server 8313
) else (
  echo Electronアプリを起動中...
  npx electron .
)
