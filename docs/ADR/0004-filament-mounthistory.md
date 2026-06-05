# ADR-0004 フィラメント残量の mountHistory 権威一本化

## ステータス
提案中 (Proposed) — v2.2.1012 で設計着手。実装は段階的（P0〜P4）。

## コンテキスト

フィラメント残量 `remainingLengthMm` が壊れる慢性問題（ADR外メモ「Filament data integrity crisis」）。
2026-06-04 に実機 IndexedDB エクスポート2本（devtoolsダンプ / exportAllData、2分差・完全一致）を解析し、**二重〜多重減算を実データで確定**した。

### 確定した実害
- `usedLengthLog` に同一 jobId が最大6回計上（例 job `1774657101`: log計 295,202mm vs プリンタ真値 144,447mm）。
- 破損スプール: `614bdd`(K1Max-4A1B) Σused=711,137 / 容量336,000 = **2.12倍**、`e15181`(K1Max-03FA) 1.88倍、`afb1bb` 1.22倍。**1機目・2機目の両方**で発生（共通関数の欠陥のため）。
- プリンタ報告値 `printStore.history[].materialUsedMm` は各ジョブ1件・正常 ＝ **信頼ソースは無傷**。

### 根本原因（現行コード）
1. **`remainingLengthMm` への writer が9箇所**（finalize / aggregatorライト / autoCorrect×2 / restore / import / applySpoolDefaults / restorePrintResume / UI付け替え）。互いに上書き・累積し合う。
2. **`finalizeFilamentUsage` の多重実行で二重減算**：初回で `currentJobStartLength=null`(spool.js:1072) → 2回目以降 `startLen = currentJobStartLength ?? remainingLengthMm`(同1044) が**減算済み残量**を基点に再減算。同一完了 jobId の再 finalize を弾くガードが無い（呼び出し元: aggregator.js:1133 / spool.js:529）。
3. **記録系が4つ重複**（usageHistory / usedLengthLog / printStore.history / printIdRanges）。権威が不明確で `usedLengthLog` は信頼できない。
4. **「現用スプールの usedLengthLog が空」の正体（C調査）**：`autoCorrectCurrentSpool` の fallback 経路が printCount を加算・残量補正する一方 `usedLengthLog.push` を行わない（spool.js:1305-1344）。加えて `importAllData`/`_restoreFromData` の `Object.assign(existing, sp)` は usedLengthLog を保護対象外（storage.js:159,989）で、古いバックアップの `[]` で上書きしうる。→ usedLengthLog は完全な記録ではない。

## 決定

**「装着履歴(mountHistory)」と「プリンタ報告の消費量(printStore.history.materialUsedMm)」の2つだけを権威とし、`remainingLengthMm` は両者から都度導出する（保存値はキャッシュ）。**

### 権威の分離
| 情報 | 唯一の権威 | 種別 |
|------|-----------|------|
| いつ・どのホストに・どのスプールを装着/取外したか | **`mountHistory`**（追記専用イベントログ） | 新設・権威 |
| 各ジョブが何mm消費したか | **`printStore.history[].materialUsedMm`**（+ `filamentInfo[]` で複数スプール対応） | 既存・権威（プリンタ報告） |
| スプール残量 `remainingLengthMm` | 上記2つから**導出**（`deriveSpoolRemaining`） | 導出・キャッシュ |
| `hostSpoolMap` / `isActive` / `printIdRanges` / `usedLengthLog` | mountHistory から**導出** | 導出（二重管理を廃止） |

### 核心原則：残量は「累積減算」ではなく「都度再計算」
`remaining -= x` を全廃する。残量は信頼ソースから**冪等に再計算**する。何回実行しても同じ値になるため、**二重減算が構造的に不可能**になる。これが本ADRの本質。

### データモデル：mountHistory
追記専用。usageHistory のスナップショット(4500件上限)とは**別ストア**に置き、安易にロールオーバーしない（古い装着記録の消失が補正不能の原因だったため）。

```js
// monitorData.mountHistory: MountEvent[]
{
  evId,            // 一意ID (epoch ms)
  ts,              // イベント時刻 ms
  type,            // "mount" | "unmount"
  host,            // ホスト名
  spoolId,
  // mount のみ:
  anchorRemainingMm, // 装着時点のそのスプールの導出残量（繰越基点）
  sinceJobId,        // 装着時点でそのホストの最後に完了した printId（区間の下限・排他）
  // unmount のみ:
  untilJobId         // 取外し時点の最後の完了 printId（区間の上限・包含）
}
```

各 mount は `anchorRemainingMm`（その瞬間の繰越残量）を持つため**区間が自己完結**する。現在残量は「最後の mount の anchorRemainingMm − その区間の消費」だけで決まり、過去区間は分析用。

### 導出アルゴリズム
```text
deriveSpoolRemaining(spoolId):
  ev = mountHistory で spoolId の最新 mount イベント
  if 無し: return spool.totalLengthMm（または初期残量）
  jobs = printStore.history[ev.host] のうち
           printId > ev.sinceJobId かつ (区間オープン または printId <= untilJobId)
           かつ 完了(materialUsedMm>0)
  used = Σ attributedUsed(job, spoolId)
           // filamentInfo に spoolId のエントリがあればその usedMm、
           // 単一スプールジョブなら job.materialUsedMm、該当なし 0
  remaining = ev.anchorRemainingMm − used
  if 現在この区間で印刷中（プリンタ未確定の進行ジョブあり）:
     remaining −= liveOverlay   // 進行中ジョブの暫定消費（揮発・非永続）
  return clamp(0, remaining, totalLengthMm)
```

### ライブ表示（進行中ジョブ）と K1 リセット
進行中ジョブはプリンタが `materialUsedMm` を確定するまで 0（`MERGE_IGNORE_ZERO_FIELDS` で保護）なので `used` に含まれない。表示用に **`_liveRemainingMm`（揮発フィールド）** へ「導出残量 − ライブ暫定消費(usedMaterialLength デルタ)」を入れる。完了時にプリンタ確定値が history に入り、次の導出で正規計上され、オーバーレイは消える。`usedMaterialLength` の印刷毎リセットは、ライブ暫定をジョブ単位の自前基点で計算するため自然に吸収。**ライブ値は権威 remaining へ一切書き戻さない**（二重計上の根を断つ）。

### オフライン・状態遷移の取りこぼしへの耐性（本設計の要）
**新設計の正しさは「3dpmon が印刷の開始/終了の瞬間を見届けたか」に依存しない。** 完了ジョブが（再接続時の `reqHistory` で）`printStore.history` に入りさえすれば、残量は冪等に再計算される。`printStore.history` は id union で**累積マージ**され（新フェッチに無い旧ジョブも保持。上限 `MAX_PRINT_HISTORY=1500`、printmanager.js:1096-1103）、プリンタの履歴ウィンドウ（数十件）を超えて 3dpmon 側に長期保持される。

#### 受信有無 × 状態遷移の全パターン
| 開始 | 終了 | 新設計の挙動 |
|---|---|---|
| 見た | 見た | 区間内ジョブとして history の materialUsedMm を計上。正常 |
| 見た | 見ず（途中で3dpmon終了/切断、完了はオフライン） | 再接続時に完了ジョブが history に入り計上。**未永続のライブ値は残らない**ので二重なし（旧設計が壊れた箇所） |
| 見ず（途中から接続） | 見た | 既存オープン区間(`sinceJobId < 当該printId`)に含まれ計上。オープン区間が無い初接続は「ブートストラップ装着」を生成 |
| 見ず | 見ず（全オフライン） | 再接続時 history に入れば、1件でも複数件でも Σ で一括計上。**件数非依存・冪等** |

#### 「最終既知printID以降」の扱い
再接続後、`printId > sinceJobId`（**厳密大なり**＝境界の二重計上防止）の完了ジョブを**合計するだけ**。ギャップが1件でも2件以上でも特別扱い不要（累積減算ではなく総和の再計算のため）。printId は開始タイムスタンプで単調増加を前提（同秒衝突は厳密 `>` と id 一意化で回避）。

#### 2つの derivation モードと被覆チェック
- **モードA（total から全再計算）**：`remaining = total − Σ(このスプール全区間の信頼消費)`。history がスプール全生涯を被覆していれば**これが地の真値**。1500件保持で多くのスプールが該当。
- **モードB（anchor 繰越）**：古いジョブが history から溢れた場合、`remaining = 最新mount.anchorRemainingMm − Σ(現区間ジョブ)`。anchor はオンライン装着時に確定した値を信頼。
- **被覆チェック**：自分の最終既知完了 `L`（= `printStore.history` の最大 printId）に対し、再接続時にプリンタが返す履歴の最古 printId `O` が `O > L` なら、L〜O 間に**取りこぼしたギャップ**の可能性を検出 → その区間は「未検証(estimated)」フラグを立て、勝手に過剰減算しない。

#### 構造的に自動解決できない2つの限界（ただし検出はする）
- **F1: オフライン中の無監視スプール交換**：プリンタは materialUsedMm を返すが「どの 3dpmon スプールか」は返さない。オフライン中に物理交換されると、ギャップジョブが誤って旧スプールに帰属。→ プリンタの `filamentInfo`（色/素材）と装着スプールの不一致を検出してユーザー確認を促す／手動で mountHistory を補正。外部情報が無いため完全自動解決は不可能。
- **F2: 被覆ギャップ**：オフラインが長く、ギャップジョブがプリンタ履歴からも溢れて再接続時に取得不能な場合、その消費は原理的に不明。→ 上記被覆チェックで「未検証」表示にし、残量を黙って盛らない。

#### ブートストラップ装着（初接続/装着記録欠落時）
オープン mount が無いホストに装着スプール＋進行中ジョブを初検出したら mount イベントを生成し、`anchorRemainingMm` と `sinceJobId` を**整合的に**設定する：保存残量が既に過去ジョブを反映済みなら `sinceJobId = 既知の最新完了printId`（再減算しない）、保存残量が満タン(total)なら `sinceJobId = 0`（全history減算）。不整合な二重/過小減算を防ぐ。

### 9 writer の置き換え
| 現 writer (file) | 置き換え |
|---|---|
| finalize 残量書込 (spool.js:1063) | **廃止**。完了処理はプリンタ確定値が history に入るのを保証するだけ。残量は導出が拾う |
| aggregator ライト (aggregator.js:1110) | `_liveRemainingMm`（表示用オーバーレイ）へのみ書込。権威には触れない |
| autoCorrect 通常/ fallback (spool.js:1419/1337) | **`deriveSpoolRemaining` に統合・廃止**（autoCorrect は「正しく実装した導出」そのもの） |
| restore / import / applySpoolDefaults (storage.js) | mountHistory と total を保存/マージ。残量は読込時に導出（競合ルール不要） |
| restorePrintResume (init.js:223) | 導出に置換 |
| UI スプール付け替え (printmanager.js:1420/1429) | mountHistory のジョブ帰属を編集 → 導出 |

→ `remainingLengthMm` を書くのは**導出 reducer の1箇所のみ**。他は全て読み取り。

### マルチホスト
mountHistory は (host, spoolId) 区間で管理。各ホストの `printStore.history` がそのホストのジョブを供給し、ホスト別に帰属。先頭ホスト偏重なし。`hostSpoolMap` は「各ホストの最新オープン mount」から導出するキャッシュに格下げ。`setCurrentSpoolId` は mountHistory にイベント追記するのが本体で、hostSpoolMap はその結果として更新。

### 移行・リペア（一回限り、要バックアップ）
1. 既存シグナル（usageHistory の装着記録 `startLength!=null` + `spool.printIdRanges` + `startedAt/startPrintID`）から mountHistory 区間を最善努力で再構成。
2. 各スプール `remaining = total − Σ(全区間の信頼ジョブ消費)` で再計算 → `614bdd`/`e15181` 等を救済。
3. `usedLengthLog` は権威から外す（分析用に history から再生成可）。
4. 再構成が曖昧（4500ロールオーバーで装着記録欠落 等）なら、推測せず保存値を「未検証」フラグ付きで温存。

## 段階実装（各段階で出荷・実機検証可能）
- **P0（挙動不変）**：mountHistory 追記（装着/取外し時、既存ロジックと並走）＋ `deriveSpoolRemaining()` 追加＋「導出 vs 保存」乖離の診断ログ。実機2台で観測。
- **P1**：表示を導出値（＋ライブオーバーレイ）に切替。aggregator は `_liveRemainingMm` のみ書込。旧 writer は残すが表示には使わない。
- **P2**：finalize/autoCorrect/aggregator の権威 remaining 書込を撤去。remaining は導出 reducer のみが書くキャッシュに。autoCorrectCurrentSpool 廃止。
- **P3**：移行・リペアユーティリティ（ユーザー起動・バックアップ付き）。
- **P4**：hostSpoolMap/isActive/printIdRanges を mountHistory から導出。二重管理撤廃。usedLengthLog は分析専用へ降格。

## テスト計画
- **単体**：導出の冪等性（N回呼んで同値）、複数区間の繰越、複数スプールジョブの帰属、進行中オーバーレイ、K1リセット、A→B→A 再装着、ロールオーバーで装着記録欠落時のフォールバック。
- **スモーク(2台)**：同時印刷、印刷中スプール交換、印刷中再接続、オフライン完了ジョブ、旧バックアップのインポート（破壊しないこと）。
- **回帰データ**：本件エクスポート（614bdd/e15181）を投入 → リペア → `remaining = total − Σ信頼消費`（誤差≤0.1mm）を assert。

## 結果（期待）
- 二重減算が構造的に不能（冪等再計算）。
- 残量 writer が9→1（導出 reducer）。
- マルチホスト対称（先頭ホスト偏重の排除）。
- プリンタ報告という外部の真値に常に収束。破損データも信頼ソースから復旧可能。

## リスクと対策
- **mountHistory のロールオーバー**で装着記録が消えると区間特定不能 → スナップショットとは別ストアにし上限を設けない/十分大きく、装着イベントは保護。
- **K1 が返す履歴が数十件**で古いジョブが history に無い → 古い区間は `anchorRemainingMm`（繰越）で吸収し、現区間のジョブのみ history に必要。
- **複数スプール/ジョブの帰属**は `filamentInfo` の正確性に依存 → filamentInfo 欠落時は単一スプール帰属にフォールバック。

## 変更履歴
| 日付 | 内容 |
|------|------|
| 2026-06-04 | 初版（提案）: 実データで多重 finalize 二重減算を確定し、mountHistory 権威一本化＋残量導出方式を設計 |
| 2026-06-04 | 追補: 状態遷移取りこぼし（開始/終了の未受信・オフラインギャップ）への耐性をレビューし、受信有無非依存・被覆チェック・2モード導出・ブートストラップ装着・限界F1/F2 を明記 |
