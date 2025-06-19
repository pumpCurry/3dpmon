# フィラメント管理機能ガイド

本書では、3dpmon に搭載予定の「フィラメント使用記録簿」「在庫管理」「プリセット管理」の3機能について説明します。印刷時のスプール交換や在庫把握に役立つダッシュボード機能です。

## 1. 機能概要
- **使用記録簿**: いつどのプリントでどのスプールを使ったかを履歴に残します。
- **在庫管理**: フィラメント種別ごとに未使用スプール数を記録し、交換時に自動で残数を更新します。
- **プリセット管理**: よく使うフィラメントをプリセットとして登録し、交換操作や在庫管理に活用します。

## 2. データ構造
各機能は以下のようなデータにまとめて保存されます。
```javascript
monitorData = {
  filamentSpools: [ /* スプール単位の使用状況 */ ],
  usageHistory: [ /* 印刷ごとの使用履歴 */ ],
  filamentPresets: [ /* プリセット定義 */ ],
  filamentInventory: [ /* 未使用在庫数 */ ]
};
```
- **filamentSpools**: スプールID、色、材質、残量などを保持し、現在使っているスプールかどうかを示します。
- **usageHistory**: ジョブ単位の使用長さや開始終了時刻を記録します。
- **filamentPresets**: メーカー名や材料名、色などのテンプレート情報を保存します。
- **filamentInventory**: プリセットIDごとの在庫本数を管理し、交換時に1本減算します。

## 3. フィラメント管理ダイアログ
「フィラメント管理」モーダルでは以下の4つのタブを切り替えて操作します。

| タブ名 | 内容 |
| --- | --- |
| **📋 使用記録簿** | 日付順の使用履歴と消費量を表示します |
| **🧵 現在のスプール** | 交換操作と残量確認を行います |
| **📦 在庫** | プリセット別の在庫数を確認し入出庫を記録します |
| **⭐ プリセット** | プリセットの登録・編集・削除を行います |

### 交換操作の流れ
1. 交換ボタンを押すとフィラメント選択画面が表示されます。
2. お気に入りや最近使ったフィラメントから選択するか、ドロップダウンで絞り込みます。
3. 決定すると在庫数が1減り、使用中スプールとして登録されます。

### 登録済みフィラメントタブ

登録済みフィラメントタブでは、過去に登録したスプールを一覧で確認し編集できます。

```
[新規登録]

┏検索: ━━━━━━━━━━━━━━━━━━┓
┃[ブランド▼][材質▼][色名▼][名称][🔍検索]┃
┗━━━━━━━━━━━━━━━━━━━━━┛
┌───┐　一覧：(nnn件中/nnn件)
│ﾌﾟﾚﾋﾞｭｰ│　|ブランド|材質|色|名称|サブ名称|使用数|最終利用日時|コマンド|
│　　　│　|........|....|...|...|...|...|...|...|
│　　　│　|........|....|...|...|...|...|...|...|
└───┘　|........|....|...|...|...|...|...|...|
```

 - **新規登録ボタン** からスプールを追加できます。
 - ボタンの下には **お気に入り** と **よく使うフィラメント** のカルーセルが表示されます。
- **検索欄** ではブランド、材質、名前、色、名称を指定して絞り込めます。
  - ブランド: `manufacturerName`
  - 材質: `materialName`
  - 名前: `reelName/reelSubName`
  - 色: `{■}{filamentColor}{materialColorName}` (`■` は `filamentColor` で着色)
  - 名称は部分一致で検索します。
- **検索ボタン** を押すと一覧が更新されます。
- 一覧の先頭には 3D プレビューが表示されます。
- 一覧はヘッダークリックでソートできます。
  - **ID**: フィラメントID (エポック)
  - **ブランド**: `manufacturerName`
  - **材質**: `materialName`
  - **色名**: `{■}{filamentColor}{materialColorName}`
  - **名称**: `reelName`
  - **サブ名称**: `reelSubName`
  - **使用数**: そのフィラメントIDを使用した回数 (履歴から集計)
  - **最終利用日時**: 最後に使用した日時 (YYYY-MM-DD HH:mm:ss)
  - **コマンド**: 編集ボタンから登録画面と同様に内容を変更できます。

以下はフィラメント登録時のデフォルト設定例です。
```javascript
const defaultFilamentOptions = {
  filamentDiameter: 1.75,
  filamentTotalLength: 336000,
  filamentCurrentLength: 336000,
  reelOuterDiameter: 195,
  reelThickness: 58,
  reelWindingInnerDiameter: 68,
  reelCenterHoleDiameter: 54,
  reelBodyColor: '#91919A',
  reelFlangeTransparency: 0.4,
  reelWindingForegroundColor: '#71717A',
  reelCenterHoleForegroundColor: '#F4F4F5',
  showInfoLength: true,
  showInfoPercent: true,
  showInfoLayers: true,
  showResetButton: false,
  showProfileViewButton: true,
  showSideViewButton: true,
  showFrontViewButton: true,
  showAutoRotateButton: true,
  enableDrag: true,
  enableClick: false,
  onClick: null,
  disableInteraction: false,
  showOverlayLength: true,
  showOverlayPercent: true,
  showLengthKg: true,
  showSlider: false,
  filamentWeightKg: 1.0,
  showReelName: true,
  showReelSubName: true,
  showMaterialName: true,
  showMaterialColorName: true,
  showMaterialColorCode: true,
  showManufacturerName: true,
  showOverlayBar: true,
  showPurchaseButton: true,
  currencySymbol: '¥',
};

const sampleRegistration = {
  manufacturerName: 'CC3D',
  reelName: 'PLA MAXフィラメント',
  reelSubName: 'つやなしマット',
  filamentColor: '#FCC4B6',
  materialName: 'PLA＋',
  materialColorName: 'サンドカラー',
  materialColorCode: '#ED1C78',
  purchaseLink: 'https://www.amazon.co.jp/dp/B09B4WWM6C',
  price: 1699,
};
```

## 4. 集計レポート
使用履歴から日・週・月ごとのスプール消費量を集計し、棒グラフや円グラフで確認できます。

## 5. プリセット登録と使用フロー
1. **プリセットタブ**で新規登録します。名前・色・材質などを入力します。
2. 在庫数を追加すると、交換時にそのプリセットを選択できます。
3. スプール交換時には在庫から選択し、残数が自動で更新されます。
4. 在庫が不足すると警告が表示されます。

## 6. その他の便利機能
- 在庫ゼロ時のアラート表示
- 残量から印刷可能時間を推定
- 廃棄記録やサムネイル画像の登録

## 7. 今後の拡張予定
- 印刷ファイル単位での正確なフィラメント消費量取得
- バーコード読み取りによるプリセット選択
- CSV 出力やクラウド同期

このドキュメントは機能追加時の参考として、README から参照できるマニュアルとして利用してください。
