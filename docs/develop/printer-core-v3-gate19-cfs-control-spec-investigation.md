# Printer Core v3 Gate 19 CFS Control Spec Investigation

Last updated: 2026-09-15

このメモは、K2/CFSを3DPmon UIから操作できる版に向けて、公開ソース、既存3DPmon実装、実機captureで確認済みの事実、未確定の仕様境界を整理する。ここでの目的は、CFS操作を急いで有効化することではなく、どの操作をどの証跡でproduction authorityへ昇格できるかを固定すること。

## Current 3DPmon Boundary

現行3DPmonは、K2/CFSの印刷開始についてだけ、次の順序付きWS9999 frameを本番transport候補として実装済み。

```json
{"method":"set","params":{"colorMatch":{"path":"<gcode-path>","list":[...]}}}
{"method":"set","params":{"multiColorPrint":{"gcode":"<gcode-path>","enableSelfTest":0}}}
```

単独のCFS操作は、F012 + CFS 1台の1A/1Bに対するload/unloadだけを限定的なproduction候補へ昇格した。

```text
cfs-slot-select
cfs-load
cfs-unload
cfs-feed
cfs-retract
```

`cfs-load` / `cfs-unload` はmodule-owned registryの認証scopeと一致する場合だけproduction planを生成する。
それ以外のcommand/source/model/firmwareは `dashboard_k2_cfs_command_transport.js` で拒否する。
通常フィラメントパネルには操作候補hookとcommand request scaffoldがあるが、Gate 19.5の明示activation UIと設定永続化が未実装のため、既定read-onlyを維持する。

## Public Source Evidence

### OrcaSlicer

調査対象:

```text
tmp/external-repos/OrcaSlicer
HEAD 5552ed6cf1383a58321b2196317fe0c69a78b1a6
```

主な確認箇所:

```text
src/slic3r/Utils/CrealityPrint.cpp
src/slic3r/Utils/CrealityPrintAgent.cpp
src/slic3r/GUI/PrintHostDialogs.cpp
```

確認できたこと:

- `query_boxes_info()` はWS9999へ `{"method":"get","params":{"boxsInfo":1}}` を送る。
- 送信ダイアログは `boxsInfo.materialBoxs[]` から外部スプールとCFS slotを読み、G-code側材料 `T1A`, `T1B` などを `boxId/materialId` へ割り当てる。
- CFSを使う印刷開始は `set colorMatch` の後に `set multiColorPrint` を送る。
- 外部スプールを使う場合は `opGcodeFile:"printprt:<path>"` へ分岐する。
- `T1A` はCFS物理slot名ではなく、G-code/スライサ側の材料ID。物理slotは `boxId/materialId` で指定される。

OrcaSlicer側では、単独のslot select/load/unload/feed/retractのLAN送信実装は印刷開始経路からは確認できなかった。したがって、単独操作はOrcaSlicerのprint-start evidenceだけではcertifyしない。

### CrealityPrint

調査対象:

```text
tmp/external-repos/CrealityPrint
HEAD 24b9395c131a9849724c5bf098cba140a207e877
```

確認できたLAN/Device UI側候補:

```json
{"method":"set","params":{"feedInOrOut":{"boxId":1,"materialId":0,"isFeed":1}}}
{"method":"set","params":{"feedInOrOut":{"boxId":1,"materialId":0,"isFeed":0}}}
{"method":"set","params":{"modifyMaterial":{"boxId":1,"id":0,"rfid":"","type":"PLA","vendor":"Generic","name":"Generic PLA","color":"#0RRGGBB","minTemp":190.00000001,"maxTemp":240.00000001,"pressure":0.04}}}
{"method":"set","params":{"refreshBox":{"boxId":1,"materialId":0}}}
{"method":"set","params":{"boxConfig":{"autoRefill":1,"cAutoFeed":1,"cSelfTest":1}}}
```

確認できたCloud twoway候補:

```json
{"method":"set","params":{"feedStateTemp2":0,"feed":1,"cId":"<cloud-cfs-port-id>"}}
{"method":"set","params":{"cId":"<cloud-cfs-port-id>","filamentsColor":"#FFRRGGBB","filamentType":"PLA","nozzleTempMin":190,"nozzleTempMax":240,"cPressureAdvance":0.04,"cBrandName":"Generic","name":"Generic PLA"}}
{"method":"get","params":{"cfsInfo":1}}
{"method":"set","params":{"cAutoFeed":1}}
{"method":"set","params":{"cSelfTest":1}}
{"method":"set","params":{"autoRefill":1}}
```

この2経路は混ぜない。3DPmonのローカルK2操作候補はWS9999の `feedInOrOut` / `modifyMaterial` / `boxConfig` / `refreshBox` を優先して検証し、Cloud APIの `feedStateTemp2/feed/cId` はK2 LAN control authorityの根拠にしない。

### Reverse-engineered Reference

`DaviBe92/k2-websocket-re` も `feedInOrOut`, `modifyMaterial`, `boxConfig`, `colorMatch`, `multiColorPrint` をK2 WS9999 commandとして記載している。ただし公式ソースではなく、検証firmwareも限定されるため、設計上は補助証拠に留める。実装のproduction enable条件には、3DPmon自身のF012実機captureを必須とする。

## Operation Mapping Hypothesis

| UI operation | Candidate K2 WS9999 command | Production status |
| --- | --- | --- |
| CFS load / 押出し | `feedInOrOut.isFeed = 1` | F012 + CFS 1台の1A/1Bでlive certified。module-owned registryへ登録済みで、厳密なscope一致と接続先別opt-in時だけ通常UIからproduction planを生成できる |
| CFS unload / 引戻し | `feedInOrOut.isFeed = 0` | F012 + CFS 1台の1A/1Bでlive certified。module-owned registryへ登録済みで、厳密なscope一致と接続先別opt-in時だけ通常UIからproduction planを生成できる |
| 独立したslot select / feed / retract | 未確定 | `cfs-slot-select` / `cfs-feed` / `cfs-retract` は別command kindとして未certifiedのためdisabled |
| Material metadata edit | `modifyMaterial` | 未certified。RFID材料とGeneric材料で可否差があるためread-onlyから開始 |
| RFID refresh | `refreshBox` | 未certified。副作用が小さいが物理状態変化を伴うためUI開放は別判断 |
| CFS settings | `boxConfig` | 未certified。autoRefill/cAutoFeed/cSelfTest/ignoreColorAutoFeedの対象firmware差を確認する |
| CFS print start | `colorMatch` -> `multiColorPrint` | transport実装済み。live certificationが完了するまでauthority昇格は保留 |

## Gate 19 Design Direction

Gate 19は、いきなりUIの操作ボタンを有効化しない。次の順で進める。

1. `feedInOrOut` / `modifyMaterial` / `boxConfig` / `refreshBox` をtransport candidateとして型定義し、デフォルトはdry-run onlyにする。
2. certification CLIを追加し、`--dry-run` では送信frame、expected observation、disable reasonを出す。
3. live送信には `--send --confirm-live --confirm-host <host>` と、操作種別ごとの追加confirmationを必須にする。
4. 送信前にactive session、fresh topology、対象sourceがCFS sourceであること、loaded状態、プリンタがprintingでないことを再検証する。
5. 送信後はphysical transportを再送せず、同一session/generationのread-only stateだけを既定120秒のbounded windowで観測する。
6. loadは対象sourceが一意にselected、unloadはselected sourceなしとなり、feed/errorもterminal safeである場合だけconfirmedにする。timeout、session/generation変化、device errorは成功扱いにせず、未解決recovery latchを保持する。
7. UIはGate 19.5までdisabledのままにし、Gate 19のlive evidenceが揃った操作だけを段階的に有効化する。

## Branch Implementation Cut

`codex/printer-core-v3-gate19-k2-terminal-idle` では、最初の実装cutとして次だけを許可する。

- 通常の `createK2CfsCommandTransportPlan(request)` は、従来どおり `cfs-slot-select` / `cfs-load` / `cfs-unload` / `cfs-feed` / `cfs-retract` を `uncertified-cfs-slot-command` で拒否する。
- Gate 19 certification用に `allowUncertifiedCfsSlotCommandCandidates:true` を明示した場合だけ、`feedInOrOut` のcandidate planを生成する。
- candidate planには `certificationOnly:true` と `requiresLiveConfirmation:true` を付け、`productionEnabled:false` をdetailsへ残す。
- `sendK2CfsCommandTransportPlan()` は、candidate planを `allowCertificationOnly:true` なしでは送信しない。
- 実機certification後のproduction昇格でも、通常callerが証跡objectを渡して暗黙に通すことはできない。
  保存設定は `certificationId` と明示的な `allowedActions` だけを参照し、完全な証跡、最大command capability、
  command別precondition/terminal policyは `dashboard_k2_cfs_command_transport.js` 内のmodule-owned immutable registryが所有する。
  未登録ID、証跡objectだけのlegacy設定、未許可actionはproduction settingsへ昇格しない。
- registry entryのproduction証跡には最低限、
  `schemaVersion:1`、`status:"certified"`、対象 `commandKinds`、`transportProfile`、`printerType:"creality-k2"`、
  `model`、`firmwareVersion`、`fixtureId`、`captureId`、`certifiedAt` を要求する。
  現在target/runtimeで `printerType/model/firmware` を観測し、証跡scopeと一致する場合だけ有効化する。
  model/firmwareが未観測のtargetへ、F012実機で得た証跡を流用してはならない。
- registryは匿名化fixtureのraw SHA-256とcanonical JSON SHA-256に加え、command/model/firmware/attachment/
  transport/scope/command policy/safetyだけを抽出したruntime policyのcanonical SHA-256を保持する。
  certification ID重複は初期化時に拒否し、同じIDの意味変更はfixture/policy digest testで検出する。
- UI composition層は、明示された `allowedActions` とregistry認証commandの積集合だけをproduction候補にする。
  `allowedActions` が無い場合は0 actionであり、caller supplied `certifiedCfsSlotControlCommands`、
  `certificationEvidence`、legacy aliasの `commandKinds` / `certifiedCommandKinds` は権限を増やせない。
- K2用 `feedInOrOut` production profileは `printerType:"creality-k2"` のtargetに限定する。
  K1C/CFS-Cは後続Gateで別profileとしてcertificationする。
- sourceはregistry entryで認証した `cfs:<boxId>:slot:<slotId>` だけを受け付け、外部スプールやcaller supplied
  `boxId/materialId` は採用しない。初期entryはF012、firmware `1.0.0`、CFS 1台、1A/1B、
  `cfs-load` / `cfs-unload` だけを対象とし、1C、物理除外した1D、external、複数CFS、別firmwareへ流用しない。
- transport生成直前には設定上の台数だけでなく、freshな実トポロジーがCFS 1台、box ID集合 `{1}`、
  box 1のslot ID集合 `{0,1,2,3}` であることを要求する。2台目CFS、欠落slot、別boxを観測した場合は、
  保存設定が1台のままでも送信しない。
- send-time context生成時とtransport plan生成直前の両方で、現在targetのcertification設定を再検証する。
  設定が削除・無効化・scope不一致になっていれば、UI初期化時に有効だったbuttonからでも送信しない。
- `sendK2CfsCommandTransportPlan()` は `createK2CfsCommandTransportPlan()` が生成したplanだけを受け付ける。
  callerがplain objectで `ok:true` / `certificationOnly:false` を偽装しても、send hookへは到達しない。
  生成済みplanはdeep freezeされるため、factory通過後にframeやdetailsを書き換えることもできない。
- CFS physical commandは印刷中、pause中、heating/checking/busy/running状態では送信しない。
  `print.stateLabel` だけでなく、K2 firmware差異で `device.stateLabel` / `status.stateLabel` に出る状態も確認する。
  また送信直前に対象sourceが `presence:"loaded"` または明示的な `status.stateCode` でloadedと確認できなければ
  送信しない。材料名・色・RFIDなどの残留metadataだけではloadedとは扱わない。
  CFSのmaterial path共有を前提に、実機で並列安全性が証明されるまでは1 printerにつき1 commandだけを許可する。
- 送信後のterminal成功には、status sequenceだけでなく送信後に更新された`boxsInfo` sequenceを要求する。
  対象sourceが同じbox/slotに存続し明示loadedであること、fresh topology、feed停止、error clearが同一の
  post-send観測窓で揃わない場合は成功にしない。確認はrequest開始から120秒の絶対deadline内に限定する。
- terminal成功で復旧ラッチを解決する場合も、解決済みstoreをIndexedDBへdurable保存できた時だけruntimeへ確定する。
  保存がfailure resultまたは例外になった時は元の未解決storeへ戻し、次の物理操作をfail-closedに保つ。
- `scripts/capture_k2_cfs_slot_control.mjs` は同じcandidate planをCLIでdry-run確認する。live送信には
  `--send --confirm-live --confirm-host <host> --confirm-command <command> --confirm-source <source>` を必須にする。
- 初期live certificationの送信対象は `cfs-load` / `cfs-unload` だけに限定する。
  `cfs-slot-select` / `cfs-feed` / `cfs-retract` はshape確認用dry-run候補に留め、追加capture根拠なしには送信しない。
- 同CLIは `--send` 時に `--probe-before` / `--probe-after` を必須とし、同じWS9999 sessionでread-only
  `get { boxsInfo: 1 }` を送る。これはCLI引数だけでなく `runK2CfsSlotControlCertification()` 本体でも
  再検証する。これは操作frame前後の観測差分を残すための補助であり、command成功の証明やblind retryには使わない。
- 送信前probeでは、対象sourceがexactly one、duplicate box/source locator診断なし、明示loaded、
  かつ対象sourceだけがselectedであることを要求する。
  duplicateが見つかった場合はfirst-winせず、該当locator全体をcertification候補から外してCFS操作frameを送らない。
- live送信では `--probe-info --require-info-model F012` を必須とし、WS9999接続前に
  `http://<host>/info` のmodel/version/transport hintをcertification resultへ保存する。
  `/info` のMACは有線/無線で一致しないことがあるためidentity authorityにはしないが、F012実機へ送っている証跡として扱う。
- live送信では `--require-printer-idle` を必須とし、WS9999のread-only `get` で `state` / `deviceState` /
  `printJobTime` / `printLeftTime` / target温度を確認する。F012実機では印刷完了後も `state:2` と
  `printJobTime` が残るため、`printJobTime` は診断値として保持するが、それ単独ではbusy根拠にしない。
  `state:0`（待機）または `state:2`（完了）かつ `deviceState:0`、`printLeftTime:0`、
  `targetNozzleTemp:0`、`targetBedTemp0:0` が同じ完全/合成観測で揃った場合だけphysical idle候補とする。
  `state:2` で観測済み `printProgress` が100以外の場合や、残り時間・目標温度・device stateが活動を示す場合は、
  `pre-command-printer-not-idle` としてCFS操作frameを送らない。
  `null`、空文字、空白文字、未観測値はJavaScriptの暗黙変換で0にせず、idle根拠としては扱わない。
  この判定は `dashboard_k2_printer_activity.js` に集約し、Normalizer、live shadow、Certification panel、
  read-only calibration CLI、slot-control CLIで同じ分類結果を使う。
  UI/dispatcher側でも同じ境界を持ち、`stateLabel:"idle"` が残っていても、send-time観測が
  `snapshotCompleteness:"partial"`、`statusProbeStatus:"partial"`、`activityState:"unknown-core-state"`、
  `coreStateComplete:false`、または `physicalIdleEvidenceComplete:false` を明示する場合は
  `cfs-control-printer-idle-observation-incomplete` として拒否する。
  これはdelta-only/timeout後に古いidle表示だけでphysical CFS commandを送らないためのGate19 idle predicateである。
  `createK2StatusPatch()` はraw frame単位でこのmetadataを生成し、Facadeの累積 `shadowRecord.lastState.print` へ残す。
  そのためCertification panelの合成入力だけでなく、実機WS9999から入ったproduction shadowでも同じpreflight境界を使える。
- production dispatcherは、送信時に `printerIdleObservation` を内部生成し、command authorityへ渡す。
  この観測は現在の `runtimeData.printerCoreV3Shadow` recordから生成し、`sessionId` と
  `connectionGeneration` が現在接続と一致しなければ `cfs-control-printer-idle-session-mismatch` /
  `cfs-control-printer-idle-generation-mismatch` で拒否する。観測TTLは5秒で、期限切れまたは
  `fresh:false` は `cfs-control-printer-idle-observation-stale` として扱う。
  `boxsInfo` のようなmaterial-only frameはprinter status scalarを含まないため、このTTLを延長しない。
  complete baseline後に同一session/generation内で届いたdelta-only printer status frameは、baseline sequenceと
  last applied sequenceを保持した `status:"assembled"` evidenceとして扱える。これによりF012で観測された
  「full statusは初回だけ、その後は差分だけ」という通信でも、古いidle表示だけを根拠にせず、freshな
  assembled idle観測がある場合だけsend-time guardを通せる。
  合成時は観測済みscalarをraw key単位で累積して毎回shared classifierへ戻す。後着deltaが
  `printProgress:75`、active state、加熱target、負のsentinel、または明示的なnull/空白を含む場合は、
  以前のsafe scalarを保持せずphysical idleを失効させる。
- `scripts/capture_k2_cfs_readonly_calibration.mjs` は、複数のprinter status probeから
  `assembledPrinterStatus` を生成する。これはread-only certification用のprojectionであり、
  最初に `state` と `deviceState` を含むcomplete baselineを観測できた場合だけ、同一WS session内の
  後続delta scalarを順序通り累積する。complete baselineなしのdelta-only応答は
  `status:"unknown" / reason:"complete-baseline-missing"` として保存し、idle authorityへ昇格しない。
  projectionには `baselineProbeMode`、`lastAppliedProbeMode`、`appliedDeltaProbeCount`、`ttlMs`、
  `fresh`、累積後の `snapshot` を含め、F012で観測されるfull baseline後のdelta-only通信を
  physical send前にレビューできる形へ残す。観測済みnull/invalid scalar、TTL切れ、観測時刻の逆行は
  fail-closedに扱う。
- `--probe-after` はcommand送信callback直後ではなく、既定 `--probe-after-delay-ms 1500` の反映待ち後に開始する。
  `--boxsinfo-timeout-ms` はprobe開始後の応答待ち時間、`--probe-after-delay-ms` は物理状態が反映されるまでのsettling timeとして分離する。
  実機でtimeoutより先に旧状態だけを拾う場合は、timeoutを延ばす前にこのsettling timeを長くして前後観測を取り直す。
- post-command観測は既定で `--probe-after-count 6` / `--probe-after-interval-ms 5000` のbounded polling
  windowを使う。この場合もCFS操作frameは1回だけで、追加されるのはread-only `boxsInfo` probeだけである。
  途中でtimeout/errorがあってもCFS操作frameは再送せず、残り回数のread-only probeを継続して証跡を残す。
- resultには `probeAttemptCount` / `observedProbeCount` / `failedProbeCount` と、before probeから最後に観測できた
  after probeへの `targetSourceDelta` を保存する。これはtelemetry差分のレビュー補助であり、expected-state confirmationではない。
  source summaryには `selected` に加えて `selectedObserved` / `selectionState` を含め、`selected:false` と
  `selected` field未観測を区別する。`colorMatch` はG-code材料IDからsourceへのassignment証跡であり、selected authorityの代替にはしない。
- 現場目視メモは `--operator-marker <text>` で `operatorMarker.source="operator-cli"` として保存できる。
  これは人間が何を見たかをJSONへ同梱するための欄であり、単独で物理成功を確定するauthorityにはしない。
- side-effect commandが `submitted` / `post-observed` / `unknown` で終わった場合に備え、`physicalCommandRecoveryLatch` を
  shared storageへ永続化する。このstoreは `commandId`、`commandKind`、`deviceId`、`sessionId`、送信時刻、
  certification ID、送信前観測digest/sequenceだけを保持し、command frameやRPC payloadは保存しない。
  再起動後も自動replayせず、fresh observationまたはoperator確認でのみ解決する。

このcutは通常UIの操作有効化ではない。F012実機captureは2026-09-09に完了し、匿名化fixtureのdigest、
対象source/action、物理除外範囲を固定したmodule-owned production registry entryを追加した。
ただし通常設定normalizerは `cfsControl` をまだ永続化せず、rendererも既定read-onlyのままである。
Gate 19.5で明示設定、操作状態表示、stale/timeout disable、operator向け復旧導線を接続するまで、
通常アプリからphysical commandを送ることはできない。

## Gate 19.5 UI Command State Contract

UIでCFS/CFS-C操作を表示する場合、実行状態はDOM要素ではなくrenderer handleの外側状態として保持する。
`handle.update()` でtopology panelを再描画しても、未完了commandのbusy/statusを失ってはならない。

状態は次の意味に分ける。

- `running`: dispatcherへ送信中。同一printerの全CFS physical commandをdisableする。
- `submitted`: transportは受理されたが、`completed:false`、`confirmation.confirmed:false`、
  または `postCommandObservation.confirmed:false` のため観測確認が未完了。同一printerの再操作を抑止する。
  `cfs-slot-select` のようにUI側でもselected sourceを確認できる操作だけ、送信前は未選択だった
  対象sourceが次のmaterial provider観測でselectedになった場合にmutexを解除する。`load/unload/feed/retract` は物理状態の
  expected-stateが未確定のため、観測時刻が進んだだけでは自動解除しない。
- `post-observed`: command frame送信後に指定されたpost-command read-only telemetryを観測できた状態。
  物理load/unload成功を意味しないため、成功表示やproduction certificationへ単独では使わない。
  UIとrecovery latchでは未解決状態として扱い、operator確認またはcommand-specific expected-state confirmationまで再操作を抑止する。
- `confirmed`: command-specific expected-state confirmationが成立した場合のみ。成功表示にして操作mutexを解除してよい。
- `rejected`: send-time validationなど送信前拒否。transport side-effectは起きていないためmutexを解除してよい。
- `unknown`: timeout、transport-error、confirmation-errorなど、物理side-effect有無が不明な状態。
  blind retryを避けるため、自動解除せず明示的な状態確認/再描画方針が入るまで再操作を許可しない。

最初のUI実装では、slot単位ではなくprinter単位mutexを採用する。
将来、別CFS unit間などの並列安全性を実機証跡で確認できた場合だけ、lock domainを狭める。

## Required Live Evidence

### Slot Control Certification Runbook

F012 K2 Pro Combo実機では、live操作前に必ず現在のread-only topologyを取得する。2026-08-27時点の観測では、
`192.168.54.153` は `/info.model = F012`、CFS box `id=1/type=0`、外部box `id=0/type=1` を返し、
slot `1A/1B/1C` が装填済み、`1A` がselected、`colorMatch` は `T1A -> boxId:1/materialId:0` だった。

live certificationは次の順で進める。

1. read-only calibrationで `/info`、printer status、`boxsInfo` を副作用なしで取得する。
   この段階では `set` frameを送らず、`sent:false` / `blindRetryAllowed:false` のJSON証跡だけを保存する。

   ```bash
   node scripts/capture_k2_cfs_readonly_calibration.mjs \
     --host 192.168.54.153 \
     --require-info-model F012 \
     --status-probe-count 5 \
     --status-probe-interval-ms 1000 \
     --boxsinfo-probe-count 2 \
     --boxsinfo-probe-interval-ms 1000 \
     --output-dir tmp/k2-cfs-readonly-calibration \
     --pretty
   ```

   2026-08-31のF012実機観測では、`/info` と `boxsInfo` は取得できた一方で、printer statusは
   1回目だけ即応答し、同一WS session内の連続status probeはtimeoutすることがあった。
   この場合CLI結果は `ok:false` / `status:"partial"` とし、`failedStatusProbeCount` を証跡に残す。
   初回のcomplete baseline後に温度などのpartial deltaだけが届いた場合も、個々のprobe品質を隠さないため
   CLI最上位は `partial` を維持する。一方、`assembledPrinterStatus` は同一session内の順序付き合成結果として
   `fresh:true` / `physicalIdleEvidenceComplete:true` / `idle:true` を示せる。この2つは別の証拠であり、
   個別probeの完全成功を合成結果で上書きしない。
   `wsTimeline` にはraw payloadではなく送受信方向、probe番号、frame種別、key一覧だけを保存し、
   timeout後の遅延応答やsubscription風の部分frameがどのprobe windowで届いたかを確認する。
   これはside-effect command失敗ではなく、live送信前のidle predicate調整対象として扱う。

2. dry-runで送信frameを確認する。

   ```bash
   node scripts/capture_k2_cfs_slot_control.mjs \
     --command cfs-load \
     --source cfs:1:slot:0 \
     --probe-before \
     --probe-after \
     --output-dir tmp/k2-cfs-slot-control-captures \
     --pretty
   ```

3. read-only `boxsInfo` を別途確認し、対象sourceが現在もfresh/loadedであることを確認する。

4. 最初のlive候補は、すでにselectedなsource（例: `cfs:1:slot:0`）だけに限定する。
   これは「別slotへ切り替える」前に、`feedInOrOut` がF012で受理されるか、前後probeが取れるかを確認する段階である。

   ```bash
   node scripts/capture_k2_cfs_slot_control.mjs \
     --host 192.168.54.153 \
     --command cfs-load \
     --source cfs:1:slot:0 \
     --send \
     --confirm-live \
     --confirm-host 192.168.54.153 \
     --confirm-command cfs-load \
     --confirm-source cfs:1:slot:0 \
     --probe-before \
     --probe-after \
     --probe-info \
     --require-info-model F012 \
     --require-printer-idle \
     --operator-marker "preflight: operator present / printer idle / CFS visually checked" \
     --probe-after-delay-ms 1500 \
     --probe-after-count 6 \
     --probe-after-interval-ms 5000 \
     --output-dir tmp/k2-cfs-slot-control-captures \
     --pretty
   ```

5. 1回のlive送信ごとに停止して、人間の目視、CFS本体状態、前後`boxsInfo`の差分を確認する。
   side-effect commandなので、timeoutや不明応答時に同じcommandを自動再送してはならない。

   CLI結果は次のように解釈する。

   ```text
   status:"submitted" / reason:"post-command-observation-not-requested"
     → command frameはWebSocketへlocal submitされたが、送信後のboxsInfo観測は要求されていない。
       これは成功確認ではないため、production certification evidenceには単独で使わない。

  status:"post-observed"
     → command frame送信と指定されたpost-command read-only probeが完了した。
       ただし物理load/unload成功そのものは人間の目視とcapture markerで別途確認する。
       `physicalCommandRecoveryLatch` では未解決として保持し、自動再送せず、operator-cleared /
       observed-confirmed / observed-rejected のいずれかでのみ解除する。

   status:"rejected" / reason:"pre-command-observation-failed"
     → command送信前のboxsInfo観測に失敗したため、CFS操作frameは送られていない。

   status:"rejected" / reason:"pre-command-printer-not-idle"
     → command送信前のprinter status観測で、state/deviceState/job time/target温度のいずれかが
       印刷・加熱・前ジョブ残存を示したため、CFS操作frameは送られていない。

   status:"unknown" / reason:"post-command-observation-failed"
     → command frameは送信済みだが、送信後のboxsInfo観測がtimeout/errorになった。
       物理side-effect有無が不明なので、blind retryせず人間がCFSとプリンタ画面を確認する。
   ```

   `--output-dir` を指定した場合は、timestamp付きdirectoryへ `certification-result.json` を保存する。
   dry-run/live/unknownのいずれも同じJSON shapeで保存されるため、このfileをreviewerへ渡す。
   `probePlan` には `info`、`requireInfoModel`、`confirmSource`、`requirePrinterIdle`、`boxsInfoTimeoutMs`、
   `printerStatusTimeoutMs`、`infoTimeoutMs`、`postCommandProbeDelayMs`、`postCommandProbeCount`、
   `postCommandProbeIntervalMs` を保存するため、後から
   「通信応答timeout」なのか「物理反映待ち不足」なのかを切り分けやすい。
   `printerInfo` には `/info` のmodel/version/port hintと観測時刻、期待modelとの一致結果を保存する。
   `printerStatus` には送信前のread-only status probe結果を保存し、`idle:false` の場合は送信前rejectの根拠として扱う。
   `state` / `deviceState` が未観測のpartial frameはidle証明にもactive確定にも使わず、
   `summary.activityState:"unknown-core-state"` / `coreStateComplete:false` として保存する。
   これは「状態不足」と「not idle」をレビュー時に分けて読むための診断であり、
   `summary.active:false` であっても `summary.idle:true` でない限りlive CFS操作は送らない。
   `targetSourceDelta` には対象sourceのpresence/stateCode/selected/percent/material/color/RFID有無の前後差分を保存する。
   `--probe-before` / `--probe-after` の観測結果には `summary` が含まれ、次の項目をraw payloadとは別に確認できる。

   ```text
   boxCount
   cfsUnitCount
   externalEndpointCount
   loadedSourceCount
   selectedSourceIds[]
   targetSource
   sources[]
   colorMatches[]
   ```

   `targetSource` と `sources[]` は外部スプールを `external:<boxId>`、CFS slotを
   `cfs:<boxId>:slot:<materialId>` として分離する。ここでも材料名・色・RFIDだけではloaded推測せず、
   material `state` codeが `1` の場合だけ `presence:"loaded"` とする。

   Certification panelのJSON exportでは、raw evidenceとは別に `summary.probeSummaries.before/after` へ
   上記summaryを抽出する。これにより、reviewerへ渡すJSONから、raw payload全体を掘らずに
   selected source、target source、loaded source count、external/CFS分離を確認できる。

6. 独立したselected source変更、feed、retractの意味確定は、`cfs-load` / `cfs-unload` の認証と混ぜず別stepとして扱う。

このrunbookはcertification専用であり、UI操作有効化条件ではない。UIに開くには、少なくとも command kindごとの実機意味、
expected-state条件、timeout時の表示、stale時disable、send-time capability revalidation が揃っている必要がある。

K2 Pro Combo F012 + CFSで最低限以下を取得する。

- `feedInOrOut.isFeed=1` は1A/1Bで取得済み。対象slotが最終的にselectedとなり、ノズルへのセットとpurgeが物理的に成立した。
- `feedInOrOut.isFeed=0` は1A/1Bで取得済み。対象slotのフィラメントがノズルから引き戻され、最終的にselected sourceなしとなった。
- `feedInOrOut` はside-effect commandとしてblind retry禁止を維持する。各live試験はcommand frameを1回だけ送信し、追加観測はread-only probeだけとした。
- `modifyMaterial` がGeneric材料で反映されるか、RFID材料で拒否されるか。
- `boxConfig` の各fieldが `boxConfig` / `cfsInfo` / `boxsInfo` のどこへ反映されるか。
- CFS disconnected/stale中はすべての操作が送信前に拒否されること。
- 印刷中、paused中、error中、runout中のdisable reasonが人間に分かること。

### F012 Slot Control Live Certification Result (2026-09-09)

匿名化済み証跡は
`tests/fixtures/printers/k2-pro-cfs/scenarios/cfs-slot-control-live/certification-summary.json`
へ固定する。raw `certification-result.json` は実IP、hostname、実時刻などを含むためrepositoryへ追加しない。

実施したsequenceは次の2 cycleである。

```text
cycle 1: 1A 押出し -> 1A 引戻し -> 1B 押出し -> 1B 引戻し
cycle 2: 1A 押出し -> 1A 引戻し -> 1B 押出し -> 1B 引戻し
```

確認結果:

- 全8操作で `feedInOrOut` command frameは各1回だけ送信し、blind retryは行わなかった。
- 押出しでは `feedState` 101/103/104/105/107、引戻しでは111/112/113/14/0を観測した。
  数値codeは観測値として保持し、それ単独を成功判定には使わない。
- 1A/1Bの両方でノズルへのセット・アンセット動作とpurge生成をoperatorが目視確認した。
- 初期の6回bounded probeではselected解除まで収まらない操作があった。延長観測では1B押出しのselected成立と、
  1B引戻し後のselected解除および `feedState:0` を同一windowで取得できた。
- 最終目視ではprinter idle、errorなし、1A/1BはCFS内でloaded、ノズルへ供給中のsourceなし、
  ノズルからフィラメントが引き戻し済み、異音・残留動作なしを確認した。
- 1Dは物理不調かつ未装填のため除外し、外部スプールは物理holderがないため除外した。1Cは今回の操作対象外である。

この結果がproductionへ認証するのは、scopeが一致するF012 + CFSの `cfs-load` と `cfs-unload` だけである。
`cfs-slot-select` / `cfs-feed` / `cfs-retract`、`modifyMaterial`、`refreshBox`、`boxConfig`、
K1C/CFS-Cおよび別model/firmwareへ証跡を流用しない。

## Reviewer Questions

レビュワーには次を確認してもらう。

- F012 K2 Pro Comboで `feedInOrOut` をslot select/loadとして扱ってよいか。
- UI上の「Feed」「Retract」と、CFSの「Load」「Unload」が同じ操作として扱えるか。違うなら3DPmon UIではどの語を使うべきか。
- `modifyMaterial.id` と `materialId` の呼び分けを3DPmon内部でどう正規化すべきか。
- `boxConfig` とCloud側 `cfsInfo` のfield対応をどう扱うべきか。
- 実機capture前に実装してよい範囲はdry-run transportまでか、hidden feature flag付きlive CLIまで含めてよいか。

## Release Boundary

2.2.1042は既存pre-releaseとして残し、2.2.1043は既存pre-release番号と重なるため、PR #436のread-only/print-start guard版は2.2.1044 RCとして扱う。K2/CFSを3DPmon UIから操作できる版は、少なくとも次を満たすまで別リリース候補にしない。

- Gate 19: transport candidate + dry-run + live certification CLI
- Gate 19.5: UI操作ボタンの実行中/成功/失敗/timeout/stale disable
- Gate 20: restart recovery後もfresh topology再観測と操作再有効化が成立
- Gate 10/12: K2実機とK1C+CFS-C実機で物理certification
- Gate 21: release certification
