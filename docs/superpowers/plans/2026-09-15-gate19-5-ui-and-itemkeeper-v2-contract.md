# Gate 19.5 UI Activation And ItemKeeper v2 Contract Plan

**Goal:** Gate 19で認証済みのF012/CFS 1台/1A・1B/load・unloadだけを、接続先ごとの明示opt-inで通常UIへ安全に公開し、並行してItemKeeper v2のmulti-source wire contractを実装可能な正本へ固定する。

**Architecture:** CFS操作設定は表示用material system設定内の小さな参照値として保存するが、production authorityはmodule-owned registryとsend-time runtime validationに残す。ItemKeeper v2はCFS physical commandと分離し、accounting ledgerからpure projectionしたappend-only eventをOffer/Need/Pushで同期する。

## Task 1: Gate 19 Review Closure

- [x] registry review metadataを`reviewed-go-code-eligibility`へ更新する。
- [x] Gate 19を狭いscopeでCLOSED、Gate 19.5をGOとしてopen-workと実装planへ記録する。
- [x] ADR-0034の旧caller evidence authority記述をcertificationId + registry方式へ更新する。

## Task 2: ItemKeeper v2 Contract Hardening

- [x] `runId`、`consumptionIdentity`、stream `sequence`、semantic `eventRevision`を分離する。
- [x] correction、void、pending resolutionをappend-only eventとして固定する。
- [x] capabilities、Offer、Plan/Need、Push、Resultのexact JSON contractとallowlistを固定する。
- [x] per-printer `v1` / `v2-shadow` / `v2-authoritative` cutoverを固定する。
- [x] usage interval、mass、RFID provenance/digest、managed spool metadata取得を固定する。
- [x] cross-repository fixture scenarioを更新する。

## Task 3: Gate 19.5 Persisted Opt-In

- [x] 既定OFFの`materialSystem.cfsControl` normalizerをREDテストで固定する。
- [x] 既知certificationIdと`load`/`unload`だけを保存可能にする。
- [x] K2/CFS 1台設定でのみopt-in UIを表示し、保存後即時にfilament panelへ反映する。
- [x] K1、CFS 2台以上、未知ID、allowedActions欠落をread-onlyへ倒す。

## Task 4: Operator Safety UX

- [x] physical command実行前の明示確認を追加する。
- [x] running/confirmed/rejected/timeout/unknownを通常panelで保持する。
- [x] stale、busy、error、recovery latch時は理由付きdisabledを維持する。
- [x] unknown時はblind retryせずcertification/recovery確認導線を示す。

## Task 5: Verification And Review

- [x] targeted Vitestを実行する。
- [x] full Vitest、lint、Electron E2E、`git diff --check`を実行する。
- [ ] PR #442へpushし、Gate 19.5とItemKeeper v2 contractのdelta reviewを依頼する。
- [ ] physical canaryは新しいoperator安全確認なしでは実行しない。
