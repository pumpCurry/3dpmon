# Printer Core v3 Gate 19 Hybrid Filament UI

## 採用方針

Gate 19のCFS/CFS-C操作UIは、レビュワー提案の **B: Hybrid** を採用する。

- 通常のフィラメントカードは、監視用のcompact表示として維持する。
- CFS/CFS-Cの外部スプールとCFSスロットは混ぜず、別の供給源として表示する。
- `1C` のような物理スロット名と、`T1C` のような印刷/G-code割当は、UI上で別概念として表示する。
- stale時は現在値に見せず、「最終観測」として扱う。
- CFS/CFS-Cの危険操作、dry-run、ARM、証跡出力は、通常カードではなく広い `CFS Debug / Certification` パネルに隔離する。

## 実装範囲

この段階で追加する `cfs-certification` パネルは、実機certification前の安全な検証UIである。

- `Read-only Probe`
- `Preflight`
- `Dry-run`
- `Live Arm`
- `Evidence timeline`
- `証跡エクスポート`

`LIVE SEND` は未認証では無効であり、production commandへ接続しない。実送信を有効化する場合は、実機certification証跡をregistryへ登録し、send-time session/capability/topology/source loaded再検証を通過する必要がある。

## 境界

通常カード:

- 日常監視に使う。
- 17巻構成でも外部スプールとCFS 1-4台を分けて表示する。
- 操作候補ボタンはproduction authorityが成立しない限りdisabledのままにする。

Certificationパネル:

- 実機横でのprotocol調査、dry-run payload確認、証跡exportに使う。
- `submitted` を成功として表示しない。
- timeoutやtransport結果不明時の自動再試行を許可しない。
- ARMは `deviceId + sessionId + commandKind + sourceId` に束縛する。

## 後続

- slot選択用のUIを追加し、現在selected以外のslotも明示的にdry-run対象へできるようにする。
- live certification後、registry登録済みcommandだけ `LIVE SEND` の実送信経路へ接続する。
- `summary.json` / `protocol.ndjson` / before-after `boxsInfo` / command plan をまとめたZIP出力を追加する。
