# Printer Core v3 Gate 18.9H SpoolMount Authority

Last updated: 2026-09-02

この文書は、K2/CFS と将来の K1C+CFS-C を含む multi-source printer で、
3DPmon 管理スプールを MaterialSource 単位へ割り当てるための
Gate 18.9H 実装仕様を固定する。

## Goal

Gate 18.9H の目的は、CFS / CFS-C / external spool / direct feed を問わず、
operator が 3DPmon 管理スプールを各 MaterialSource へ明示的に mount できる
production authority を作ることである。

この Gate では、次のことは行わない。

- CFS physical command の production enable。
- filament remaining の debit。
- legacy `usageHistory` への書き込み。
- `hostSpoolMap` の自動書き換え。
- device observation / RFID / selected / empty / stale による自動 mount 更新。
- ItemKeeper payload への source-aware projection 本番接続。

## Gate Split

### Gate 18.9H-1a: Pure Store And Service Contract

H-1a では production storage へ接続せず、pure store / service contract と
unit test だけを追加する。

Status: implemented and tested in `719c69e` + `90ad774`, then hardened in PR #440
after `b178ce8`.

対象:

- `3dp_lib/printer_core/dashboard_material_accounting_mount_store.js`
- `3dp_lib/printer_core/dashboard_material_accounting_mount_service.js`
- 必要な場合のみ `dashboard_material_accounting_contract.js`
- 原則として `dashboard_spool_mount_repository.js` は既存 API を使い、変更を避ける

完了条件:

- 1つの MaterialSource に open mount は最大1件。
- 1つの managed spool は全 device/source 横断で open mount 最大1件。
- `operatorActionId` の同一 payload 再送は idempotent。
- `operatorActionId` の異なる payload 再送は conflict。
- `operatorReplaceSourceMount()` は close old + open new を1つの staged transaction
  として扱い、new mount が失敗した場合 old mount は open のまま残る。
- durable writer callback は `casApplied:true` を返さない限り成功扱いにしない。
- service は `hostSpoolMap` を read-only occupancy として参照し、
  同じ spool が legacy 側で装着中の場合は Universal mount を拒否する。
- service は caller supplied `materialSource` object をtrusted authorityとして扱わず、
  `materialSourceId` から送信時のtrusted resolverで現在観測sourceを解決する。
- managed spool と legacy occupancy も送信時resolverで再解決し、service生成時snapshotへ閉じ込めない。
- `sourceIdentityDigest` は `MaterialSource.identity` とlocatorの両方にbindする。
- operation event は外側eventとpayload内の `kind` / `operatorActionId` / `operationId`
  が一致し、operator eventでは空でない `recordRefs` を持つ場合だけactive authorityへ戻す。
- mount/event conflict はfirst-winせず、関連するauthority ambiguity setをquarantineする。

### Gate 18.9H-1b: Durable Production Persistence

H-1b では H-1a の contract を `monitorData` / shared storage / IndexedDB へ接続する。

Status: implemented and tested in PR #440 after `335d287`, then hardened for
cross-backend assignment and final-current import/restore reconciliation after
`afc3d37`.

対象:

- `3dp_lib/dashboard_data.js`
- `3dp_lib/dashboard_storage.js`
- `3dp_lib/dashboard_storage_idb.js`
- storage migration / import / export tests

完了条件:

- `monitorData.materialAccountingSpoolMountStore` を追加する。
- store は shared durable storage として保存、復元、export、import できる。
- IndexedDB backend では read current -> verify revision/digest -> put next を
  同一 readwrite transaction 内で行う。
- CAS を証明できない backend では production mount write を成功扱いにしない。
- import 時に `hostSpoolMap`、`usageHistory`、`filamentSpools.remainingLengthMm`、
  `materialAccountingPrintBindingStore` へ投影しない。
- conflicting open mount は first-win で片方を採用せず、active authority から
  conflict set 全体を外して quarantine する。
- production CAS writer は service が渡した managed spool / legacy occupancy precondition を
  `monitorData` の現在値から再計算し、不一致ならIndexedDB CAS前に拒否する。
- legacy `setCurrentSpoolId()` は Universal `OPEN` mount と process-local
  in-flight reservation を read-only occupancy として検査し、同じ managed spool を
  legacy `hostSpoolMap` へ二重装着しない。
- Universal mount / replace runtime は durable CAS 完了まで対象spoolを予約し、
  同時操作中にlegacy側が同じspoolを取得するraceを遮断する。
- restore / import 後のbackend再照合は、final current stateに対して常に実行し、
  `OPEN` mountだけを隔離対象にする。`CLOSED` mount履歴はlegacy現在装着と衝突扱いせず、
  importが `hostSpoolMap` だけを追加する場合でも既存current Universal `OPEN` mountを
  再照合する。

実装境界:

- `monitorData.materialAccountingSpoolMountStore` は production mount store の runtime copy
  として追加済み。
- 通常の throttled storage flush は `materialAccountingSpoolMountStore` を通常queueから除外する。
  backup / export 可視性は専用store snapshotとimport/restore経路で扱い、
  operator mount / unmount / replace のproduction成功判定には必ず専用CAS writerだけを使う。
- production write は `commitMaterialAccountingSpoolMountStoreDurably()` だけを通り、
  IndexedDB の `compareAndSwapSharedValue()` が `casApplied:true` を返した場合のみ
  runtime store を更新する。
- localStorage fallback は restore/export 用に正規化済みstoreを保持できるが、
  production write では `production-cas-unavailable` として失敗させる。
- import時も、IndexedDBが有効な実運用経路では現在storeをbaseにincomingとのmerge候補を作り、
  CAS成功後だけruntime storeへ反映する。localStorage-only環境では互換importとして復元するが、
  operator production writeの成功境界には使わない。
- incoming Universal `OPEN` mountだけでlegacy `hostSpoolMap` importを黙って破棄しない。
  legacy割当は既に確定しているcurrent Universal `OPEN` mount / in-flight reservationだけを見て判定し、
  incoming側の衝突はUniversal storeのreconcile conflictとして隔離する。
- import時に既存storeと異なる非空storeが来た場合は、自動mergeやfirst-winを行わず、
  conflict evidence として `retainedUnsupportedEntries` へ隔離する。

### Gate 18.9H-2: Operator Mount UI

H-2 では、H-1b で永続化された `SpoolMount` をフィラメント管理UIへ接続する。

Status: implemented and tested in PR #440 after `afc3d37`, then hardened after
review to reject unconfirmed managed spools and guard all destructive spool
lifecycle mutations against Universal `OPEN` mount / reservation conflicts.

対象:

- CFS / CFS-C / external / direct source行から、3DPmon管理スプールを明示mountするUI。
- restart / reconnect 後に、保存済みmountと現在観測sourceを照合して表示するread-only join。
- conflict / stale / unknown / provisional source の警告表示。
- 本番physical CFS command、ledger debit、ItemKeeper projectionはこの段階でも別Gateへ残す。

実装境界:

- source card は `設定` / `交換` / `割当解除` を表示する。
- スプール一覧は Universal `OPEN` mount を装着中として扱い、
  `K2Pro-69E7 / 1A` のようなsource-aware装着先を表示する。
- 操作は `createMaterialAccountingSpoolMountRuntime()` の
  `operatorMountSource()` / `operatorReplaceSourceMount()` /
  `operatorUnmountSource()` だけへ委譲する。
- 過去のprint-start snapshot由来mountはread-onlyな履歴表示だけに使い、
  現在`OPEN`なSpoolMountとして `交換` / `割当解除` の操作対象にしない。
- UIから渡す `materialSourceId` やspool候補は利便性の入力であり、service/runtime側が
  送信時に現在観測source、managed spool、legacy occupancy、durable CAS preconditionを
  再検証する。
- 観測sourceの `sourceId` / `materialSourceId` はtransport-local aliasとして扱う。
  durable `MaterialSource.materialSourceId` は `deviceId + unit + locator` から生成し、
  open mount の `sourceBindingAtOpen.aliases` にraw観測IDを残す。これにより複数K2で
  `cfs:1:slot:0` のような同一一時IDが出ても、SpoolMount store上では衝突しない。
- storage CAS preconditionも同じ解決規則を使い、direct keyだけでなくcanonical
  `MaterialSource.materialSourceId` / alias / source binding digest で現在観測sourceを再照合する。
- stale topologyでは操作ボタンをdisabledにし、runtimeの送信時resolverでもmount / replaceを拒否する。
  unmountは既存の3DPmon管理mountを外す操作なので、fresh観測を追加要求しない。
- Universal `OPEN` mountまたはin-flight reservation中のmanaged spoolは、legacy deleteでも廃棄できない。
  先にMaterialSource割当を解除してから削除する必要がある。
- `deleteSpool()` だけでなく、`revertInferredSpool()` や `updateSpool({deleted:true})` /
  `updateSpool({isDeleted:true})` / ID変更patchのような別legacy lifecycle mutationも、
  Universal `OPEN` mountまたはin-flight reservation中は拒否する。
- `revertInferredSpool()` が superseded 旧spoolをlegacy hostへ再装着する場合も、
  旧spool側にUniversal `OPEN` mountまたはin-flight reservationがあればrevert全体を拒否する。
- Universal `OPEN` mountまたはin-flight reservation中のmanaged spoolは、
  `updateSpool({inferred:true})` / `updateSpool({isPending:true})` で未確定状態へ戻さない。
- H-2の管理スプール候補は `inferred:true` と `isPending:true` を除外し、
  service/runtime境界でも `managed-spool-not-confirmed` として拒否する。推定・保留スプールは、
  先にユーザーが確認して実スプール化してからMaterialSourceへ割り当てる。
- 管理スプール割当UIはCFS本体を操作しない。slot select / load / unload / feed /
  retract のphysical commandは Gate 19 / 19.5 のcertification registryが有効になるまで
  productionへ昇格しない。

## Store Shape

```js
materialAccountingSpoolMountStore = {
  schemaVersion: 1,
  authority: "material-accounting-spool-mount-store",
  storeRevision: 0,
  storeDigest: "",
  spoolMounts: [],
  events: [],
  conflicts: [],
  retainedUnsupportedEntries: [],
  invariants: {
    operatorManaged: true,
    deviceObservationWrites: false,
    physicalCommandWrites: false,
    legacyHostSpoolMapWrites: false,
    legacyUsageHistoryWrites: false,
    legacySpoolRemainingWrites: false,
    filamentLedgerWrites: false,
    printBindingWrites: false
  }
};
```

`operationsById` を durable authority として保存しない。再起動後の冪等性は、
`spoolMounts[]` と durable `events[]` から operation index を再構築して回復する。

保存済みstoreが明示的に未来 `schemaVersion` または別 `authority` を名乗る場合、
中の `spoolMounts[]` / `events[]` が現行shapeとしてvalidに見えても、現行production
authorityへ推測復元しない。store全体を `retainedUnsupportedEntries[]` へ保持し、
active `spoolMounts[]` / `events[]` は空として復元する。これにより、将来schemaや別issuerの
意味を現行Gate 18.9H authorityとして誤debit / 誤projectionへ使わない。

## Service API

```js
operatorMountSource({
  operatorActionId,
  expectedDeviceId,
  materialSourceId,
  spoolId,
  actor
});

operatorUnmountSource({
  operatorActionId,
  materialSourceId,
  expectedMountId,
  actor,
  reason
});

operatorReplaceSourceMount({
  operatorActionId,
  expectedDeviceId,
  materialSourceId,
  expectedOldMountId,
  newSpoolId,
  actor
});
```

`expectedMountId` は stale UI から別 mount を誤って close しないため必須とする。
`materialSourceId` はUIから渡せる識別子だが、MaterialSource record本体はservice内の
trusted resolverが現在のread-only observation / registryから再解決する。

## Identity And Digests

`materialSourceId` は canonical accounting identity として扱う。
`1A`、`1B`、`T1A` などの表示ラベルや print assignment は durable ID にしない。

`mountSubjectId` は `deviceId + materialSourceId` から作る。

`operatorActionId` は UI 操作ごとに一度だけ発行される unique ID である。
同じ操作の retry では同じ ID を使う。同じ source/spool の再 mount でも、
別の日や別操作であれば別 operation として扱う。

mount record には、少なくとも以下の source identity binding evidence を残す。

```js
sourceBindingAtOpen = {
  deviceId,
  materialSourceId,
  unitId,
  kind,
  identityStrength,
  identity,
  sourceIdentityDigest,
  locator,
  resolvedAt
};
```

`sourceIdentityDigest` には source identity と locator を含める。
material name、color、remaining、selected、`T1A` は観測値または print assignment
であり、mount authority digest には含めない。

## Legacy Boundary

`hostSpoolMap` は Gate 18.9H では read-only compatibility projection である。

H-1 は K2/CFS の既存 `hostSpoolMap` 1本割当を自動で 1A などへ移行しない。
その spool が同じ K2 に設定されていても、Universal mount へ自動投入しない。
H-2 の UI で operator-confirmed migration candidate として扱う。

ただし H-1 service は `hostSpoolMap` を read-only occupancy として検査し、
同じ managed spool が legacy 側で装着中なら Universal mount を拒否する。

- 別 device の legacy mount: `legacy-spool-already-mounted`
- 同じ multi-source device の legacy mount: `legacy-spool-occupancy-requires-migration`

## Observation Boundary

次の観測や物理操作は SpoolMount を自動 close / rewrite しない。

- app restart
- WebSocket / HTTP / Moonraker disconnect
- provider stale
- CFS / CFS-C detach
- selected source change
- tool assignment change
- RFID missing or unreadable
- remaining value missing
- source temporarily unobserved
- explicit empty / unloaded observation
- CFS load / unload / select / feed / retract command result

これらは将来の debit eligibility を pending / blocked にする材料にはなり得るが、
operator-managed mount interval 自体は変更しない。

## ItemKeeper Boundary

ItemKeeper の `jobs[].filaments[]` は複数 spool の `usedMm` を表現できる。
しかし Gate 18.9H では ItemKeeper payload へ本番接続しない。

将来の projection は、現在の mount store を再参照して履歴を書き換えるのではなく、
print-start snapshot と JobMaterialSegment から historical `filamentInfo[]` 相当を
作って送信する。

これにより、今日 CFS-1A が spool A でも、翌日 spool B へ交換されたときに、
昨日の印刷履歴が spool B へ再解釈される事故を防ぐ。

multi-source job で total-only usage しかない場合は、source 数、色、material 名、
表示順、経過時間から推測配分しない。`unattributedUsage` として隔離し、
ItemKeeper へ per-spool true usage として送らない。

Gate 18.9I-3 では、`job.filamentInfo[]` が無いK2/CFS履歴でも、
`materialAccountingPrintBindingStore.jobMaterialSegments[]` に同一device + printJobIdの
observed-usedまたはconfirmed-unused segmentが保存されていれば、ItemKeeper送信用
`jobs[].filaments[]` へread-only投影する。これは外部送信用のprojectionであり、legacy `usageHistory`、
`filamentSpools.remainingLengthMm`、3DPmon管理スプール残量、CFS物理状態は更新しない。
この投影は、同一device ID、source-aware `debit.status:"eligible"`、および
`itemKeeperProjection.status:"certified"` が揃うsegmentだけを対象にする。
未certifiedのK2 `materialUsed` CSV source順序や、debit不適格segmentは
ItemKeeperへper-spool true usageとして送らない。

### Gate 18.9J-1: ItemKeeper Source Usage Live Fixture Receipt

Gate 18.9J-1 では、ItemKeeper source-aware projection を本番送信へ解禁しない。
この段階の目的は、K2/Creality 履歴の `materialUsed` CSV と print-start snapshot order、
`JobMaterialSegment` の対応を、実機fixtureとしてレビュー可能なreceiptへ固定することである。

実装境界:

- `dashboard_material_used_csv_parser.js` は K2 `materialUsed` CSV の解析を
  `k2-material-used-csv:v1` として提供する。
- CSV位置をMaterialSourceへ対応付ける規則は
  `print-start-binding-authority-order:v1` としてparserVersionから分離する。
- `evaluateItemKeeperSourceUsageLiveFixture()` は、`fixtureEvidence`、
  `printStartSnapshots`、`jobMaterialSegments`、raw `materialUsedSourceCsv` を
  print result set全体で検査し、`fixture-accepted` / `fixture-rejected` receiptを返す。
- `fixtureEvidence.reviewedCommit` はfull 40-hex SHAを必須とする。
- `expectedSourceOrder.length`、CSV part数、print-start snapshot数、
  `JobMaterialSegment`数は一致しなければならない。
- CSV parserはruntime/fixture共通の `resolveK2MaterialUsedSourceCsv()` でraw値を選び、
  fixture rawと履歴rawが両方ある場合は同一文字列でなければならない。
- CSVのempty field、指数表記、hex表記はsource位置の詰め替えを防ぐためrejectする。
- `expectedSourceOrder.order` / `toolId` は明示された非負整数を必須とし、
  `null` / `""` を0へ補正しない。
- `expectedSourceOrder.usedLengthMm` と `JobMaterialSegment.usedLengthMm` は明示された
  非負有限数を必須とし、`null` / `""` / `undefined` を0mmへ補正しない。
- `expectedSourceOrder` 内の `order` / `protocolToolAlias` / `snapshotId` は重複不可。
- `observed-used` sourceは `usedLengthMm > 0`、`confirmed-unused` sourceは
  `usedLengthMm === 0` を要求する。
- `debit.status:"eligible"` はsource-aware projection fixtureの必須条件だが、
  `confirmed-unused` の0mm sourceでは `debit.canDebit:false` でもよい。
- fixture receiptのauthorityは
  `itemkeeper-source-usage-live-fixture-evidence` とし、runtime projection registryの
  `module-owned-live-certification-registry` とは別にする。
- fixture receiptのcapabilityは常に
  `canRegisterProjection:false` / `canProjectItemKeeper:false` とする。
- fixture receiptを `segment.itemKeeperProjection` へ貼っても
  `isItemKeeperProjectionCertified()` はtrueにならない。

HOLD境界:

- Gate 18.9J-1は runtime registryへdigestを登録しない。
- ItemKeeper `jobs[].filaments[]` へのsource-aware実送信は解禁しない。
- production issuerは、review済みfixture digestをmodule-owned immutable registryへ組み込み、
  current model / firmware / parser / sourceOrderingProfile / result set と照合する
  Gate 18.9J-2 までHOLDする。

### Gate 18.9J-2: Reviewed Fixture Registry Scaffold

Gate 18.9J-2 scaffoldでは、J-1で作ったfixture receiptをcallerが渡すだけでは
ItemKeeper projection registryを開かない。production `registerItemKeeperSourceUsageProjectionCertification()`
は、module-owned immutable reviewed fixture registryと一致する場合だけ内部issuer tokenで
`module-owned-live-certification-registry` へ登録できる。

現時点のproduction registryは空であり、J-2用のK2実機fixture captureがreviewされるまで
`reviewed-live-fixture-registry-entry-required` でfail-closedする。pure evaluator
`evaluateItemKeeperSourceUsageReviewedFixtureRegistryMatch()` は、fixtureDigest、reviewedCommit、
parserVersion、sourceOrderingProfile、captureSha256、device scope、projection digestを照合する。
これにより、fixture receiptやexport JSON上の文字列だけを後付けしてもproduction ItemKeeper
source-aware送信には昇格しない。

実機fixture review後にregistry entryを追加する場合は、entryを以下へbindする。

- `registryEntryId`
- `fixtureDigest`
- `reviewedCommit`
- `parserVersion`
- `sourceOrderingProfile`
- `captureSha256`
- `device.printerType`
- `device.model`
- `device.firmwareVersion`
- `projectionDigests[]`

## P0/P1 Tests

H-1a/H-1b では最低限以下を固定する。

- 1A -> spool A、1B -> spool B を同一 device で同時 open できる。
- 同一 MaterialSource へ2本 open できない。
- 同一 spool を別 source/device へ同時 open できない。
- legacy `hostSpoolMap` で装着中の spool を Universal source へ open できない。
- Universal `OPEN` mount済みspoolを legacy `hostSpoolMap` へ open できない。
- Universal mount / replace のdurable write中は process-local reservation により、
  legacy `setCurrentSpoolId()` と別Universal操作が同じspoolを取得できない。
- 同じ `operatorActionId` と同じ payload は restart 後も idempotent。
- 同じ `operatorActionId` と異なる payload は restart 後も conflict。
- replace の new mount conflict / CAS mismatch / durable failure では old mount が
  open のまま残る。
- `casApplied:false` または durable failure では `monitorData` を変更しない。
- concurrent stale-base write は CAS mismatch で止める。
- corrupt / unsupported / conflicting imported records は quarantine される。
- conflicting open mount は first-win で採用されない。
- restore / import reconciliation は `CLOSED` mount履歴を現在装着conflictとして隔離しない。
- importが `hostSpoolMap` だけを追加した場合でも、既存current Universal `OPEN` mountを
  final current backend状態に対して再照合して隔離する。
- import経路ではreconcile後のactive storeをIndexedDB shared keyへCAS保護で書き戻す。
  restore経路では起動を止めずに非同期CASを試み、完了前にoperator操作が入った場合は
  storage digest preconditionでfail-closedする。
- legacy `hostSpoolMap` のimport/restoreもUniversal `OPEN` mount /
  in-flight reservationを検査し、同じmanaged spoolをlegacy側へ二重装着しない。
- inferred取消でsuperseded旧spoolをlegacyへ復元する経路も同じ検査を通し、
  旧spoolがUniversal側で使われている場合はinferred側もold側も変更しない。
- `identityStrength: "unknown"` の source は mount できない。
- provisional source は manual mount できるが、future debit は revalidation まで
  pending になる。
- wrong-device source、missing spool、deleted spool は mount できない。
- mount / unmount / replace は `hostSpoolMap`、`usageHistory`、
  `filamentSpools.remainingLengthMm`、`materialAccountingPrintBindingStore`、
  `physicalCommandRecoveryLatch` を変更しない。
- print-start snapshot由来の過去mount表示だけでは、H-2 UIの `交換` /
  `割当解除` を有効にしない。
- Universal `OPEN` mount中のspoolはスプール一覧/状態フィルタで装着中として表示する。

## Follow-up Gates

Gate 18.9H-2 follow-up:

- K2/CFS の legacy `hostSpoolMap` 1本割当を migration candidate として表示する。
- H-2 UIで設定したsource別mountを、後続Gate 18.9Iのprint-start snapshotへ接続する。

Gate 18.9I-1:

- runtime print-start から PrintPlan + production SpoolMount snapshot を保存する。
  caller が渡した `printJobId` は自己申告として扱い、対象 `hostname` の
  `monitorData.machines[hostname]` に現在観測されている `printStore.current.id`
  または `storedData.printId` と一致する場合だけ採用する。さらに対象machineの
  `runtimeData.printerCoreV3Shadow.deviceId/sessionId` を同じ観測へ束縛し、
  送信側がconnection generationを束縛した場合は観測側にも同じgenerationを要求する。
  PrintPlan deviceと異なるcurrent job、またはsession不明のcurrent jobはtrusted
  print-startへ昇格しない。実機観測済み `printJobId` が無い場合、または一致しない場合も保存しない。
- `capturedAt` はcaller supplied値をauthorityとして使わず、既存snapshotまたは
  現在機器観測のstart timeから解決する。開始時刻が無い観測では保存しない。
- binding operation ID は `deviceId + printPlanId + printJobId` で安定化し、
  同一print-start retryではidempotentとして扱う。
- runtime経由のsnapshotはcontract module内のtrusted print-start issuerで発行し、
  public shadow repositoryは引き続きtrusted snapshotをmintしない。
- print-start時点で現在 `OPEN` なsource別SpoolMountが揃わない場合もblockedにする。
- `materialAccountingPrintBindingStore` は通常flush queue投入だけでは成功扱いにせず、
  `commitMaterialAccountingPrintBindingStoreDurably()` のIndexedDB CASが
  `casApplied:true` を返した後だけruntime storeへ反映する。custom persistも
  `{ok:true, casApplied:true}` を返す場合だけ成功扱いにする。
- `materialAccountingPrintBindingStore` はIndexedDB通常flush queueのCAS protected keyとして扱い、
  import時はbase/current storeとincoming storeをsemantic ID単位でmerge/quarantineした候補を
  IndexedDB CASへ渡し、CAS成功後だけruntimeへ反映する。restore時も同じmerge規則を使い、
  同一IDでpayloadが異なるrecordは勝者を作らず `retainedUnsupportedEntries` へ隔離する。
- managed remaining、legacy `usageHistory`、ItemKeeper projection、
  completion observation はまだ接続しない。

Gate 18.9I-2:

- completion observation runtimeを追加し、実機履歴で完了済みPrintJobとして観測できた場合だけ
  JobMaterialSegment / shadow ledger eventへ接続する。
- 完了時もcaller supplied `completedAt` やusage payloadだけをauthorityにせず、対象hostの
  `printStore.history` 上の完了entry、Printer Core v3 device/session、任意のconnection generation
  bindingを照合する。
- K2/Creality履歴の `materialUsed:"3210,6543"` 形式は、completion時callerの
  PrintPlan assignmentではなく、保存済みprint-start snapshotの `order` 順へ展開し、
  `T1A` / `T1B` などのprotocol aliasとhistorical MaterialSource / SpoolMount
  snapshotへ対応付ける。
- `parseRawHistoryEntry()` / `jobsToRaw()` はK2/CFSのsource-specific
  `materialUsed` CSVを `materialUsedSourceCsv` / `materialUsed` としてlosslessに保存し、
  total使用量は `materialUsedTotalObserved` と分離する。未観測totalの互換0は
  source-specific runtimeのtotal authorityへ採用しない。
- `materialUsed` CSVの要素数と保存済みsnapshot数が一致しない場合は
  `material-used-source-count-mismatch` でBLOCKし、余剰値を黙って捨てない。
- runtimeはcontract module内のtrusted print-start / source-specific usage issuer注入済み
  repositoryを使う。public repositoryは引き続きtrusted usage evidenceやdebit authorityをmintしない。
- result-set completenessは、同一runtime内で保存済みtrusted print-start snapshotのsource setと
  完了usage setが一致する場合だけmodule-owned evidenceとして発行できる。caller supplied
  `complete` やtrusted風booleanだけでは未出現sourceを0mm確定にしない。
- 同一process内でCAS保存済みtrusted print-start snapshotをJSON cloneから再読した場合は、
  module-owned attestationを再検証してdebit eligibility候補へ戻せる。restart/import後は
  process secretが異なるため、再確認されるまでfail-closedに落ちる。
- source continuity / fresh topologyなどのdebit eligibilityはruntime内の
  MaterialSource observation resolverと正式freshness TTL判定から作り、caller supplied
  continuity objectはtrusted authorityへ採用しない。TTL切れ、provider disconnected、
  restored last-knownでは `freshTopology:false` / `sourceContinuity:false` になり、
  source-specific segmentは保存してもmanaged remaining debit候補には昇格しない。加えて、
  print-start snapshotの `capturedAt` 以後からcompletionまでに、同じsourceの
  `source-changed` / `source-disappeared` / `source-merge-conflict` eventが観測された場合は、
  完了時点のtopologyがfreshでも `physicalDiscontinuity:true` /
  `sourceContinuity:false` としてdebit候補から外す。この段階では
  managed spool残量、legacy `usageHistory`、ItemKeeper projectionへは反映しない。
- completion writeも専用CAS境界を必須とし、`casApplied:true` が無いpersist結果では
  runtime storeを進めない。
- completion writeがCAS失敗などでpendingを残した場合、live bridgeは初回completion受信時刻を
  `completionFirstObservedReceivedAt` として固定する。retry時も同じ時刻をruntimeへ渡し、
  初回completion後に観測したMaterialSource snapshotを印刷intervalへ遡及採用しない。

Gate 18.9I-3:

- ItemKeeper `buildFilaments()` は、既存 `job.filamentInfo[]` があるジョブでは従来通りそれを優先する。
- `job.filamentInfo[]` が無いジョブでも、print binding storeに同じPrintJob IDかつ
  同じPrinter Core v3 device IDの `observed-used` / `confirmed-unused`
  `JobMaterialSegment` があれば、segment順で `jobs[].filaments[]` へread-only投影する。
- print binding storeは全機器共有なので、ItemKeeper projectionは `printJobId` だけを
  global identityと見なさず、`buildSnapshot()`から渡した機器scopeでsegmentを絞り込む。
- projectionは `spoolId` / `usedMm` に加えて、診断用に `materialSourceId`、
  `mountId`、`printPlanId`、`protocolToolAlias`、`usageState`、`confidence`、
  `projectionSource`、`spoolRemainBasis` をadditive fieldとして送る。
- total-only usageやspool未解決segmentは、per-spool true usageとしてItemKeeperへ送らない。
- この接続は外部payload projectionだけであり、managed spool残量debit、legacy
  `usageHistory`、`filamentSpools.remainingLengthMm` は更新しない。

Gate 18.9I-4:

- K2/CFS印刷開始UIで生成したPrinter Core command requestとは別に、同じUI割当から
  `dashboard_material_binding_plan.js` のmodule-attested `MaterialBindingPlan` を生成し、
  実送信直前に `dashboard_material_accounting_print_binding_live_bridge.js` へpending登録する。
  既存remote G-codeでは正式PrintPlan用のG-code content/upload receiptが無い場合があるため、
  PrintPlan contractを弱めず材料割当専用contractへ分離する。
- `MaterialBindingPlan` はtool/source/asset/session/generationの割当証跡であり、
  `spoolId` 自体は任意である。3DPmon管理スプールが未割当でもK2/CFS transport送信は妨げず、
  print-start binding runtimeが同時刻の `OPEN` SpoolMount を見つけられない場合だけ
  `spool-mount-required` として会計snapshot保存を拒否する。
- transport-local source IDはaliasとして扱う。repositoryはMaterialSourceをcanonical IDとaliasで再解決し、
  OPEN mount探索でもcanonical IDとaliasの両方を候補にするが、保存snapshotにはcanonical
  `materialSourceId` を残す。
- pending登録は `prepared` stateであり、実機 `printStartTime` / `printJobId`
  観測前、かつtransport送信成功前にはprint binding runtimeを呼び出さない。
- transport送信が失敗した場合はpendingを破棄する。送信成功時だけ
  `markMaterialAccountingPrintStartRequestSubmitted()` で `submittedAt` とcommand IDを固定する。
- WebSocket statusでK2 Printer Core v3 shadow付きmachineの `printStartTime` を観測した場合、
  `observedFirstObservedAt >= submittedAt`、同じsession/generation、かつ
  `baselinePrintJobId` と異なる新jobである場合だけpending MaterialBindingPlanを
  `recordObservedPrintStart()` へ渡す。送信成功前に観測が先着した場合はqueued observationとして
  保留し、submitted後に再評価する。
- `printStore.history` へ完了履歴が入った後、同じpending MaterialBindingPlanを
  `recordObservedPrintCompletion()` へ渡す。成功完了後はpendingを削除し、後続の手動/別jobへ
  旧planを再bindしない。K2/Creality履歴の `materialUsed` CSVはruntime側で保存済み
  print-start snapshot順にsource-specific usageへ展開する。
- trusted print-start snapshotには `issuanceEvidence` として、runtimeが観測した
  `deviceId`、`sessionId`、`connectionGeneration`、`printJobId`、`firstObservedAt` を保存する。
- source continuity windowの下限に使うSpoolMount開始時刻は、trusted snapshotの
  top-level `mountOpenedAt` に固定し、snapshot signatureへ含める。embedded
  `spoolMount.openedAt` はreview/debug用の診断証跡であり、import/restore後の改変で
  mount-open後print-start前のsource変更eventを検査範囲外へ追い出せない。
- trusted print-start snapshotは `bindingAuthority` として `toolId` /
  `protocolToolAlias` / `order`、canonical MaterialSource semantic、SpoolMount debit
  semanticを保存し、`bindingAuthorityDigest` をsnapshot signatureへ含める。K2の
  `materialUsed` CSVはdiagnostic payloadではなく、このauthority orderへ対応付ける。
- nested `spoolMount` / `materialSource` はdiagnostic-only payloadである。
  debit evaluatorへ渡すmount/sourceは `bindingAuthority` から再構成し、diagnostic
  `spoolMount.verification` や `materialSource.displayLabel` の後付け変更では
  debit結果を変えない。逆に `bindingAuthority` 側のorder/openedAt/source/mountが
  signatureと矛盾した場合は `untrusted-print-start-snapshot` としてdebit候補へ昇格しない。
- source continuityの照合IDは `bindingAuthority.source` と完了時の現在観測
  `MaterialSource` だけから作る。diagnostic `snapshot.materialSource.aliases` は後付け改変で
  continuity判定を変えられない。
- `bindingAuthority.mount.sourceIdentityDigestAtOpen` は canonical SpoolMount の
  `sourceBindingAtOpen.sourceIdentityDigest` をauthorityへ写す。diagnostic互換fieldがあれば読むが、
  実storeのcanonical位置は `sourceBindingAtOpen` である。
- trusted print binding repository factoryはpublic barrel
  `dashboard_material_accounting_print_binding.js` から再exportしない。production runtimeは
  caller supplied `data` / `persist` DIを拒否し、test fixtureだけ
  `createMaterialAccountingPrintBindingRuntimeForTest()` で注入できる。
- trusted factory / issuer-injected repository / test-only runtime factory のimport境界は
  `3dp_lib/**/*.js` のproduction module全体へESLint allowlistとして固定する。allowed module以外の
  relative path違いimportもrelease前lintで失敗させる。P2-9 follow-upとして、
  restricted authority moduleをdynamic importする経路もproduction moduleでは
  `no-restricted-syntax`で失敗させる。production dynamic importはliteral必須とし、
  computed pathでrestricted module名を隠す経路も同じlint境界で拒否する。
- ItemKeeper source-aware projectionのdigest/registry判定は
  `dashboard_itemkeeper_source_usage_projection_certification.js` に分離する。
  `dashboard_integration_itemkeeper.js` はproduction placeholder登録とdigestだけを公開し、
  test-only issuer / registry resetはexportしない。production moduleからtest-only issuerを
  importする経路もrelease前lintで失敗させる。
- `MaterialBindingPlan`本体と`commandBinding`は、pending登録時にdevice/session/generation/file/source/spool/toolの
  semantic projectionで再照合する。module-attested planであっても、request Aのbindingを
  別source/fileのplanへ混ぜた場合は拒否する。
- start/completionのlocal receipt timeは、CAS/runtime retry後も初回値へ固定する。
  retryでprint interval境界を後ろへ動かし、途中のsource/provider breaking eventを隠すことはできない。
- print-start local receiptと同一msのsource/provider breaking eventは、print interval内の
  physical discontinuityとして扱い、debit候補へ昇格しない。
- I-4でもmanaged spool残量debit、legacy `usageHistory`、`filamentSpools.remainingLengthMm`
  への書き込みは行わない。

Gate 19 / 19.5:

- CFS physical command は command kind ごとに実機 certification する。
- module-owned registry に登録された command だけ production UI で有効化する。
