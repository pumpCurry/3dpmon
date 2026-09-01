# Printer Core v3 Gate 18.9H SpoolMount Authority

Last updated: 2026-09-01

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
- 通常の throttled storage flush は backup / export 可視性のために同storeをqueueするが、
  operator mount / unmount / replace のproduction成功判定には使わない。
- production write は `commitMaterialAccountingSpoolMountStoreDurably()` だけを通り、
  IndexedDB の `compareAndSwapSharedValue()` が `casApplied:true` を返した場合のみ
  runtime store を更新する。
- localStorage fallback は restore/export 用に正規化済みstoreを保持できるが、
  production write では `production-cas-unavailable` として失敗させる。
- import時に既存storeと異なる非空storeが来た場合は、自動mergeやfirst-winを行わず、
  conflict evidence として `retainedUnsupportedEntries` へ隔離する。

### Gate 18.9H-2: Operator Mount UI

H-2 では、H-1b で永続化された `SpoolMount` をフィラメント管理UIへ接続する。

Status: implemented and tested in PR #440 after `afc3d37`.

対象:

- CFS / CFS-C / external / direct source行から、3DPmon管理スプールを明示mountするUI。
- restart / reconnect 後に、保存済みmountと現在観測sourceを照合して表示するread-only join。
- conflict / stale / unknown / provisional source の警告表示。
- 本番physical CFS command、ledger debit、ItemKeeper projectionはこの段階でも別Gateへ残す。

実装境界:

- source card は `設定` / `交換` / `割当解除` を表示する。
- 操作は `createMaterialAccountingSpoolMountRuntime()` の
  `operatorMountSource()` / `operatorReplaceSourceMount()` /
  `operatorUnmountSource()` だけへ委譲する。
- UIから渡す `materialSourceId` やspool候補は利便性の入力であり、service/runtime側が
  送信時に現在観測source、managed spool、legacy occupancy、durable CAS preconditionを
  再検証する。
- stale topologyでは操作ボタンをdisabledにし、最終観測状態からoperator mountを変更しない。
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
- `identityStrength: "unknown"` の source は mount できない。
- provisional source は manual mount できるが、future debit は revalidation まで
  pending になる。
- wrong-device source、missing spool、deleted spool は mount できない。
- mount / unmount / replace は `hostSpoolMap`、`usageHistory`、
  `filamentSpools.remainingLengthMm`、`materialAccountingPrintBindingStore`、
  `physicalCommandRecoveryLatch` を変更しない。

## Follow-up Gates

Gate 18.9H-2 follow-up:

- K2/CFS の legacy `hostSpoolMap` 1本割当を migration candidate として表示する。
- source-aware read model で spool 一覧に `装着中: K2Pro-69E7 / CFS 1A` のような
  表示を出す。
- H-2 UIで設定したsource別mountを、後続Gate 18.9Iのprint-start snapshotへ接続する。

Gate 18.9I-1:

- runtime print-start から PrintPlan + production SpoolMount snapshot を保存する。
- completion observation を JobMaterialSegment / shadow ledger event へ接続する。
- managed remaining はまだ減らさない。

Gate 18.9I-2:

- trusted source-specific usage issuer と legacy cutover guard を追加する。
- K2/CFS first universal-authoritative debit を実機証跡に基づいて有効化する。

Gate 19 / 19.5:

- CFS physical command は command kind ごとに実機 certification する。
- module-owned registry に登録された command だけ production UI で有効化する。
