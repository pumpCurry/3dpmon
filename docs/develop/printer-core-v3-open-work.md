# Printer Core v3 Open Work

Last updated: 2026-08-25

このメモは、Gate 1-18 の contract / fail-closed 判定とは別に、現場でユーザーが設定、監視、判断、操作するときに未実装または未接続として残っている項目を整理する。

## 未実装と分かっているもの

- Gate 10 / Gate 12 の実機 certification は未完。K2 CFS topology、K1C + CFS-C の attach / detach / runout / stale / reconnect は、表示土台はあるが実機意味の最終確定は残っている。
- CFS/CFS-C の feed / retract / slot select / load / unload は本番UI/transportへ未接続。表示moduleにはfail-closedな操作候補ボタン、intent -> command request -> bound dispatcher のintegration scaffoldを用意したが、通常画面ではread-only監視のままで、操作はプリンタ本体から行う。
- K2/CFS print semantics certification は未完。Gate9.5 で selected-source guard は確認しているが、command lifecycle完了と物理的なfilament供給/押出成功は別証跡として実機captureで確定する必要がある。
- Data Schema v3 の本番 write / migration は未完。dry-run contract はあるが、Device / Endpoint / CfsUnit / MaterialSource / Spool / Mount / Ledger の永続authorityはまだ切り替えていない。
- command authority は未完。command id、result、expected-state confirmation、timeout、side-effect retry guard、production dispatcher の send-time 再検証 foundation、bound dispatcher foundation はあるが、UI操作の本番送信経路はまだ移していない。
- production command dispatcher は、caller supplied contextを受け取らず、送信直前snapshotから内部署名contextを生成し、active session、current upload generation、file identity、CFS topology source binding、unknown command kindを再検証する。UIへ渡す場合はbound dispatcherの`dispatch(request)`だけを渡し、UIからsend-time context providerやtransportを注入しない。ただし実transport接続と実機command certificationは未完。
- command correlation は、低レベルcallerがproof風objectを渡しても発行されず、bound dispatcherがtrusted observation providerから受け取ったcommandId/sessionId付きprotocol response ID / transition ID proofを内部検証した場合だけattested evidenceを作る。protocol response IDを根拠にする場合はtransport response側のIDとも一致させる。
- single-color / multicolor print authority は未完。PrintPlan contract と selected material guard はあるが、UIからの印刷開始authorityはまだ完全にはCoreへ移していない。
- Filament Ledger authority は未完。CFS観測残量は ledger authority ではなく observation-only として扱う。
- UI authority cutover は未完。既存UIの主要表示はまだlegacy raw stateと共存しており、NormalizedStateのみを見る状態には切り替えていない。

## UIに繋ぐべきだが、まだ繋いでいないもの

- CFS/CFS-C の操作ボタンは通常UIへまだ接続しない。表示module内の操作候補ボタンは、ViewModel候補権限、renderer側allowedActions、送信hookのすべてが揃わない限りdisabledになる。scaffoldの`dispatchCfsControlIntent()`も`enabled:true`が明示されない限りbound dispatcherを呼ばない。
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

## Gate 18.5 後も残る実機確認項目

- K2 CFS / K1C+CFS-C のattach、detach、runout、slot選択、remaining変化は、UIに表示できる入口を得たが実機captureで物理操作との対応を最終確認する必要がある。
- CFS-CのMoonraker object名は `boxsInfo` / `boxs_info` を代表候補とし、実際に存在するobjectだけを購読する。実機firmwareで別名が出た場合はsecondary providerのsubscribe候補だけを追加する。
- feed、retract、load、unload、slot selectのCRUD/command authorityは引き続き未開放。read-only表示とは別Gateでactual adapter transportを接続し、実機でcommand result、expected state、timeout、side-effect retry guardを満たしてから有効化する。
