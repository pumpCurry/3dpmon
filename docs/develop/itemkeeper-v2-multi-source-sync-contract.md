# 3DPmon / ItemKeeper v2 Multi-Source Sync Contract

Last updated: 2026-09-15

Status: 3DPmon producer-side design baseline. ItemKeeper (ik2) receiver implementation and
cross-repository contract test are pending.

この文書は、CFS/CFS-Cなど複数フィラメント供給源を持つプリンタについて、3DPmonが保持する
MaterialSource、SpoolMount、source別使用量、交換履歴をItemKeeperへ同期するv2契約を定義する。
既存の印刷履歴snapshot APIはv1として維持し、v2は能力交換と差分同期を追加する。

## Goals

- 1 device = 1 spoolを前提にせず、1ジョブ内の複数MaterialSourceと複数spool使用量を伝える。
- 3DPmon管理スプールID、機器RFID、物理source、protocol上のslot aliasを混同しない。
- CFS slotの交換前・交換後、装着・解除、同一source内での複数segmentを履歴として保持する。
- ItemKeeperが受理、spool対応付け、在庫反映の各段階を別statusとして返せるようにする。
- retry、restart、順序入替、同一payload再送で二重計上しない。
- 物理CFS load/unloadと在庫管理上のmount/debitを分離する。

## Non-Goals

- CFSのload/unload/select commandをItemKeeper同期から実行しない。
- RFID reported remainingで3DPmon管理残量を自動上書きしない。
- source別使用量が観測できないmulti-source jobを推測配分しない。
- ItemKeeper側のspool対応付け成功を、3DPmonのSpoolMount authorityへ逆流させない。

## Versioned Endpoints

v2の標準endpointは次のとおりとする。

```text
GET  /api/v2/integrations/3dpmon/capabilities
POST /api/v2/integrations/3dpmon/sync/plan
POST /api/v2/integrations/3dpmon/sync/push
```

既存の印刷履歴snapshot endpointはv1契約として扱う。

```text
POST /api/v1/ingest/print-events
POST /api/ingest/print-events       # deprecated compatibility alias
```

- 新規clientはversionを明示したURLだけを保存する。
- unversioned endpointはv1 aliasであり、v2へ自動的に意味を切り替えない。
- `/current/` aliasは初期v2では導入しない。clientが知らないcontractへ自動移行する事故を避ける。
- unversioned endpointの終了日時はItemKeeper側のcapabilityと運用告知で通知し、3DPmon UIでも警告する。

## Protocol Identity

契約名とversionはHTTP pathだけでなくpayloadにも含める。

```json
{
  "contract": "3dpmon-itemkeeper-v2",
  "contractVersion": "2.0.0",
  "producerInstanceId": "3dpmon-instance-uuid",
  "producerStateEpochId": "storage-epoch-uuid"
}
```

- `producerInstanceId` は同じ3DPmon installationを識別し、通常restartでは変えない。
- `producerStateEpochId` はstorage初期化、権威データの全置換など、revision連続性が失われた時だけ更新する。
- ItemKeeperは `(clientId, producerInstanceId, producerStateEpochId)` を同期scopeとする。

## Offer / Need / Push

v2は全履歴を毎回無条件送信せず、Offer -> Need -> Pushで同期する。

1. `capabilities` で双方のcontract version、圧縮、最大件数、対応streamを確認する。
2. 3DPmonは `sync/plan` へ各streamの最新revision、件数、canonical digestをOfferする。
3. ItemKeeperは必要なrevision範囲と既知digestをNeedとして返す。
4. 3DPmonは要求されたrecordだけを `sync/push` へ送る。
5. ItemKeeperはrecord単位でaccepted、mapped、materializedを返す。

初期streamは次の3つとする。

| Stream | 内容 | Append-only |
| --- | --- | --- |
| `materialSources` | device-scoped MaterialSource identityとprotocol alias履歴 | revisioned snapshot |
| `spoolMountEvents` | mount open/closeとreplace operation | yes |
| `jobMaterialUsageEvents` | job/source/spool/segment別の使用量 | yes |

## Identifier Separation

| Field | Authority | Meaning |
| --- | --- | --- |
| `deviceId` | 3DPmon Printer Core | 安定したプリンタidentity |
| `materialSourceId` | 3DPmon Printer Core | device-scoped canonical供給源ID |
| `protocolSourceAlias` | Printer observation | 例 `cfs:1:slot:0`。transport-local locatorでありcanonical IDではない |
| `mountId` | 3DPmon SpoolMount store | spoolをsourceへ割り当てた1 interval |
| `managedSpoolId` | 3DPmon spool ledger | 3DPmon内で管理するフィラメント1巻のID |
| `rfidUid` | Printer/RFID observation | 機器から観測したRFID。未搭載・未観測ならnull |
| `rfidDigest` | 3DPmon projection | RFID比較用のnamespace付きdigest。生値を表示しない用途 |
| `jobId` | 3DPmon print history | device scope内の印刷job ID |
| `segmentId` | 3DPmon accounting | source/spool使用区間の不変ID |

`managedSpoolId`と`rfidUid`は別identityである。RFIDが同じでもoperator-managed spoolが未割当なら
自動で同一spoolと断定しない。逆にRFID無しのGeneric filamentでも、operatorがmountした
`managedSpoolId`とsource-specific usageが揃えば3DPmon残量管理と同期候補にできる。

## Material Source Record

```json
{
  "deviceId": "device:k2pro-69e7",
  "materialSourceId": "material-source:device:k2pro-69e7:cfs:1:slot:0",
  "protocolSourceAlias": "cfs:1:slot:0",
  "displayLabel": "1A",
  "kind": "cfs-slot",
  "locator": { "unitId": "cfs:1", "boxId": 1, "slotId": 0 },
  "identity": {
    "rfidUid": null,
    "rfidDigest": null,
    "materialType": "PLA",
    "color": { "raw": "#09ea7ae", "displayHex": "9ea7ae" }
  },
  "observedAt": "2026-09-15T04:00:00.000Z",
  "observationState": "fresh"
}
```

観測値はcurrent device stateであり、SpoolMountやledger remainingのauthorityではない。

## Spool Mount Event

```json
{
  "eventId": "mount-event-uuid",
  "revision": 142,
  "operationId": "operator-operation-uuid",
  "eventKind": "mount.opened",
  "occurredAt": "2026-09-15T04:01:00.000Z",
  "deviceId": "device:k2pro-69e7",
  "materialSourceId": "material-source:device:k2pro-69e7:cfs:1:slot:0",
  "protocolSourceAliasAtEvent": "cfs:1:slot:0",
  "mountId": "mount-uuid",
  "managedSpoolId": "031",
  "rfidUidAtEvent": null,
  "rfidDigestAtEvent": null,
  "sourceIdentityDigestAtEvent": "sha256:...",
  "reason": "operator-confirmed"
}
```

- `mount.opened`と`mount.closed`をappend-only eventとして送る。
- 交換は単一recordへ潰さず、旧mountの`mount.closed`と新mountの`mount.opened`を同じ
  `operationId`で送る。
- reconnect、stale、slot selected変更、物理load/unloadだけではmountを自動closeしない。
- sourceからスプールを外した操作は`mount.closed`として残り、過去jobのmount参照を消さない。

## Job Material Usage Event

```json
{
  "eventId": "usage-event-uuid",
  "revision": 981,
  "jobId": "1780000000",
  "deviceId": "device:k2pro-69e7",
  "segmentId": "job-segment-uuid",
  "segmentOrdinal": 0,
  "materialSourceId": "material-source:device:k2pro-69e7:cfs:1:slot:0",
  "protocolSourceAlias": "cfs:1:slot:0",
  "mountId": "mount-uuid",
  "managedSpoolId": "031",
  "rfidUidAtPrint": null,
  "rfidDigestAtPrint": null,
  "usedLengthMm": 3210,
  "usageState": "observed-used",
  "confidence": "source-specific",
  "evidence": {
    "printPlanId": "print-plan-uuid",
    "protocolToolAlias": "T1A",
    "sourceBindingDigest": "sha256:...",
    "observationDigest": "sha256:..."
  }
}
```

1ジョブで複数sourceを使った場合はsegmentを分ける。例えばT1A=1Aで3210mm、T1B=1Bで
6543mm、T1C=1Dで1234mmなら3件を送る。未使用の1Cは、使用していないことを明示的に
証明できた場合だけ`usageState:"confirmed-unused"`かつ`usedLengthMm:0`で送る。

同じsourceで印刷途中にspoolを交換した場合も、交換前後で`mountId`と`managedSpoolId`を分け、
`segmentOrdinal`を増やす。slot名が同じという理由で使用量を一つのspoolへ合算しない。

## Attribution Rules

- source-specific usage + print-start binding + mount continuityが揃うsegmentだけをspool usageとして送る。
- RFID無しでもoperator-confirmed OPEN mountとidentity continuityがあれば候補にできる。
- provisional sourceは同一session内でsource-specific usage、operator-confirmed mount、identity continuityが
  証明できる場合だけ自動debit候補とする。
- provisional sourceがrestart/reconnectを跨いだ場合は、operator再確認までpendingとする。
- multi-source jobでtotal usageしか無い場合は`unattributed`として隔離し、色・材料名・残量比で分配しない。
- physical load/unloadはjob usageではない。purge量を印刷jobのspool消費へ自動計上しない。

## Idempotency And Ordering

- 各append-only recordは不変`eventId`と単調増加`revision`を持つ。
- requestは`requestId`、`requestBodyDigest`、`fromRevision`、`toRevision`を持つ。
- 同じ`requestId`で異なるdigestを受けた場合は409として拒否する。
- 同じ`eventId`で異なるpayloadを受けた場合はfirst-winせずintegrity conflictとして隔離する。
- record canonical digestはkey順を固定したJSONから計算する。
- 欠番を受けたItemKeeperはmaterializeせず、Need responseで不足revisionを要求する。

## Receiver Result States

ItemKeeperの応答は次の段階を分離する。

| State | Meaning |
| --- | --- |
| `accepted` | schema、認証、digest、revisionを受理した |
| `mapped` | device/source/spoolをItemKeeper内identityへ対応付けた |
| `materialized` | 在庫・使用履歴へ反映した |
| `pending-mapping` | 受理したがspool等の対応付け待ち |
| `quarantined` | identity/digest/sequence conflictで隔離した |

HTTP 2xxはbatch受理のみを意味し、すべてのrecordが`materialized`になったことを意味しない。
3DPmonはrecord単位resultを保存し、未materialized recordをUIとexportで確認可能にする。

## Security And Privacy

- v1同様、ItemKeeperが発行する低権限Bearer credentialを必須とする。
- capability/plan/pushのすべてをHTTPSで送る。
- `rfidUid`送信は設定で無効化できるようにし、無効時も`rfidDigest`でcontinuityを比較できるようにする。
- secret、Bearer header、生RFIDは通常ログへ出さない。
- 3DPmon relay childは送信せず、parentまたはstandaloneだけをproducerとする。

## Compatibility With Current 3DPmon

現行`dashboard_integration_itemkeeper.js`のv1 snapshotは`jobs[].filaments[]`で複数spoolを
表現できる。Gate 18.9の`JobMaterialSegment`が認証済みの場合は、`materialSourceId`、`mountId`、
`protocolToolAlias`をadditive fieldとして投影する入口もある。ただし次は未実装である。

- v2 capability/plan/push client。
- MaterialSource、SpoolMount event、usage eventのdurable outbox。
- ItemKeeper側のv2 receiverとrecord単位ack。
- RFID UID/digestの正式projection。
- cross-repository canonical fixtureとcontract test。
- source-aware production projection registryの実機fixture登録。

v2実装中もv1 snapshot送信を維持する。v2が有効な接続先では、同じusageをv1とv2の双方で
在庫計上しないよう、ItemKeeper側capabilityで`v2MaterialUsageAuthoritative:true`を返し、v1側の
`filaments[]`は表示互換データとして扱う。

## Delivery Gates

1. **IK2-V2 Contract**: 本文をik2側設計へ反映し、canonical fixturesとerror codeを合意する。
2. **3DPmon V2 Projection**: source/mount/usage stream builderとpure validationを実装する。
3. **Durable Sync**: revision store、outbox、Offer/Need/Push、restart retryを実装する。
4. **IK2 Receiver**: `/api/v2/` endpoint、mapping、materialization、record ackを実装する。
5. **Cross-Repo Certification**: K1単一spool、K2/CFS複数spool、途中交換、RFID有無、
   unattributed、retry/restartを同じfixturesで検証する。
6. **Activation**: source-aware projection registryをreview済みfixtureで開き、段階的にv2を有効化する。

## Required Cross-Repository Scenarios

- K1/K1 Maxのsingle external sourceが従来と同じ1 spool usageになる。
- K2/CFSの1Aと1Bを1ジョブで使い、それぞれ別`managedSpoolId`と使用量になる。
- RFID有りspoolで`managedSpoolId`と`rfidUid`が別fieldとして保存される。
- RFID無しGeneric filamentでもoperator mountに基づきsource別使用量を送れる。
- 印刷途中の交換がclose/open + two usage segmentsとして再現される。
- 使用しなかったsourceを推測消費せず、confirmed-unusedまたはrecord無しにする。
- restart/reconnectを跨いだprovisional sourceが再確認までpendingになる。
- duplicate request/event、revision gap、same ID/different payloadが二重計上されず隔離される。
