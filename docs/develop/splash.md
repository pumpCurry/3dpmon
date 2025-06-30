# SplashScreen 実装メモ

`SplashScreen` は v2 ステップ⑦a で追加された起動画面です。ロゴとテンキー UI を表示し、Enter 押下でダッシュボードをロードします。

## 構造
- `SplashScreen.js`：ロゴ描画と `Keypad` 管理。`auth:ok` イベントを emit。
- `Keypad.js`：3×4 ボタンのテンキークラス。現フェーズでは数字と Clear が無効。
- `AuthGate.js`：`hasPassword()` と `validate()` をスタブ実装。

## 動作
1. `startup.js` から SplashScreen を mount。
2. Enter 押下または Enter キー入力で `auth:ok` を発火。
3. 既存 `App.js` を lazy-import し、TitleBar を含むダッシュボードが表示されます。

Vitest と Playwright で基本動作を検証するテストを追加しました。
