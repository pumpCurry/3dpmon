@echo off
REM 3dpmon 起動バッチ
REM Electron版またはHTTPサーバー版を起動します
cd /d "%~dp0"

REM node_modules が存在しない場合は npm install を実行
if not exist "node_modules" (
  echo Installing dependencies...
  npm install
)

REM 引数に "http" が指定された場合は従来のHTTPサーバーモード
if "%1"=="http" (
  echo Starting HTTP server mode on port 8313...
  python -m http.server 8313
) else (
  echo Starting Electron app...
  npx electron .
)
