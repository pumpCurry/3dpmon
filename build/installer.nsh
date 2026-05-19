; 3dpmon NSIS インストーラ カスタムマクロ
; electron-builder の NSIS テンプレートから呼ばれる

; アンインストール時にユーザーデータの削除を確認するダイアログ
; （oneClick:false の assisted モードで有効）
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "ユーザーデータ（接続設定・印刷履歴・フィラメント情報など）も削除しますか？$\r$\n$\r$\n保存場所: $APPDATA\${PRODUCT_NAME}$\r$\n$\r$\n削除する場合は『はい』、データを保持する場合は『いいえ』を選択してください。$\r$\n（後で 3dpmon を再インストールする予定がある場合は『いいえ』を推奨）" \
      /SD IDNO IDNO skipDeleteData
    DetailPrint "ユーザーデータを削除中..."
    RMDir /r "$APPDATA\${PRODUCT_NAME}"
    DetailPrint "ユーザーデータを削除しました。"
    skipDeleteData:
  ${endIf}
!macroend

; インストール完了直前のカスタム処理（必要に応じて拡張）
!macro customInstall
  ; 現時点では追加処理なし。将来的にレジストリ書き込みなどが必要なら追加
!macroend
