/**
 * capture_k2_cfs_topology.mjs の単体テスト。
 *
 * Gate 10 CFS topology capture wrapper が read-only recorder option を安全な既定値で
 * 構成することを検証する。実機通信は行わない。
 */
import { describe, expect, it } from "vitest";
import {
  buildK2CfsTopologyCaptureOptions,
  parseArgs,
  REQUIRED_GATE10_MARKERS,
} from "../../scripts/capture_k2_cfs_topology.mjs";

describe("capture_k2_cfs_topology helpers", () => {
  it("CLI 引数を Gate 10 CFS topology capture 用の既定値付きで解析する", () => {
    const options = parseArgs([
      "--host",
      "192.0.2.21",
      "--out",
      "tmp/cfs-topology",
    ]);

    expect(options.host).toBe("192.0.2.21");
    expect(options.outDir).toBe("tmp/cfs-topology");
    expect(options.durationMs).toBe(900000);
    expect(options.boxsInfoProbeIntervalMs).toBe(30000);
    expect(options.minimumEvents).toBe(20);
    expect(options.interactiveMarkers).toBe(true);
    expect(options.keepFailed).toBe(true);
  });

  it("scheduled marker と opt-out flag を解析する", () => {
    const options = parseArgs([
      "--host",
      "192.0.2.21",
      "--out",
      "tmp/cfs-topology",
      "--duration-ms",
      "120000",
      "--boxsinfo-interval-ms",
      "45000",
      "--marker-at",
      "1000:observed-cfs-connected",
      "--no-interactive-markers",
      "--no-keep-failed",
    ]);

    expect(options.durationMs).toBe(120000);
    expect(options.boxsInfoProbeIntervalMs).toBe(45000);
    expect(options.markerSchedule).toEqual([
      {
        atMs: 1000,
        name: "observed-cfs-connected",
        details: { source: "scheduled-cli" },
      },
    ]);
    expect(options.interactiveMarkers).toBe(false);
    expect(options.keepFailed).toBe(false);
  });

  it("汎用 recorder option は K2+CFS read-only 条件へ固定される", () => {
    const options = buildK2CfsTopologyCaptureOptions(parseArgs([
      "--host",
      "192.0.2.21",
      "--out",
      "tmp/cfs-topology",
    ]));

    expect(options).toMatchObject({
      host: "192.0.2.21",
      outDir: "tmp/cfs-topology",
      model: "K2 Pro Combo",
      attachment: "CFS",
      scenario: "k2-cfs-topology-validation",
      sendBoxsInfo: true,
      boxsInfoProbeIntervalMs: 30000,
      requireHttp: true,
      requireWs: true,
      requireBoxsInfo: true,
      skipHttp: false,
      skipWs: false,
    });
  });

  it("Gate 10 profile に必要な marker 名をヘルプ用定数として公開する", () => {
    expect(REQUIRED_GATE10_MARKERS).toEqual([
      "observed-cfs-connected",
      "operator-cfs-disconnect",
      "observed-cfs-disconnected",
      "operator-cfs-reconnect",
      "observed-cfs-reconnected",
      "observed-slot-change",
      "observed-material-change",
      "observed-external-spool",
      "observed-color-assignment-change",
    ]);
  });
});
