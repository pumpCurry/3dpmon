# 3DPmon / ItemKeeper v2 Multi-Source Sync Contract

Last updated: 2026-09-15

Status: 3DPmon producer-side implementation contract. ItemKeeper (ik2) receiver implementation,
canonical fixtures, and cross-repository certification are pending.

この文書は、CFS/CFS-Cなど複数フィラメント供給源を持つプリンタについて、3DPmonが保持する
MaterialSource、SpoolMount、source別使用量、交換履歴をItemKeeperへ同期するv2契約を定義する。
既存APIはv1として維持し、v2はversioned endpointとOffer/Need/Push差分同期を追加する。

## 1. Goals

- `1 device = 1 spool`を前提にせず、1ジョブ内の複数source・mount・spool使用量を伝える。
- 3DPmon管理スプールID、機器RFID、物理source、protocol aliasを別identityとして保持する。
- CFS slotの交換前後、装着・解除、同一source内の複数usage segmentをappend-only履歴にする。
- ItemKeeperの受理、mapping、在庫反映をrecord単位で区別する。
- retry、restart、順序入替、correctionで二重計上しない。
- physical CFS commandと在庫管理上のmount/debitを分離する。

## 2. Non-Goals

- ItemKeeper同期からCFSのload/unload/selectを実行しない。
- RFID reported remainingで3DPmon管理残量を自動上書きしない。
- source別使用量が無いmulti-source jobを色・残量・材料名で推測配分しない。
- ItemKeeperのmapping結果を3DPmonのSpoolMount authorityへ逆流させない。

## 3. Versioned Endpoints

```text
GET  /api/v2/integrations/3dpmon/capabilities
POST /api/v2/integrations/3dpmon/sync/plan
POST /api/v2/integrations/3dpmon/sync/push

POST /api/v1/ingest/print-events
POST /api/ingest/print-events                 # deprecated v1 compatibility alias
```

- 新規clientはversionを含むURLだけを保存する。
- unversioned endpointはv1 aliasであり、意味をv2へ自動変更しない。
- `/current/` aliasは導入しない。clientが未認識のcontractへ自動移行する事故を避ける。
- v1終了予定はcapabilitiesと運用告知で通知し、3DPmon UIにも警告する。
- 全requestは`Authorization: Bearer <token>`、`Content-Type: application/json`、
  `X-3DPmon-Request-Id: <requestId>`を送る。

## 4. Protocol Identity

全v2 payloadは次のenvelope identityを持つ。

```json
{
  "contract": "3dpmon-itemkeeper-v2",
  "contractVersion": "2.0.0",
  "producerInstanceId": "ikp_01J00000000000000000000000",
  "producerStateEpochId": "ike_01J00000000000000000000000"
}
```

- `producerInstanceId`: 3DPmon installationを識別し通常restartでは変えない。
- `producerStateEpochId`: storage初期化やauthority data全置換で連続性を失った時だけ更新する。
- ItemKeeperは`(clientId, producerInstanceId, producerStateEpochId)`を同期scopeとする。
- `deviceId`: Printer Coreのcanonical device identity。hostnameや接続先IPを使わない。
- `runId`: 同じ物理print runをretry/restart後も識別するID。`deviceId`、trusted `jobId`、
  最初のtrusted print-start identityから3DPmonが一度だけ発行し、以後変更しない。
- `consumptionIdentity`: 同一run内の消費semantic。`runId`、tool/source、`segmentOrdinal`から発行し、
  correction後も元消費を参照する不変IDとする。

## 5. Resources And Streams

| Name | Kind | Meaning |
| --- | --- | --- |
| `devices` | revisioned snapshot | device identityと表示情報 |
| `materialSources` | revisioned snapshot | device-scoped sourceとalias履歴 |
| `managedSpools` | revisioned snapshot | 3DPmon管理スプールmetadata |
| `spoolMounts` | revisioned snapshot | 現在・過去のmount interval |
| `spoolMountEvents` | append-only stream | mount open/close/replace監査履歴 |
| `materialUsageEvents` | append-only stream | source/spool別usage、correction、void |
| `jobResultEvents` | append-only stream | job material result-set completeness |

snapshotの`revision`とstreamの`sequence`は別namespaceである。stream eventの`eventRevision`も
sequenceとは別で、同じsemantic eventを訂正するときだけ増加する。

## 6. Capabilities Contract

### Request

`GET /api/v2/integrations/3dpmon/capabilities`。bodyなし。

### Response 200

```json
{
  "contract": "3dpmon-itemkeeper-v2",
  "contractVersion": "2.0.0",
  "serverId": "itemkeeper-installation-id",
  "supportedContractVersions": ["2.0.0"],
  "compression": ["identity", "gzip"],
  "maxPushRecords": 250,
  "maxRequestedIds": 100,
  "resources": {
    "snapshots": ["devices", "materialSources", "managedSpools", "spoolMounts"],
    "streams": ["spoolMountEvents", "materialUsageEvents", "jobResultEvents"]
  },
  "needKinds": ["snapshot", "event-range", "events-by-id", "records-by-id"],
  "resultStates": ["accepted", "duplicate", "mapped", "materialized", "pending-mapping", "quarantined", "unsupported", "unavailable"],
  "cutoverModes": ["v1", "v2-shadow", "v2-authoritative"],
  "deprecated": {"unversionedV1Alias":true,"sunsetAt":null},
  "serverTime": "2026-09-15T05:00:00.000Z"
}
```

未知contract major、未知Need kind、上限超過は送信前にfail-closedとする。

## 7. Offer / Plan / Need Contract

### Plan Request

```json
{
  "contract": "3dpmon-itemkeeper-v2",
  "contractVersion": "2.0.0",
  "producerInstanceId": "ikp_01J00000000000000000000000",
  "producerStateEpochId": "ike_01J00000000000000000000000",
  "requestId": "req_01J00000000000000000000000",
  "requestBodyDigest": "sha256:0123456789abcdef",
  "offeredAt": "2026-09-15T05:00:00.000Z",
  "snapshots": [
    {"resource":"materialSources","revision":42,"recordCount":5,"canonicalDigest":"sha256:source-snapshot"},
    {"resource":"managedSpools","revision":18,"recordCount":16,"canonicalDigest":"sha256:spool-snapshot"}
  ],
  "streams": [
    {"stream":"spoolMountEvents","minSequence":1,"maxSequence":142,"eventCount":142,"headDigest":"sha256:mount-head"},
    {"stream":"materialUsageEvents","minSequence":1,"maxSequence":981,"eventCount":981,"headDigest":"sha256:usage-head"}
  ],
  "deviceCutovers": [
    {"deviceId":"device:k2pro-69e7","jobMode":"v2-shadow","materialUsageMode":"v2-shadow"}
  ]
}
```

`requestBodyDigest`は同field自身を除いたcanonical JSONのSHA-256である。同じ`requestId`で別digestを
受けたItemKeeperはHTTP 409で拒否する。

### Plan Response

```json
{
  "contract": "3dpmon-itemkeeper-v2",
  "contractVersion": "2.0.0",
  "planId": "plan_01J00000000000000000000000",
  "issuedAt": "2026-09-15T05:00:01.000Z",
  "expiresAt": "2026-09-15T05:05:01.000Z",
  "needs": [
    {"needId":"need-1","kind":"snapshot","resource":"materialSources","revision":42},
    {"needId":"need-2","kind":"records-by-id","resource":"managedSpools","recordIds":["031","044"]},
    {"needId":"need-3","kind":"event-range","resource":"materialUsageEvents","fromSequence":970,"toSequence":981}
  ]
}
```

Need allowlist:

- `snapshot`: snapshot resource + exact offered revision。
- `records-by-id`: snapshot resource + 1から100件のrecord ID。
- `event-range`: stream resource + inclusive sequence range、最大250件。
- `events-by-id`: stream resource + 1から100件のevent ID。

範囲外revision、未Offer resource、expired plan、重複`needId`はPushせず再Planする。

## 8. Push / Result Contract

### Push Request

```json
{
  "contract": "3dpmon-itemkeeper-v2",
  "contractVersion": "2.0.0",
  "producerInstanceId": "ikp_01J00000000000000000000000",
  "producerStateEpochId": "ike_01J00000000000000000000000",
  "requestId": "req_01J00000000000000000000001",
  "requestBodyDigest": "sha256:push-body",
  "planId": "plan_01J00000000000000000000000",
  "pushedAt": "2026-09-15T05:00:02.000Z",
  "batches": [{"needId":"need-3","resource":"materialUsageEvents","records":[]}]
}
```

- 1 requestの総record数はcapabilitiesの`maxPushRecords`以下。
- `records[]`はNeedのresource/kind/range/IDに完全一致するものだけを含む。
- unavailable recordは空recordsで成功扱いにせず、Resultの`unavailable`で明示する。

### Push Response

```json
{
  "contract": "3dpmon-itemkeeper-v2",
  "contractVersion": "2.0.0",
  "requestId": "req_01J00000000000000000000001",
  "planId": "plan_01J00000000000000000000000",
  "receivedAt": "2026-09-15T05:00:03.000Z",
  "results": [
    {"needId":"need-3","recordId":"usage-event-uuid","status":"materialized","itemKeeperRecordId":"ik-usage-1001","errorCode":null,"message":null}
  ],
  "batchStatus": "partial"
}
```

`batchStatus`は`complete`または`partial`。HTTP 2xxはbatch envelope受理だけを意味し、各recordの
在庫反映を意味しない。3DPmonはrecord単位Resultをdurableに保持する。

## 9. Snapshot Record Contracts

### MaterialSource

```json
{
  "recordId": "material-source:device:k2pro-69e7:cfs:1:slot:0",
  "revision": 42,
  "payloadDigest": "sha256:material-source",
  "deviceId": "device:k2pro-69e7",
  "materialSourceId": "material-source:device:k2pro-69e7:cfs:1:slot:0",
  "protocolSourceAliases": ["cfs:1:slot:0"],
  "displayLabel": "1A",
  "kind": "cfs-slot",
  "locator": {"unitId":"cfs:1","boxId":1,"slotId":0},
  "identity": {"materialType":"PLA","color":{"raw":"#09ea7ae","displayHex":"9ea7ae"},"rfid":null},
  "observedAt": "2026-09-15T04:00:00.000Z",
  "observationState": "fresh"
}
```

### ManagedSpool

```json
{
  "recordId": "031",
  "revision": 18,
  "payloadDigest": "sha256:managed-spool",
  "managedSpoolId": "031",
  "displayName": "CC3D サンドカラー",
  "materialType": "PLA+",
  "color": {"displayHex":"f0c1b2"},
  "diameterMm": 1.75,
  "densityGPerCm3": 1.24,
  "initialLengthMm": 336000,
  "remainingLengthMm": 235800,
  "status": "active",
  "updatedAt": "2026-09-15T04:00:00.000Z"
}
```

ItemKeeperは`managedSpoolId`だけでmaterial名・色・径・密度を推測しない。Need
`records-by-id/managedSpools`で対応metadataを取得する。

### SpoolMount

```json
{
  "recordId": "mount-uuid",
  "revision": 77,
  "payloadDigest": "sha256:mount-record",
  "mountId": "mount-uuid",
  "deviceId": "device:k2pro-69e7",
  "materialSourceId": "material-source:device:k2pro-69e7:cfs:1:slot:0",
  "managedSpoolId": "031",
  "state": "OPEN",
  "openedAt": "2026-09-15T04:01:00.000Z",
  "closedAt": null,
  "sourceIdentityDigestAtOpen": "sha256:source-binding"
}
```

## 10. Append-Only Event Envelope

```json
{
  "eventId": "usage-event-uuid",
  "eventType": "material-usage.recorded",
  "eventRevision": 1,
  "occurredAt": "2026-09-15T04:30:00.000Z",
  "payloadDigest": "sha256:event-payload",
  "stream": {"name":"materialUsageEvents","sequence":981,"previousDigest":"sha256:previous-event","digest":"sha256:current-event"},
  "payload": {}
}
```

- `stream.sequence`: epoch内で1から単調増加する配送順。欠番はmaterializeせずNeedで回収する。
- `eventRevision`: 同じ`eventId`のsemantic revision。通常eventは1。
- 同じ`eventId + eventRevision + payloadDigest`はduplicateとして冪等受理する。
- 同じ`eventId + eventRevision`で異なるdigestは双方をintegrity conflictとして隔離する。
- correction/voidは元eventを書き換えず、新event IDでappendする。

## 11. RFID Contract

raw mode:

```json
{"mode":"raw","vendor":"creality","namespace":"creality-cfs-rfid-v1","uid":"vendor-observed-uid","observedAt":"2026-09-15T04:00:00.000Z"}
```

privacy mode:

```json
{"mode":"digest","vendor":"creality","namespace":"creality-cfs-rfid-v1","algorithm":"sha256","value":"sha256:rfid-digest","keyScope":"producer-instance","observedAt":"2026-09-15T04:00:00.000Z"}
```

- `managedSpoolId`とRFIDは別field・別authority。
- raw送信は明示設定時のみ。通常ログへUIDを出さない。
- digest比較は`vendor + namespace + algorithm + keyScope`がすべて同じ場合だけ有効。
- `keyScope:"producer-instance"`のdigestは別3DPmon installation間で同一性比較できない。
- RFID無しは`null`であり、空文字やfabricated digestを送らない。

## 12. Spool Mount Events

```json
{
  "eventId": "mount-event-uuid",
  "eventType": "spool-mount.opened",
  "eventRevision": 1,
  "occurredAt": "2026-09-15T04:01:00.000Z",
  "payloadDigest": "sha256:mount-opened",
  "stream": {"name":"spoolMountEvents","sequence":142,"previousDigest":"sha256:prev","digest":"sha256:current"},
  "payload": {
    "operationId":"operator-operation-uuid",
    "deviceId":"device:k2pro-69e7",
    "materialSourceId":"material-source:device:k2pro-69e7:cfs:1:slot:0",
    "protocolSourceAliasAtEvent":"cfs:1:slot:0",
    "mountId":"mount-uuid",
    "managedSpoolId":"031",
    "rfidAtEvent":null,
    "sourceIdentityDigestAtEvent":"sha256:source-binding",
    "reason":"operator-confirmed"
  }
}
```

- open/closeを別eventにする。
- replaceは旧mountの`spool-mount.closed`と新mountの`spool-mount.opened`を同じ`operationId`で送る。
- reconnect、stale、selected変更、physical load/unloadだけではmountをcloseしない。
- 外した履歴と過去jobのmount参照は削除しない。

## 13. Material Usage Events

```json
{
  "eventId": "usage-event-uuid",
  "eventType": "material-usage.recorded",
  "eventRevision": 1,
  "occurredAt": "2026-09-15T04:30:00.000Z",
  "payloadDigest": "sha256:usage-recorded",
  "stream": {"name":"materialUsageEvents","sequence":981,"previousDigest":"sha256:prev","digest":"sha256:current"},
  "payload": {
    "deviceId":"device:k2pro-69e7",
    "jobId":"1780000000",
    "runId":"run_01J00000000000000000000000",
    "consumptionIdentity":"consumption_01J00000000000000000000000",
    "segmentId":"job-segment-uuid",
    "segmentOrdinal":0,
    "materialSourceId":"material-source:device:k2pro-69e7:cfs:1:slot:0",
    "protocolSourceAlias":"cfs:1:slot:0",
    "mountId":"mount-uuid",
    "managedSpoolId":"031",
    "rfidAtPrint":null,
    "usedLengthMm":3210,
    "usedMassG":9.55,
    "massBasis":"diameter-density-derived",
    "usageInterval":{"startedAt":"2026-09-15T04:10:00.000Z","endedAt":"2026-09-15T04:25:00.000Z"},
    "usageState":"observed-used",
    "confidence":"source-specific",
    "evidence":{"printPlanId":"print-plan-uuid","protocolToolAlias":"T1A","sourceBindingDigest":"sha256:source-binding","observationDigest":"sha256:observation"}
  }
}
```

- `usedLengthMm`は非負整数。単位はmm。
- `usedMassG`はnullまたは非負number。機器観測なら`device-reported`、径・密度から算出なら
  `diameter-density-derived`、不明ならnull。
- intervalの一方が不明ならそのfieldをnullにし、推測時刻を作らない。
- 1ジョブで1A=3210mm、1B=6543mm、1D=1234mmなら3eventに分ける。
- 同じsourceで途中交換した場合もmount/spoolごとにsegmentを分ける。

### Pending / Unattributed

source別に帰属できないtotal usageはspool usageへ変換せず、`material-usage.pending`として送れる。
`managedSpoolId`と`mountId`はnullで、`pendingReason`を必須にする。ItemKeeperは在庫減算しない。

pendingを後から解決した場合は元eventを書き換えず、次をappendする。

```json
{
  "eventType":"material-usage.pending-resolved",
  "payload": {
    "targetPendingEventId":"pending-usage-event-uuid",
    "targetPendingEventRevision":1,
    "replacementUsageEventIds":["usage-event-1","usage-event-2"],
    "resolution":"operator-attributed",
    "reason":"source-mount-confirmed"
  }
}
```

receiverは参照先usage eventsをすべて受理するまでpendingをmaterialize済みにしない。

### Correction / Void

```json
{
  "eventType":"material-usage.corrected",
  "payload":{"targetEventId":"usage-event-uuid","targetEventRevision":1,"consumptionIdentity":"consumption_01J00000000000000000000000","replacementUsedLengthMm":3180,"replacementUsedMassG":9.46,"reason":"operator-correction"}
}
```

`material-usage.voided`はtarget event/revision、consumptionIdentity、reasonを持つ。receiverは最新の有効な
correction chainをmaterializeし、元eventを物理削除しない。

## 14. Job Result-Set Coverage

未使用sourceを0mm usage eventとして送らない。job完了時にmodule-owned completeness evidenceがある場合だけ
別streamへ結果集合を記録する。

```json
{
  "eventId":"job-result-event-uuid",
  "eventType":"job.material-usage.closed",
  "eventRevision":1,
  "occurredAt":"2026-09-15T04:31:00.000Z",
  "payloadDigest":"sha256:job-result",
  "stream":{"name":"jobResultEvents","sequence":44,"previousDigest":"sha256:prev","digest":"sha256:current"},
  "payload": {
    "deviceId":"device:k2pro-69e7",
    "jobId":"1780000000",
    "runId":"run_01J00000000000000000000000",
    "usageEventIds":["usage-event-1","usage-event-2"],
    "confirmedUnusedMaterialSourceIds":["material-source:device:k2pro-69e7:cfs:1:slot:2"],
    "completenessEvidenceDigest":"sha256:result-set-evidence"
  }
}
```

証明できないsourceは`confirmedUnusedMaterialSourceIds`へ入れず、record無しのままにする。

## 15. Attribution Rules

- source-specific usage + trusted print-start binding + mount continuityが揃うsegmentだけをspool usageにする。
- RFID無しでもoperator-confirmed OPEN mountとidentity continuityがあれば対象にできる。
- provisional sourceは同一session内のsource-specific usage、operator-confirmed mount、identity continuityが
  証明できる場合だけ自動debit候補にする。
- provisional sourceがrestart/reconnectを跨いだ場合はoperator再確認までpending。
- total-only multi-source usageを推測分配しない。
- physical load/unloadとそのpurgeはprint job usageへ自動計上しない。
- `deviceId`を全eventで使用し、printerId/hostname/IP aliasをauthority fieldに混在させない。

## 16. Per-Device Cutover

```json
{"deviceId":"device:k2pro-69e7","jobMode":"v2-shadow","materialUsageMode":"v2-shadow","changedAt":"2026-09-15T05:00:00.000Z"}
```

- `v1`: v1だけをauthoritativeにmaterializeする。
- `v2-shadow`: v1をauthoritativeに維持し、v2を受理・比較するが在庫へ反映しない。
- `v2-authoritative`: v2 usageだけを在庫へ反映し、同じrun/consumptionのv1 materializationを抑止する。
- cutoverはdevice単位、jobとmaterial usage単位に持つ。global booleanにしない。
- active run中のmode変更は禁止し、次runから適用する。
- rollbackは新eventのmaterializationを止めるが、過去のv2 eventを削除しない。

## 17. Security And Privacy

- 低権限Bearer credentialとHTTPSを必須にする。
- secret、Bearer、生RFIDを通常ログへ出さない。
- canonical digestはUTF-8、object key辞書順、array順維持、数値有限、Unicode NFCのJSONで計算する。
- 3DPmon relay childは送信せず、parentまたはstandaloneだけをproducerにする。

## 18. Compatibility And Delivery Gates

現行v1 `jobs[].filaments[]`は複数spoolを表現できるが、v2 durable outbox、receiver、record ack、
RFID正式projection、cross-repository fixtureは未実装である。v2-authoritativeへ切り替わるまではv1を維持する。

1. **IKV2-0 Contract Freeze**: ik2とexact JSON、error code、canonicalizationを合意する。
2. **IKV2-1 Pure Projection**: snapshot/event builder、validation、canonical fixturesを3DPmonへ実装する。
3. **IKV2-2 Durable Sync**: sequence store、outbox、Offer/Need/Push、restart retryを実装する。
4. **IKV2-3 Receiver**: ik2へ`/api/v2/`、mapping、materialization、record ackを実装する。
5. **IKV2-4 Cross-Repo Certification**: 同一fixtureを両repoで検証し`v2-shadow`を開始する。
6. **IKV2-5 Activation**: device単位で`v2-authoritative`へ切り替える。

## 19. Required Cross-Repository Fixtures

- K1/K1 Max single external sourceが従来と同じ1 spool usageになる。
- K2/CFSの1Aと1Bを1jobで使い、別`managedSpoolId`と別使用量になる。
- 1A=3210mm、1B=6543mm、1D=1234mm、1C未使用をusage events + result-set coverageで再現する。
- RFID有りspoolでmanaged IDとRFID provenanceが別fieldになる。
- RFID無しGeneric filamentもoperator mountでsource別usageになる。
- 印刷途中交換がclose/open + two usage segmentsになる。
- restart/reconnectを跨いだprovisional sourceが再確認までpendingになる。
- correction/void、duplicate request/event、sequence gap、same ID/different payloadが二重計上されない。
- v1、v2-shadow、v2-authoritativeの各device cutoverで二重materializationしない。

## 20. Initial Error Codes

| Code | Meaning |
| --- | --- |
| `unsupported-contract-version` | contract major/minorを処理できない |
| `request-id-digest-conflict` | 同一requestIdで異なるbody digest |
| `plan-expired` | plan有効期限切れ |
| `need-not-offered` | Offerに無いresource/revision要求 |
| `need-limit-exceeded` | 件数またはrange上限超過 |
| `sequence-gap` | stream sequence欠番 |
| `event-payload-conflict` | 同一event revisionで異なるpayload |
| `record-payload-conflict` | 同一snapshot record revisionで異なるpayload |
| `device-mapping-required` | ItemKeeper device対応付け待ち |
| `spool-mapping-required` | managed spool対応付け待ち |
| `usage-not-authoritative` | shadow/pending等で在庫反映不可 |
| `unavailable-record` | 要求されたrecordをproducerが提供不能 |

未知error codeは破棄せず保存・表示し、既知statusへ推測変換しない。
