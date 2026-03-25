# 3DPMON UI/UX 品質レビュー & 統合管理スイート評価
> **レビュー日**: 2026-03-23
> **対象バージョン**: 2.1.005
> **レビュー手法**: ペルソナベース機能分析 + コード品質メトリクス + 競合比較
> **対象モジュール**: dashboard_*.js 35ファイル (24,386 LOC) + CSS 2ファイル (2,836 LOC)

---

## 目次
1. [エグゼクティブサマリー](#1-executive-summary)
2. [ペルソナ定義と要件](#2-persona)
3. [コードベース品質メトリクス](#3-code-metrics)
4. [フィラメント管理システム詳細分析](#4-filament-system)
5. [UI一貫性の徹底度チェック](#5-ui-consistency)
6. [多角的目的への対応度評価](#6-multi-purpose)
7. [競合比較](#7-competitor-comparison)
8. [CI/CD現状と課題](#8-cicd)
9. [改善ロードマップ](#9-roadmap)

---

## 1. エグゼクティブサマリー {#1-executive-summary}

### 総合評価

| 側面 | レビュー時 | 改善後 | 判定 |
|------|-----------|--------|------|
| リアルタイム監視 | **A** | **A** | 業界トップクラス（変更なし） |
| フィラメントライフサイクル | **B+** | **A-** | 印刷前チェックゲート追加（素材不一致/残量不足/未装着警告） |
| 在庫管理 | **D+** | **B** | カスタムプリセット+在庫アラート+インポート/エクスポート |
| 費用管理 | **C** | **B-** | 廃棄ロス可視化（金額/素材別/直近リスト） |
| 製造時間管理 | **F** | **B-** | 生産管理パネル新設（稼働率/日次レポート/予定vs実績） |
| UI一貫性 | **D** | **B** | デザイントークン50+変数、インラインスタイル100%解消、ダークモード対応 |
| 情報設計 | **C+** | **B+** | 印刷前の残量バー、在庫警告バッジ、稼働率バーで視覚的出し分け |
| 拡張性 | **D** | **B+** | カスタムプリセットが一級市民、素材密度13種、JSON import/export |
| CI/CD | **F** | **A-** | vitest 137テスト、ESLint+Prettier+Stylelint、GitHub Actions CI |

**結論: 監視ツールA級 + 統合管理スイートとしてB+級**
> Phase 0-4 の実装により、レビュー時のC級評価からB+級に改善。
> Phase 4 完了: 空状態統一コンポーネント、ARIA+kbd+フォーカストラップ、レスポンシブ、色弱対応

---

## 2. ペルソナ定義と要件 {#2-persona}

### ペルソナ: αさん（量産3Dプリントユーザー）

| 属性 | 詳細 |
|------|------|
| 機器構成 | K1 Max ×3台 + K1C ×3台（計6台） |
| 運用パターン | 毎日大量に量産、複数機同時印刷 |
| フィラメント管理 | メモ帳+付箋+Excelで管理中（苦痛） |
| 最大の課題 | 色違い誤印刷、残量不足による印刷失敗 |
| 品質要件 | リジューム作品は検品ではじかれる＝実質失敗 |
| データ要望 | 印刷データごとの色・個数・消費量の記録 |
| 経済性 | 残フィラメント廃棄が多く、もったいない |
| 交換記録 | 開封/使い切り履歴を手動管理、忘れがち |

### αさんの業務フローと3DPMONの対応状況

| フロー段階 | αさんの要求 | 3DPMONの対応 | 評価 |
|-----------|-----------|-------------|------|
| **印刷計画** | どのフィラメントで何個刷るか | なし | :x: |
| **印刷前確認** | 色・素材が合っているか、残量足りるか | なし（事後通知のみ） | :x: |
| **印刷中監視** | 6台のカメラ同時視聴 | カメラパネル×N | :white_check_mark: |
| **完了検知** | 印刷終了の即時通知 | TTS + ブラウザ通知 | :white_check_mark: |
| **収穫・再セット** | 予定vs実績の差異確認 | データはあるがビューなし | :warning: |
| **フィラメント交換** | パッと記録、開封日・使い切り日 | 交換ダイアログで記録 | :white_check_mark: |
| **在庫管理** | 残数確認、発注判断 | プリセット品のみ | :warning: |
| **残フィラメント活用** | 少量残りを小ジョブに割当 | なし | :x: |
| **コスト集計** | 印刷あたり原価、月次支出 | 基本集計あり | :warning: |
| **生産記録** | 何色で何個、消費量データ | 履歴あるがエクスポートなし | :warning: |

---

## 3. コードベース品質メトリクス {#3-code-metrics}

### 3.1 規模

| 指標 | 値 |
|------|------|
| JSモジュール数 | 35ファイル |
| JS総行数 | 24,386 LOC |
| CSS総行数 | 2,836 LOC (2ファイル) |
| 最大モジュール | `dashboard_filament_manager.js` 2,425 LOC |
| Export文 | 213 |
| Import文 | 134 |

### 3.2 スタイル管理

| 指標 | 値 | 評価 |
|------|------|------|
| インラインスタイル (`style.` 参照) | **288箇所** | :x: 重大 |
| CSS Custom Properties (変数) | **5個** | :x: 不足 |
| ハードコード色値 | **129種** | :x: パレット不在 |
| フォントサイズ種 | 10px/11px/12px/13px/14px/1.2em 等 **6段階以上** | :x: スケール不在 |
| z-index値 | **21種** (-1 ~ 9000) | :warning: スタック管理なし |
| ボーダー色 | `#ccc`/`#ddd`/`#eee`/`#e2e8f0` **4種混在** | :x: |

### 3.3 DOM操作

| 指標 | 値 |
|------|------|
| querySelector/getElementById | 306箇所 |
| createElement/appendChild/innerHTML | 867箇所 |
| addEventListener | 229箇所 |
| Map/Set コレクション | 79インスタンス |

### 3.4 アクセシビリティ

| 指標 | 値 | 評価 |
|------|------|------|
| ARIA属性 | 17箇所（大半が `data-role`） | :x: |
| キーボードナビゲーション | 4箇所 | :x: |
| tabindex設定 | ほぼなし | :x: |
| :focus-visible定義 | なし | :x: |

### 3.5 コード品質インフラ

| 項目 | 状態 |
|------|------|
| ESLint | :x: 未設定 |
| Prettier | :x: 未設定 |
| EditorConfig | :white_check_mark: あり |
| JSDoc | :white_check_mark: 620ブロック |
| テストファイル | :x: 0ファイル |
| vitest (依存関係) | :x: package.jsonに未定義 |
| CI テストジョブ | :x: 参照先ファイル不在 (tests/*.test.js) |
| TODO/FIXME | 0件 |

---

## 4. フィラメント管理システム詳細分析 {#4-filament-system}

### 4.1 スプール状態モデル（5状態）

```
INVENTORY ──装着──→ MOUNTED ──取外──→ STORED ──装着──→ MOUNTED
    │                   │                │
    │               (使い切り)         (廃棄)
    │                   │                │
    └───────────────→ EXHAUSTED    DISCARDED
                   (残量≤100mm)   (ソフトデリート)
```

**評価:** 状態モデル自体は優秀。5状態の遷移が明確で、getSpoolState()による自動判定も適切。ただし、**状態遷移のトリガーが全て手動**であり、「フィラメント切れ検知→自動EXHAUSTED遷移→交換促進」のような自動化が不足。

### 4.2 スプールデータスキーマ（50+フィールド）

**コアID**: id, serialNo (#NNN), presetId
**素材**: material, materialName, density, color, colorName
**寸法**: filamentDiameter, reelOuterDiameter, reelThickness 等 6フィールド
**リール外観**: reelBodyColor, reelFlangeTransparency 等 4フィールド
**フィラメント量**: totalLengthMm, remainingLengthMm, weightGram
**使用追跡**: printCount, usedLengthLog, startDate, removedAt, printIdRanges
**価格**: purchasePrice, currencySymbol, purchaseLink, priceCheckDate
**状態**: isActive, isInUse, isPending, isFavorite, deleted, hostname
**メモ**: note

**評価:** データモデルは非常に充実。しかし以下が欠如:
- `lotNumber` (ロット管理)
- `openedAt` (開封日の明示的記録)
- `purchasedAt` (購入日)
- `supplier` (購入元)
- `moistureStatus` (吸湿状態)
- `shelfLocation` (保管場所)
- `expirationDate` (使用期限)

### 4.3 プリセットシステムの閉鎖性

| 項目 | 値 |
|------|------|
| プリセット数 | **34種** |
| ブランド数 | **2ブランド** (CC3D, PRINSFIL) |
| 素材種 | PLA+, PETG, PETG-GF, PETG-CF, PLA SILK, ABS+, TPU, ASA |
| カスタムプリセット追加 | **不可**（ハードコード） |
| プリセット非表示/アーカイブ | **不可** |
| お気に入りプリセット | **なし**（スプールにはある） |
| 密度テーブル | 4種のみ（PLA/PETG/ABS/TPU） |

**致命的問題:**
1. ユーザーがeSUN、Polymaker、SUNLU等の自分のフィラメントをプリセット化できない
2. カスタム登録スプールは在庫管理の ±ボタンが機能しない → 「二級市民」扱い
3. PA(ナイロン)、PC、PVA、PETG-GF/CF等の密度がハードコードにない → 重量計算が不正確
4. 使わないプリセット34種が常に表示される → ノイズ

### 4.4 フィラメント交換ダイアログUX

**構造:** 3タブ（保管中/新品/お気に入り）+ 検索フィルタ + 3Dプレビュー

**良い点:**
- 他ホスト装着中スプールのグレーアウト + 操作ブロック
- タブ間の選択記憶
- 3Dリールプレビューの即時更新
- 二重装着防止（setCurrentSpoolId の排他制御）
- ソート可能なテーブルヘッダ

**問題点:**
- 検索がリアルタイムでなくボタンクリック必須
- テーブルに残量バーがない（%数値のみ）
- 「この印刷に足りるか」の推定消費量との比較がない
- 空テーブル時のEmpty State UIがない（ヘッダだけ表示）
- モーダル on モーダル（フィラメント管理→交換ダイアログ→確認ダイアログ）

### 4.5 印刷ジョブとスプールの紐付け

**実装済み:**
- 印刷開始時: 装着中スプールIDをジョブに記録 (`filamentId`)
- 印刷終了時: 消費量をスプールの `usedLengthLog` に記録
- 途中交換時: `finalizeFilamentUsage()` + `reserveFilament()` で両方のスプールに記録
- `filamentInfo` 配列にスプールスナップショットを保存（色・素材・名前等）

**欠如:**
- **事前チェック:** 推定消費量 vs 残量の比較が印刷開始前に行われない
- **色/素材チェック:** gcodeメタデータとの照合がない
- **逆引き:** 「このスプールで何を印刷したか」のビューがない
- **バッチ管理:** 「同じモデルをN個」のグルーピングがない

### 4.6 コスト計算

**実装済みの計算:**
```
costPerMm     = purchasePrice / totalLengthMm
remainingCost = purchasePrice × (remainMm / totalMm)
costPerPrint  = purchasePrice / printCount
```

**表示フォーマット:** `"2.5m (7g, ¥342)"`

**欠如:**
- 廃棄ロスの累計金額
- モデル別原価（1作品あたりのフィラメント原価）
- 電力コストの加味
- 失敗印刷によるロスコスト
- 月次/週次のコストトレンドグラフ

---

## 5. UI一貫性の徹底度チェック {#5-ui-consistency}

### 27項目チェックリスト

| # | チェック項目 | 評価 | 根拠 |
|---|-------------|------|------|
| 1 | 全画面で同じボタンスタイル | :x: | fontSize 10/11/12/13px混在、padding不統一 |
| 2 | 全テーブルで同じヘッダスタイル | :x: | 11px/#f0f0f0 と 13px/#e8f0f8 の2系統 |
| 3 | 全モーダルで同じヘッダ色 | :x: | #444, #3070a0, #3080c0 の3種 |
| 4 | 数値フォーマットの統一 | :warning: | 温度小数2桁、残量統一済み、時間formatDuration |
| 5 | 空状態(Empty State)の統一 | :x: | テーブル空/カルーセル「なし」/パターン不在 |
| 6 | ローディング状態 | :x: | スピナー/スケルトンなし |
| 7 | エラー状態 | :x: | console.warnのみ、体系的UI無し |
| 8 | トースト/通知の統一 | :warning: | showAlert 4レベル、位置・アニメーション文脈依存 |
| 9 | アイコン体系 | :x: | 絵文字+テキスト混在、アイコンライブラリなし |
| 10 | 色の意味の一貫性 | :warning: | 緑=成功統一、青がプライマリ/情報で混用 |
| 11 | フォーカスリング | :x: | :focus-visible 未定義 |
| 12 | ホバーフィードバック | :warning: | テーブル行あり、ボタンに無い箇所多数 |
| 13 | 無効状態(disabled) | :warning: | OKボタン制御済み、グレーアウトはCSS依存 |
| 14 | 区切り線/セパレータ | :x: | #ccc/#ddd/#eee/#e2e8f0 の4種混在 |
| 15 | スペーシングスケール | :x: | 4px/6px/8px/10px/12px/16px 不規則 |
| 16 | ゼブラストライプ（テーブル） | :x: | なし |
| 17 | テキスト切り詰め | :x: | text-overflow: ellipsis の体系的適用なし |
| 18 | レスポンシブ対応 | :x: | 固定px値、@media queryなし |
| 19 | ダークモード | :x: | CSS変数なし、インラインスタイルで不可能 |
| 20 | カラーコントラスト比 | :x: | 11pxグレー文字(#64748b)は4.5:1未満の可能性 |
| 21 | フォントファミリー統一 | :warning: | CSS定義あるがインラインで上書き箇所あり |
| 22 | ボタンサイズ (タッチターゲット) | :x: | 多くのボタンが44×44px未満 |
| 23 | モーダル閉じ操作統一 | :warning: | ESC/×ボタンあるが挙動バラバラ |
| 24 | 確認ダイアログのパターン | :warning: | showConfirmDialog統一だが文言/ボタン不統一 |
| 25 | 通知バナー表示位置 | :warning: | z-index:9000だが表示タイミング不統一 |
| 26 | テーブル行選択スタイル | :warning: | #e0f2fe統一だがカーソル変更がない箇所あり |
| 27 | スクロールバースタイル | :x: | カスタムスクロールバーなし |

**合格: 0 / 部分合格: 11 / 不合格: 16**

---

## 6. 多角的目的への対応度評価 {#6-multi-purpose}

### 6.1 在庫管理

| 機能 | 実装 | 評価 |
|------|------|------|
| 在庫数の増減 | プリセット品のみ±ボタン | :warning: カスタム品対象外 |
| 在庫アラート（閾値割れ） | なし | :x: |
| 発注リスト自動生成 | なし | :x: |
| 購入リンク | プリセットにAmazon URL | :white_check_mark: |
| 入荷記録 | 在庫+1のみ（日付/ロット/購入元なし） | :warning: |
| 在庫切れ予測 | なし | :x: |

### 6.2 利用管理

| 機能 | 実装 | 評価 |
|------|------|------|
| スプールライフサイクル | 5状態管理 | :white_check_mark: |
| 使用履歴 | Tab3タイムスタンプ+量 | :white_check_mark: |
| ジョブ紐付け | filamentId + filamentInfo | :white_check_mark: |
| 残量追跡 | mm/m/g/%/コストの5形式 | :white_check_mark: |
| 消費予測 | buildSpoolAnalytics | :white_check_mark: |
| 劣化管理（吸湿、保管期間） | なし | :x: |
| バッチ/ロット管理 | なし | :x: |

### 6.3 費用管理

| 機能 | 実装 | 評価 |
|------|------|------|
| スプール単価 | purchasePrice | :white_check_mark: |
| 印刷あたりコスト | costPerPrint | :white_check_mark: |
| 残コスト | remainingCost | :white_check_mark: |
| 廃棄ロス計算 | なし | :x: |
| モデル別原価計算 | なし | :x: |
| 月次コストトレンド | なし | :x: |

### 6.4 製造時間管理

| 機能 | 実装 | 評価 |
|------|------|------|
| 印刷時間記録 | 履歴にduration | :white_check_mark: |
| 予定vs実績比較 | データあり、ビューなし | :warning: |
| 6台の稼働率 | なし | :x: |
| 1日の生産個数 | なし | :x: |
| ダウンタイム分析 | なし | :x: |
| 段取り時間 | なし | :x: |
| 生産計画ビュー | なし | :x: |

---

## 7. 競合比較 {#7-competitor-comparison}

### vs Spoolman (OSS)

| 機能 | 3DPMON | Spoolman |
|------|--------|----------|
| カスタムベンダー追加 | :x: | :white_check_mark: |
| カスタム素材追加 | :x: (4種のみ) | :white_check_mark: |
| QRコード/バーコード | :x: | :white_check_mark: |
| REST API | :x: | :white_check_mark: |
| ロット管理 | :x: | :white_check_mark: |
| 残量自動追跡 | :white_check_mark: (WebSocket) | :warning: (API) |
| 3Dプレビュー | :white_check_mark: | :x: |
| リアルタイム監視 | :white_check_mark: | :x: |

### vs OctoPrint + Plugins

| 機能 | 3DPMON | OctoPrint |
|------|--------|-----------|
| マルチプリンタ | :white_check_mark: ネイティブ | :warning: インスタンス複数 |
| 印刷前チェック | :x: | :white_check_mark: |
| gcode解析 | :x: | :white_check_mark: |
| プラグインエコシステム | :x: | :white_check_mark: 400+ |

---

## 8. CI/CD現状と課題 {#8-cicd}

### 現在の構成

```yaml
# .github/workflows/ci.yml
Jobs:
  test:          npm test          → npm scripts に "test" 未定義
  test-temp:     vitest run ...    → tests/tempbuffer.test.js 不在
  test-sidemenu: vitest run ...    → tests/sidemenu.test.js 不在
```

**致命的:** CIの3ジョブ全てが参照先不在で実質的に機能していない。vitest自体がpackage.jsonの依存関係にない。

### 必要なCI/CDパイプライン

```
PR作成
  ├─ Lint (ESLint + JSDoc検証)
  ├─ Format Check (Prettier --check)
  ├─ Unit Tests (Vitest)
  ├─ CSS Audit (stylelint)
  ├─ Accessibility Audit (axe-core)
  ├─ Bundle Size Check
  └─ Visual Regression (optional)
Main Merge
  ├─ All PR checks
  ├─ Integration Tests
  └─ Electron Build
Release
  ├─ All Main checks
  ├─ Electron Build + Packaging
  └─ Changelog Generation
```

---

## 9. 改善ロードマップ {#9-roadmap}

### Phase 0: 基盤整備（CI/CD + デザイントークン）
- ESLint + Prettier 導入
- Vitest + テストインフラ構築
- CSS Custom Properties によるデザイントークン定義
- インラインスタイルの段階的CSSクラス化

### Phase 1: カスタムプリセット開放
- ユーザー定義プリセット作成UI
- プリセット非表示/アーカイブ機能
- 素材種の自由追加（密度テーブル拡張）

### Phase 2: 予防的UI
- 印刷前残量チェックゲート
- 推定消費量 vs 残量の視覚表示
- 低在庫アラート + 発注提案

### Phase 3: 製造時間管理
- 稼働率ダッシュボード
- 予定vs実績の比較ビュー
- 日次生産レポート

### Phase 4: UI一貫性の徹底
- コンポーネント化（テーブル、モーダル、ボタン）
- 空状態/ローディング/エラー状態の統一パターン
- アクセシビリティ改善（ARIA、キーボードナビ）

---

## 付録: 主要ファイルパス

| モジュール | パス | LOC |
|-----------|------|-----|
| フィラメント管理UI | `3dp_lib/dashboard_filament_manager.js` | 2,425 |
| 印刷マネージャ | `3dp_lib/dashboard_printmanager.js` | 2,144 |
| 接続管理 | `3dp_lib/dashboard_connection.js` | 1,719 |
| アグリゲータ | `3dp_lib/dashboard_aggregator.js` | 1,639 |
| フィラメント3Dビュー | `3dp_lib/dashboard_filament_view.js` | 1,297 |
| スプールデータモデル | `3dp_lib/dashboard_spool.js` | ~600 |
| 交換ダイアログ | `3dp_lib/dashboard_filament_change.js` | ~900 |
| プリセットデータ | `3dp_lib/dashboard_filament_presets.js` | ~500 |
| 在庫管理 | `3dp_lib/dashboard_filament_inventory.js` | ~200 |
| パネルCSS | `3dp_panel.css` | 1,493 |
| 監視CSS | `3dp_monitor.css` | 1,343 |
| CI設定 | `.github/workflows/ci.yml` | 52 |
