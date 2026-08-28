# Printer Core v3 Gate 19 CFS Control Spec Investigation

Last updated: 2026-08-28

このメモは、K2/CFSを3DPmon UIから操作できる版に向けて、公開ソース、既存3DPmon実装、実機captureで確認済みの事実、未確定の仕様境界を整理する。ここでの目的は、CFS操作を急いで有効化することではなく、どの操作をどの証跡でproduction authorityへ昇格できるかを固定すること。

## Current 3DPmon Boundary

現行3DPmonは、K2/CFSの印刷開始についてだけ、次の順序付きWS9999 frameを本番transport候補として実装済み。

```json
{"method":"set","params":{"colorMatch":{"path":"<gcode-path>","list":[...]}}}
{"method":"set","params":{"multiColorPrint":{"gcode":"<gcode-path>","enableSelfTest":0}}}
```

一方、単独のCFS操作は意図的に閉じている。

```text
cfs-slot-select
cfs-load
cfs-unload
cfs-feed
cfs-retract
```

これらは `dashboard_k2_cfs_command_transport.js` で `uncertified-cfs-slot-command` として拒否される。通常フィラメントパネルには操作候補hookとcommand request scaffoldがあるが、transportが未certifiedのため、UI authorityへはまだ接続しない。

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
| CFS slot select / load | `feedInOrOut.isFeed = 1` | 未certified。実機captureでselected/feedState/materialStatusを確認するまでdisabled |
| CFS unload / retract | `feedInOrOut.isFeed = 0` | 未certified。物理unloadと短いretractの意味差が未確定 |
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
5. 送信後は `boxsInfo` refreshを要求し、同一session内でexpected stateを確認する。
6. expected stateが確認できない場合は `timeout` または `unconfirmed` とし、成功扱いにしない。
7. UIはGate 19.5までdisabledのままにし、Gate 19のlive evidenceが揃った操作だけを段階的に有効化する。

## Branch Implementation Cut

`codex/k2-cfs-command-spec-gate19` では、最初の実装cutとして次だけを許可する。

- 通常の `createK2CfsCommandTransportPlan(request)` は、従来どおり `cfs-slot-select` / `cfs-load` / `cfs-unload` / `cfs-feed` / `cfs-retract` を `uncertified-cfs-slot-command` で拒否する。
- Gate 19 certification用に `allowUncertifiedCfsSlotCommandCandidates:true` を明示した場合だけ、`feedInOrOut` のcandidate planを生成する。
- candidate planには `certificationOnly:true` と `requiresLiveConfirmation:true` を付け、`productionEnabled:false` をdetailsへ残す。
- `sendK2CfsCommandTransportPlan()` は、candidate planを `allowCertificationOnly:true` なしでは送信しない。
- 実機certification後にproductionへ昇格する場合は、通常callerが暗黙に通すのではなく、
  `certifiedCfsSlotControlCommands` のcommand kind allow-listと `certificationEvidence` を明示する。
  この場合だけ `k2-ws9999-feed-in-or-out-certified-v1` profileのproduction planを生成する。
  registryが空または対象commandが未登録なら、従来どおり `uncertified-cfs-slot-command` で拒否する。
- `certificationEvidence` は空objectや配列を証跡として扱わない。production昇格には最低限、
  `schemaVersion:1`、`status:"certified"`、対象 `commandKinds`、`transportProfile`、`printerType:"creality-k2"`、
  `model`、`firmwareVersion`、`fixtureId`、`captureId`、`certifiedAt` を要求する。
  現在target/runtimeで `printerType/model/firmware` を観測し、証跡scopeと一致する場合だけ有効化する。
  model/firmwareが未観測のtargetへ、F012実機で得た証跡を流用してはならない。
- UI composition層は `certifiedCfsSlotControlCommands` だけをproduction allow-listとして読み、
  legacy aliasの `commandKinds` / `certifiedCommandKinds` では有効化しない。
- K2用 `feedInOrOut` production profileは `printerType:"creality-k2"` のtargetに限定する。
  K1C/CFS-Cは後続Gateで別profileとしてcertificationする。
- sourceは `cfs:<boxId>:slot:<slotId>` だけを受け付け、外部スプールやcaller supplied `boxId/materialId` は採用しない。
- send-time context生成時とtransport plan生成直前の両方で、現在targetのcertification設定を再検証する。
  設定が削除・無効化・scope不一致になっていれば、UI初期化時に有効だったbuttonからでも送信しない。
- `sendK2CfsCommandTransportPlan()` は `createK2CfsCommandTransportPlan()` が生成したplanだけを受け付ける。
  callerがplain objectで `ok:true` / `certificationOnly:false` を偽装しても、send hookへは到達しない。
- CFS physical commandは印刷中、pause中、heating/checking/busy/running状態では送信しない。
  `print.stateLabel` だけでなく、K2 firmware差異で `device.stateLabel` / `status.stateLabel` に出る状態も確認する。
  また送信直前に対象sourceが `presence:"loaded"` でなければ送信しない。
  CFSのmaterial path共有を前提に、実機で並列安全性が証明されるまでは1 printerにつき1 commandだけを許可する。
- `scripts/capture_k2_cfs_slot_control.mjs` は同じcandidate planをCLIでdry-run確認する。live送信には
  `--send --confirm-live --confirm-host <host> --confirm-command <command>` を必須にする。
- 初期live certificationの送信対象は `cfs-load` / `cfs-unload` だけに限定する。
  `cfs-slot-select` / `cfs-feed` / `cfs-retract` はshape確認用dry-run候補に留め、追加capture根拠なしには送信しない。
- 同CLIは `--probe-before` / `--probe-after` 指定時だけ、同じWS9999 sessionでread-only `get { boxsInfo: 1 }` を送る。
  これは操作frame前後の観測差分を残すための補助であり、command成功の証明やblind retryには使わない。

このcutはUI操作有効化ではない。CLIのlive送信は明示confirmation付きのcertification用途に限定し、UI button enableはレビュワー回答とF012実機captureを待ってから別commitで進める。

## Gate 19.5 UI Command State Contract

UIでCFS/CFS-C操作を表示する場合、実行状態はDOM要素ではなくrenderer handleの外側状態として保持する。
`handle.update()` でtopology panelを再描画しても、未完了commandのbusy/statusを失ってはならない。

状態は次の意味に分ける。

- `running`: dispatcherへ送信中。同一printerの全CFS physical commandをdisableする。
- `submitted`: transportは受理されたが、`completed:false`、`confirmation.confirmed:false`、
  または `postCommandObservation.confirmed:false` のため観測確認が未完了。同一printerの再操作を抑止する。
  次のmaterial provider観測で観測時刻が進んだ場合は、人間が最新状態を再判断できるようmutexを解除する。
- `confirmed`: `completed:true` のみ。成功表示にして操作mutexを解除してよい。
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

1. dry-runで送信frameを確認する。

   ```bash
   node scripts/capture_k2_cfs_slot_control.mjs \
     --command cfs-load \
     --source cfs:1:slot:0 \
     --probe-before \
     --probe-after \
     --pretty
   ```

2. read-only `boxsInfo` を別途確認し、対象sourceが現在もfresh/loadedであることを確認する。

3. 最初のlive候補は、すでにselectedなsource（例: `cfs:1:slot:0`）だけに限定する。
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
     --probe-before \
     --probe-after \
     --pretty
   ```

4. 1回のlive送信ごとに停止して、人間の目視、CFS本体状態、前後`boxsInfo`の差分を確認する。
   side-effect commandなので、timeoutや不明応答時に同じcommandを自動再送してはならない。

5. selected source変更、load/unload/feed/retractの意味確定は、レビュワーPASSと上記1回目の成功後に別stepとして扱う。

このrunbookはcertification専用であり、UI操作有効化条件ではない。UIに開くには、少なくとも command kindごとの実機意味、
expected-state条件、timeout時の表示、stale時disable、send-time capability revalidation が揃っている必要がある。

K2 Pro Combo F012 + CFS-A1 (`192.168.54.153`) で最低限以下を取得する。

- `feedInOrOut.isFeed=1` をCFS 1A/1B/1Cのいずれかへ送った場合、該当slotの `selected`、CFS feed状態、物理ロードがどう変化するか。
- `feedInOrOut.isFeed=0` が「アンロード」なのか「短い巻戻」なのか、UIのRetract相当なのか。
- `feedInOrOut` 実行中に再送すると安全か、またはside-effect commandとしてblind retry禁止にすべきか。
- `modifyMaterial` がGeneric材料で反映されるか、RFID材料で拒否されるか。
- `boxConfig` の各fieldが `boxConfig` / `cfsInfo` / `boxsInfo` のどこへ反映されるか。
- CFS disconnected/stale中はすべての操作が送信前に拒否されること。
- 印刷中、paused中、error中、runout中のdisable reasonが人間に分かること。

## Reviewer Questions

レビュワーには次を確認してもらう。

- F012 K2 Pro Comboで `feedInOrOut` をslot select/loadとして扱ってよいか。
- UI上の「Feed」「Retract」と、CFSの「Load」「Unload」が同じ操作として扱えるか。違うなら3DPmon UIではどの語を使うべきか。
- `modifyMaterial.id` と `materialId` の呼び分けを3DPmon内部でどう正規化すべきか。
- `boxConfig` とCloud側 `cfsInfo` のfield対応をどう扱うべきか。
- 実機capture前に実装してよい範囲はdry-run transportまでか、hidden feature flag付きlive CLIまで含めてよいか。

## Release Boundary

2.2.1042はread-only/print-start guard版として公開済み。K2/CFSを3DPmon UIから操作できる版は、少なくとも次を満たすまで別リリース候補にしない。

- Gate 19: transport candidate + dry-run + live certification CLI
- Gate 19.5: UI操作ボタンの実行中/成功/失敗/timeout/stale disable
- Gate 20: restart recovery後もfresh topology再観測と操作再有効化が成立
- Gate 10/12: K2実機とK1C+CFS-C実機で物理certification
- Gate 21: release certification
