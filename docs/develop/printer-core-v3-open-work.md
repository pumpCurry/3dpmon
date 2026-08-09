# Printer Core v3 Open Work

Last updated: 2026-08-09

このメモは、Gate 1-18 の contract / fail-closed 判定とは別に、現場でユーザーが設定、監視、判断、操作するときに未実装または未接続として残っている項目を整理する。

## 未実装と分かっているもの

- Gate 10 / Gate 12 の実機 certification は未完。K2 CFS topology、K1C + CFS-C の attach / detach / runout / stale / reconnect は、表示土台はあるが実機意味の最終確定は残っている。
- CFS/CFS-C の feed / retract / slot select / load / unload は未実装。現在のUIは read-only 監視のみで、操作はプリンタ本体から行う。
- Data Schema v3 の本番 write / migration は未完。dry-run contract はあるが、Device / Endpoint / CfsUnit / MaterialSource / Spool / Mount / Ledger の永続authorityはまだ切り替えていない。
- command authority は未完。command id、result、expected-state confirmation、timeout、side-effect retry guard の契約はあるが、UI操作の本番送信経路はまだ移していない。
- single-color / multicolor print authority は未完。PrintPlan contract と selected material guard はあるが、UIからの印刷開始authorityはまだ完全にはCoreへ移していない。
- Filament Ledger authority は未完。CFS観測残量は ledger authority ではなく observation-only として扱う。
- UI authority cutover は未完。既存UIの主要表示はまだlegacy raw stateと共存しており、NormalizedStateのみを見る状態には切り替えていない。

## UIに繋ぐべきだが、まだ繋いでいないもの

- Material provider選択は設定画面に診断値として表示するだけで、実際のprovider routing UIにはしていない。
- CFS/CFS-C の操作ボタンはまだUIへ接続しない。接続する場合は、read-only表示とは別のcommand authority Gateで安全条件を満たしてから行う。
- CFS/CFS-C のslot選択状態は表示するが、ユーザーが3dpmon側でslotを選ぶUIはまだ提供しない。
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
