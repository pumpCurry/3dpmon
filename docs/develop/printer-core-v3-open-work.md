# Printer Core v3 Open Work

Last updated: 2026-08-31

このメモは、Gate 1-18 の contract / fail-closed 判定とは別に、現場でユーザーが設定、監視、判断、操作するときに未実装または未接続として残っている項目を整理する。

実機certificationの手順は `docs/develop/printer-core-v3-live-certification-runbook.md` を参照する。

K2/CFSを3DPmon UIから操作するための仕様調査とGate 19設計境界は
`docs/develop/printer-core-v3-gate19-cfs-control-spec-investigation.md` を参照する。

Gate 18.9 の Universal MaterialSource accounting 仕様は
`docs/ADR/0036-printer-core-gate18-9-universal-material-source-accounting.md` と
`docs/develop/printer-core-v3-gate18-9-universal-material-source-accounting.md` を参照する。

## Gate status matrix

| Gate / Area | Code | Tests | Live | Production |
| --- | --- | --- | --- | --- |
| Gate 18.7 Material Observation | CLOSED | CLOSED | partial | read-only |
| Gate 18.8 Material Observation UX / Evidence | CLOSED | CLOSED | partial | read-only |
| Gate 19 Slot Control Spec | scaffold CLOSED / recovery latch schema+storage added | CLOSED | pending | disabled |
| Gate 19.5 UI Control Lifecycle | scaffold CLOSED / selection evidence + recovery blocker UI added | CLOSED | pending | disabled |
| Gate 20 Restart Recovery | code CLOSED | CLOSED | pending | fail-closed |
| Gate 18.9 Universal MaterialSource Accounting | contract baseline accepted / pure repositories, dry-run planner, evidence-only journal, pure shadow preflight, staged+durable shadow transaction, print binding shadow attribution repository, and source-aware read-only UI projection added | contract CLOSED / repository+planner+journal+preflight+transaction+print-binding+UI projection tests passing | pending | disabled |
| K2/CFS Print Start | implemented | tested | certification scope pending | guarded |
| K2/CFS Standalone Slot Control | candidate only | dry-run tests | pending | disabled |

現時点のv2.2.1045では、K2/CFSの `load` / `unload` / `feed` / `retract` / `slot select`
のstandalone操作はすべて無効である。実機certificationをmodule-owned registryへ追加するまで、
UI設定や保存済みtarget情報だけでproduction操作へ昇格しない。

## 未実装と分かっているもの

- Gate 18.9 Universal MaterialSource accounting は、K1/K2を別会計にせず
  `Device -> FilamentUnit -> MaterialSource -> SpoolMount` へ統一する次の実装対象。
  K1 direct spoolはsourceが1つだけのケース、K2/CFSやK1C/CFS-Cはsourceが複数のケースとして扱う。
  `hostSpoolMap` は最終authorityではなくlegacy compatibility projectionへ降格する。
  Gate 18.9A contract baselineは`4ff7b06`でACCEPT済み。pure
  `MaterialSourceRegistry` / `SpoolMountRepository`は開始済みで、source ID immutability、
  canonical locator/identity validation、identityとlocatorのslot/index整合、
  provisional rekey boundary、open mount最大1、close lifecycle、restart-safe operation
  idempotency、interval overlap conflictを固定しながら、永続化やcutoverへ段階的に接続する。
  migration planner dry-runは追加済みで、migration専用operator確認済みK1 direct-onlyはsource-aware候補を生成する一方、
  K2/CFS multi-source、未確認single-spool、topology未観測K2、future-dated/stale/incomplete観測は
  blind migrationせずcandidate/blockedへ留める。
  Gate 18.9Bでは、このdry-run plan/evidenceだけを`materialAccountingMigrationJournal`
  として保存・復元・importできるようにした。journalは証跡専用であり、
  MaterialSource/SpoolMount authority writeやlegacy ledger debitはまだ有効化しない。
  dry-runは本番`SpoolMount`ではなく`mountCandidates`だけを返し、`openedAt`と
  `mountOperationId`は後続のpersistent shadow transaction adapterが実行時に発行する。
  plan全体の`migrationBatchId`、entry単位の`migrationSubjectId`、`planRevisionId`を分離し、
  plan作成時刻、accepted confirmation evidence、identity、topology freshness、repository snapshotが
  変わると別revisionになる。confirmationはentry単位のconfirmation前`confirmationEvidenceChecksum`へbindし、
  final `source.checksum`は受理済みconfirmation投影を含めるため、checksum循環を作らず証拠変更時に再確認を要求できる。legacy hostが
  複数strong deviceへ解決される場合、またはopen device identity conflictが残る場合はfirst-matchせずBLOCKする。
  保存済みjournalの壊れたentry、または`planDigest`が本文と一致しないentryは起動時にthrowせず
  `retainedUnsupportedEntries`へ隔離する。Gate 18.9Cでは、journalのREADY entryをそのまま信頼せず、
  `latestRevisionBySubject`でentry subjectの最新revisionを解決し、実行直前に再生成したcurrent planと
  device/source/spool/mount intentの同一性を再検査するpure shadow preflightを追加した。このpreflightは
  対象entryのstatusをplan全体statusと混同せず、`evaluatedAt`とcurrent plan `createdAt`の近接性、MaterialSource/SpoolMount repository facadeが明示的に渡されていることを必須にする。read-only repository APIだけを参照し、MaterialSource/SpoolMount/ledgerへwriteせず、`openedAt`や
  `mountOperationId`も採番しない。Gate 18.9D-1では、モジュールが発行したtrusted READY preflightだけを入力権威として、
  `shadowOperationId`と`executedAt`からstaged transaction候補を作る。ここで初めて`openedAt`と
  `mountOperationId`を採番するが、prepared transactionと`SHADOW` lifecycle statusは分離する。MaterialSource/SpoolMount snapshotを明示入力として必須化し、snapshot未指定を空の本番状態として扱わない。snapshot内の既存conflictはstaged repository再構築前にblockedへ落とし、`executedAt`がpreflight `evaluatedAt`より前なら拒否する。既存snapshotから作ったstaged repositoryへ全recordを検証投入できた場合だけ
  transactionを返し、conflict時はpartial transactionを返さない。これはまだproduction storage/ledger authorityではない。Gate 18.9D-2では、trusted prepared transaction、persistent shadow commit store、transactionに固定したbase snapshot digest CAS、durable write callback境界、restart/recovery round-tripを追加した。durable writerは同じ永続transaction内でCASを適用したことを`casApplied:true`で返す必要があり、durable write成功後だけsubject lifecycleを`shadow`へ進め、失敗時は旧storeを返す。同じ`shadowOperationId`と同じpayloadは冪等、同じoperation IDで異なるpayloadはblockedにする。Gate 18.9Eでは、print-start時点のMaterialSource/SpoolMount/tool binding snapshotをsource単位で保存し、completion時のsource-specific usageを各source/mount/spoolへ帰属するread-only shadow repositoryを追加した。callerのcomplete宣言やtrusted風booleanだけでは未観測sourceを0mm確定せず、明示0mm usageがある場合だけconfirmed-unusedにする。multi-source total-only usageやsource-specific/total residualはpending/unattributedへ隔離し、single-source total-only usageだけはread-only source segmentとして扱う。public repositoryはtrusted usage evidence、trusted result-set completeness evidence、debit authorityをmintしない。復元時は同一semantic IDのpayload conflictがあれば勝者を残さず全件隔離し、`operationsById`はprocess lifetime cacheとして扱ってrestart後には復元しない。Gate 18.9Fでは、保存済みprint binding storeをフィラメント管理のCFS source行へread-only投影し、機器reported remainingと3DPmon管理スプール残量、source-specific直近使用量を別行として表示する。print binding storeも再起動後に復元されるが、ledger debitとlegacy cutover sealはまだ行わない。
- Gate 18.9E/F hardeningでは、public print binding repositoryがtrusted print-start snapshotもmintしない境界へ戻し、module-owned result-set completeness evidenceが無い限りcomplete扱いにしない。復元時はsnapshot/usageEvidence/segment/ledgerのcross-record整合を検査し、孤立recordを`retainedUnsupportedEntries`へ隔離する。UIのsource-aware accounting joinはraw `sourceId`一致だけでなく、Universal MaterialSource ID、alias、locatorで合流する。
- Gate 18.9Gでは、result-set completeness registryをpublic callerからのtrusted発行経路としてはfail-closedにした。registryはmodule-owned evidenceの検証境界だけを残し、provider/session/generation/result digestにbindされたissuerが未接続のあいだは、未出現sourceをtrusted `confirmed-unused`へ昇格しない。production spool debit、legacy `usageHistory`、spool残量更新はまだ行わない。
- Gate 10 / Gate 12 の実機 certification は未完。K2 CFS topology、K1C + CFS-C の attach / detach / runout / stale / reconnect は、表示土台はあるが実機意味の最終確定は残っている。
- K2/CFS print-start のWS9999 transport mappingは Gate20 で `colorMatch` -> `multiColorPrint` の2frame planとして追加した。ただし実機certification前なので、UI command authorityやfilament ledgerへはまだ昇格しない。
- CFS/CFS-C の feed / retract / slot select / load / unload は本番transportへ未接続。通常フィラメントパネルにはfail-closedな操作候補hookと、composition-bound integration -> intent -> command request -> bound dispatcher のscaffoldを用意したが、LAN command keyが未certifiedのため`dashboard_k2_cfs_command_transport.js`でも `uncertified-cfs-slot-command` として拒否し、production有効化前は`enabled:false`でread-only監視のまま閉じ、操作はプリンタ本体から行う。
- K2/CFS print semantics certification は未完。Gate9.5 で selected-source guard は確認しているが、command lifecycle完了と物理的なfilament供給/押出成功は別証跡として実機captureで確定する必要がある。
- Data Schema v3 の本番 write / migration は未完。dry-run contract はあるが、Device / Endpoint / CfsUnit / MaterialSource / Spool / Mount / Ledger の永続authorityはまだ切り替えていない。
- command authority は未完。command id、result、expected-state confirmation、timeout、side-effect retry guard、production dispatcher の send-time 再検証 foundation、bound dispatcher foundation はあるが、UI操作の本番送信経路はまだ移していない。
- production command dispatcher は、caller supplied contextを受け取らず、送信直前snapshotから内部署名contextを生成し、active session、current upload generation、file identity、CFS topology source binding、unknown command kindを再検証する。UIへ渡す場合はbound dispatcherの`dispatch(request)`だけを渡し、UIからsend-time context providerやtransportを注入しない。ただし実transport接続と実機command certificationは未完。
- command correlation は、低レベルcallerがproof風objectを渡しても発行されず、bound dispatcherがtrusted observation providerから受け取ったcommandId/sessionId付きprotocol response ID / transition ID proofを内部検証した場合だけattested evidenceを作る。protocol response IDを根拠にする場合はtransport response側のIDとも一致させる。
- single-color / multicolor print authority は未完。PrintPlan contract と selected material guard はあるが、UIからの印刷開始authorityはまだ完全にはCoreへ移していない。
- Filament Ledger authority は未完。CFS観測残量は ledger authority ではなく observation-only として扱う。
- Gate 18.9Bまでは、multi-source deviceのtotal-only usageをsource数・色・material名で推測分割しない。
  source-specific usageとprint-start mount snapshotが揃わない消費はpending/unattributedへ隔離する。
- UI authority cutover は未完。既存UIの主要表示はまだlegacy raw stateと共存しており、NormalizedStateのみを見る状態には切り替えていない。

## Gate 18.9 で固定する accounting 境界

- `SpoolMount` は3DPmon上のoperator-managed装着状態であり、restart / reconnect / stale / detach / selected変更 / RFID未取得だけでは自動closeしない。
- `Debit eligibility` は各jobのprint-start時点で別途検査する。SpoolMountがOPENでも、fresh topology、source continuity、RFID mismatch無し、source-specific usageなどが揃わなければ自動debitしない。
- `loaded` / `empty` / `unobserved` / `selected` / `T1A` などのdevice observationは、SpoolMountやledgerへ直接逆流しない。
- RFIDや機器reported remainingは表示・診断・operator correction候補であり、3DPmonのledger remainingを自動上書きしない。
- N=1 deviceでは従来のフィラメントカード体験を維持できるが、N>1 deviceをlegacy `getCurrentSpool(host)` へfallbackしてdebitしてはいけない。
- Universal accountingへcutoverするdeviceでは、旧legacy mount intervalをcutover直前の最終完了jobで封印し、以後のjobをlegacy derive対象に含めない。

## UIに繋ぐべきだが、まだ繋いでいないもの

- CFS/CFS-C の操作候補hookは通常フィラメントパネルへ接続済み。ただしproduction有効化前はrenderer側`canSendCommands:false`とcomposition-bound scaffold側`enabled:false`で二重に閉じ、ViewModel候補権限、renderer側allowedActions、送信hookのすべてが揃わない限りdisabledになる。production有効化には、現在接続世代へbindされた`/info`、fresh topology、module-owned immutable certification registry登録済み証跡が必要で、保存済みtarget設定やUI clickごとのdispatcher/context/enabled注入だけでは有効化しない。
- CFS Debug / Certification panel は、選択状態の完全性と未解決physical command recovery blockerをpreflightとして表示する。保存済み復旧ラッチで `unresolvedByCommandId` のkeyとrecord内commandIdが食い違う場合は、どちらのIDで問い合わせてもintegrity quarantineとしてblockする。
- CFS/CFS-C のslot選択状態は表示するが、ユーザーが3dpmon側でslotを選ぶ本番UIはまだ提供しない。
- CFS/CFS-C の残量値は表示するが、手動スプール台帳の残量へ自動反映しない。
- stale / reconnect / runout / attach / detach のプロトコルイベントは表示できる形へ寄せたが、実機Gateで物理操作と最終対応付けする必要がある。
- 複数CFS構成の設定は表示枠として扱えるが、複数実機unitの物理接続順、boxId欠番、CFS-C固有挙動は実機captureで確認が必要。

## Read-onlyのまま成立すべきだが、追加検証が必要なもの

- CFSなし + 通常スプール1巻、CFS 1-4台 + 外部スプールON/OFF、最大17巻の表示切替。
- K1 / K2 / K1C / Moonraker / IR3 V2 が、対象外protocolへ誤ってPrinter Core v3 material topologyを流さないこと。
- CFS slotのloaded / empty / unobserved / unknown が、人間の抜き差し操作と一致して表示されること。
- selectedがプリンタ本体でのslot選択に追従し、未selected印刷やdry-run状況を監視上で検出できること。
- invalid remainingを0%として見せず、報告値異常として表示すること。
- stale topologyを現在値として見せず、最終観測状態として表示すること。
- 複数K2を同時表示しても、DOM再描画、panel flicker、CPU churnが過剰にならないこと。

## 今回閉じた監視UX項目

- invalid remainingは `残量 不明` として表示し、0%表示へ丸めない。
- stale topologyではbannerを出し、selected / remainingを最終観測として表示する。
- 監視パネルの主要文言を日本語化した。
- CFS/CFS-C read-onlyであることを常時footerに表示する。
- 接続設定は `フィラメント供給` の単一selectへ集約し、mode / displayMode / unitLimit の矛盾設定を作りにくくした。
- 外部スプール枠の表示ON/OFFを設定できるようにした。
- 物理slot、装填状態、機器選択状態、印刷割当を別表示に分離し、`T1A`などの割当識別子を物理CFS slot名として見せない。
- stale中のslot presenceも `最終観測: 装填中` のように表示し、slot単体で現在値と誤認しない。
- CFS-C provider由来の `presence` / `presenceEvidence` はObservation Storeへ保存し、providerが明示presenceを注釈した場合は `observedFields.status.presence` も同時に伝える。

## Gate 18.5 追加で閉じた read-only operational readiness 項目

- 接続追加UIで `K2系 (Creality)` を選択できるようにした。既存の `connectWithType()` は `creality-k2` を保存し、K2既定のCFS 1台 + 外部1巻表示へ進める。
- `/info` またはWS9999 payloadで `model:"F012"` / K2 hostnameを観測した場合、K1として登録された接続先を `creality-k2` へ自動昇格する。operatorが明示したCFS設定は保持し、K1既定設定だけをK2既定へ置き換える。
- K2 CFS `boxsInfo` は初回probeに加え、CFS接続中は30秒以上古くなった場合にread-only refreshを送る。`boxsInfo` pushを受けた直後は余計なprobeを抑止する。
- K2 CFS topologyの鮮度は通常status frameでは延命しない。`boxsInfo`を実際に含むframeを受信した時だけmaterial topologyの観測時刻を更新し、プリンタ生存とCFS topology freshnessを分離する。
- フィラメントパネルは、legacyカードで起動したあとにmaterial topologyが遅れて到着した場合、同じパネルDOM内でmulti-slot表示へ切り替える。
- live shadowがclosed、またはmaterial topology観測がTTLを超えた場合、CFS表示は `stale / 最終観測` として扱う。K1C+CFS-Cでは本体K1のフレームではなくmaterial providerの観測時刻を優先して鮮度を判定する。
- K1C/CFS-C向けに `Moonraker boxsInfo` secondary provider endpointを接続設定へ保存できるようにした。設定時だけ別Moonraker sessionをread-onlyで開き、CFS-C material payloadをPrinter Core v3 runtime topologyへ流す。
- CFS-C secondary providerが切断された場合、`payload:null` を新しい空topologyとして保存せず、last-known material topologyを保持したまま `stale / 最終観測` へ落とす。
- CFS-C secondary providerはmaterial-only sessionとして起動し、通常Moonraker監視用の温度/履歴/ファイル/カメラ取得を行わない。`printer.objects.list` で存在するmaterial objectだけを購読し、subscribe errorは無言で握りつぶさず `disconnected` として通知する。
- CFS-C secondary providerの初期化RPC失敗はWebSocketを閉じて既存backoff retryへ流す。runtimeでは `materialProviderLastObservedAt` と `materialProviderDisconnectedAt` を分け、last material observationとdisconnect observationを混同しない。
- CFS操作候補は描画時snapshotだけでclick可否を判断しない。通常フィラメントパネルから `validateCommandIntent` を渡し、click直前に最新topologyでsource/stale/loaded/displaySlotを再確認してからbound integrationへ渡す。

## Gate 18.5 後も残る実機確認項目

- K2 CFS / K1C+CFS-C のattach、detach、runout、slot選択、remaining変化は、UIに表示できる入口を得たが実機captureで物理操作との対応を最終確認する必要がある。
- CFS-CのMoonraker object名は `boxsInfo` / `boxs_info` を代表候補とし、実際に存在するobjectだけを購読する。実機firmwareで別名が出た場合はsecondary providerのsubscribe候補だけを追加する。
- feed、retract、load、unload、slot selectのCRUD/command authorityは引き続き未開放。read-only表示とは別Gateでactual adapter transportを接続し、実機でcommand result、expected state、timeout、side-effect retry guardを満たしてから有効化する。

## K2 Pro Combo アプリ登録 実機確認

- `192.168.54.153` のK2 Pro Combo実機で、接続管理UI相当の `connectWithType("192.168.54.153:9999", "creality-k2")` をElectron rendererから実行し、登録、接続、表示更新を確認した。
- `/info` は `model:"F012"`、`wssPort:443`、`videoPort:443` を返す。`mac` は有線LAN側を示すため、Wi-Fi接続時の同一性判定ではMAC単独を強い識別子にしない。WS9999のprovisional identityは同一endpointの後続 `/info` serial evidenceで強いidentityへ昇格する。
- 接続後はhostname `K2Pro-69E7`、printerType `creality-k2`、state `0`、progress `0`、`cfsConnect:1`、Printer Core v3 shadow `observed`、material topology `fresh` を確認した。
- CFS topologyは外部スプール空、CFS 1台、1A/1B/1C loaded、1D emptyとして観測できた。selected sourceは未選択のため、CFS print-start guardの実機条件として引き続き監視対象にする。
- 印刷履歴はWS9999 `reqHistory` で35件を取得できた。ファイル一覧はWS9999 `retGcodeFileInfo2` を既存file renderer用entriesへ変換して13件を表示できた。WS応答が遅い場合に備え、K2 read-only HTTP API `http://host:4408/server/history/list` と `http://host:4408/server/files/list?root=gcodes` から補完するfallbackを追加した。
- カメラについては `http://host:8000/` のcamera serviceが到達可能で、K1 MJPEG endpointではなくWebRTC signalling方式として振る舞う。`/info.videoPort=443` はMJPEG portとしては扱わず、K2 camera viewerは `http://host:8000/call/webrtc_local` へbase64 JSON SDP offerをPOSTし、answer取得、ICE接続、ontrack、1280x720 video frame取得までを独立probeで確認した。証跡は `tmp/k2-webrtc-probe/2026-08-26T01-04-49-961Z` に保存した。
- 現行カメラパネルはK2系のみWebRTC `<video>` viewerを使い、K1/Moonrakerは従来のMJPEG/snapshot経路を維持する。RTCPeerConnectionが利用できない環境ではMJPEGへ誤フォールバックせず、`WebRTCカメラ未対応` と明示する。

## Gate 20 追加で閉じた command transport 項目

- K2/CFS print-start command requestを、公開OrcaSlicer実装と同じ `set colorMatch` -> `set multiColorPrint` の順序付きWS9999 frameへ変換するtransport planを追加した。
- CFS sourceを使う場合に `opGcodeFile` fallbackを生成しないことをテストで固定した。
- external spool source、material type/color証拠不足、未certifiedのslot操作はtransport plan生成前に拒否する。
- send hookはconnection layer注入のままにし、transport module自身はWebSocketを所有しない。
- `scripts/capture_k2_cfs_print_start.mjs` を追加し、実機送信前に同じtransport planをCLIでdry-run確認できるようにした。`--send` が無い限りWS接続も送信も行わない。
- `sendK2CfsCommandTransportPlan()` はframe responseを評価し、失敗/未知statusでは次frameへ進まない。`submitted` はlocal送信完了のみを意味し、protocol ackではない。
- `protocolCommandId` はprofile/PrintPlan由来の合成IDを廃止し、transport responseに実IDがある場合だけ採用する。実IDが無い場合は `correlationEvidence.kind:"none"` としてauthority証跡へ昇格しない。
- certification CLIのlive送信は `ws.send()` callbackをawaitし、WebSocket libraryが各frameを受け取る前に `sent:true` を返さない。
- certification CLIの実送信は `--send` に加えて `--confirm-live --confirm-host <host>` を必須にし、dry-run確認後の明示操作だけをlive境界として扱う。
- transport plan detailsへ `assignmentEvidence[]` を追加し、sourceId、protocol alias、type/color、各値の由来をdry-run結果に残す。live実行前にCFS slot観測値と一致確認するための証跡にする。

## Gate 20 後も残る command activation 項目

- K2実機で `colorMatch` -> `multiColorPrint` を明示確認し、post-start selected CFS source、物理feed、消費量変化、完了状態を同一fixtureで証明する。
- certification CLIで実送信する場合は、dry-run出力を確認したうえでoperatorが明示的に `--send --confirm-live --confirm-host <host>` を付ける。Codex側からlive送信する場合も、その直前にユーザー確認を取る。
- 実機certificationが終わるまで、通常フィラメントパネルのCFS操作ボタンは送信可能にしない。
- slot select / load / unload / feed / retract は、K2本体UI操作または公式クライアント操作の通信captureでLAN command keyを確定してからadapterへ追加する。
- K1C+CFS-Cについては、Moonraker object経由のmaterial providerとは別に、操作commandのprovider/transport境界を実機で確認する。

## Registry追加前に必ず閉じる項目

- standalone slot control registryへ最初の実機certificationを追加する前に、`certificationId`参照方式へ移すか、少なくともtarget側へ保存する証跡とmodule-owned registry entryの責務分離を再レビューする。
- `cfs-slot-select` をproduction registryへ追加する前に、renderer row由来のbaselineではなく、send-timeのcurrent material topology observationからsource/presence/selected baselineを再取得する。
- Gate 18.9A/B/C migration planner は stable device identity、unique host/device resolution、open device identity conflictなし、migration専用operator確認済みsingle-spoolまたはfresh complete source observation、stable observed source identity、complete locator、既存Universal MaterialSource/SpoolMount conflictなしをREADY条件に含める。plan全体は`migrationBatchId`、host-to-spool単位はentry側`migrationSubjectId`で分離し、single-spool confirmationはentry subjectとentry confirmation前evidence checksumへbindする。READY entry validatorは1 FilamentUnit / 1 MaterialSource / 0 SpoolMount / 1 mountCandidateだけを許し、MaterialSourceのdevice/unit bindingと既知reason IDも検証する。journalはsource checksumに加えてplan body digestも検証し、`latestRevisionBySubject`をvalid entryから再構築する。Gate 18.9Cのpure shadow preflightはlatest journal revisionとcurrent planの同一entry mappingだけをshadow候補にし、古いrequested revision、stale/non-READY current plan、Device入替、registry/mount conflictをwrite前に拒否する。次はjournal/preflightを本番権威へ昇格せず、trusted print-start material binding snapshotとsource-specific usage evidenceを別Gateで実装する。
- side-effect command送信後にアプリがcrash/restartした場合のため、未解決physical command latchを永続化するschema/store/storage経路を追加済み。Gate 19 production dispatcherのUI操作経路も、送信前にsubmitted reservationをstoreへappendし、`saveUnifiedStorageDurably()` のflush成功後だけphysical transportへ進む。submitted / post-observed / unknown相当の結果はstoreへappendし、再起動後に自動replayしないところまで接続済み。send-time recovery blockerは現在command IDだけでなく、同じdeviceに残る古い未解決CFS physical commandも全CFS操作のblockerとして扱う。operator confirmationはCFS Debug / Certificationパネルから `resolvePhysicalCommandRecoveryLatchRecord()` へ接続済み。`cfs-slot-select` は次のmaterial observationがfreshで、すべてのloaded/unknown実sourceのselectionValid=trueが揃い、selected sourceが一意かつ対象sourceと一致し、現在store上の同一recovery record digest/source/deviceへ束縛できる場合だけ `observed-confirmed` として自動解決する。load/unload/feed/retractは実機semantics確定までoperator confirmationが必要。
- Gate 10/12 certification fixtureは、fixture hash、before/after observation、operator marker、transport response、expected-state confirmationを同じ証跡として保存する。

## Release certification helper

- PR CIではunit test、E2E boot、version sync、smokeをgatingにする。既存ESLint/Stylelint/Prettier debtが残るため、lint jobは当面advisoryとして維持し、完全gating化はlint debt整理PRで行う。
- release artifact作成前に `npm run verify:release` を実行し、`dist/release-manifest-<version>.json` のSHA256とreview済みcommitをrelease noteへ転記する。
