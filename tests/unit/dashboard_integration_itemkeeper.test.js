/**
 * @fileoverview dashboard_integration_itemkeeper.js の単体テスト
 *
 * ペイロード組立（filaments[] per-spool usedMm / state・result / historyScope）、
 * エンベロープ schema、Bearer・X-IK-* ヘッダ、テスト送信のレスポンス分岐、
 * 送信ゲート（enabled / per-host ikEnabled / onStart・onFinish）を検証する。
 *
 * 依存モジュールは全て vi.doMock でモックする（dashboard_notification_manager は
 * モジュール読込時に document へ触れるため node 環境では必ずモックすること）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** モック monitorData */
const mockMonitorData = {
  machines: {},
  appSettings: { connectionTargets: [], itemkeeper: {} }
};
/** モックスプール辞書 */
const mockSpools = {
  s1: {
    id: "s1", serialNo: 1, material: "PLA", materialName: "PLA",
    colorName: "Leaf Green", filamentColor: "#2ECC71", brand: "CC3D",
    filamentDiameter: 1.75, density: 1.24, remainingLengthMm: 187400
  },
  s2: {
    id: "s2", serialNo: 2, material: "PETG", colorName: "Blue",
    filamentColor: "#0000FF", brand: "X", filamentDiameter: 1.75,
    density: 1.27, remainingLengthMm: 100000
  }
};

vi.doMock("../../3dp_lib/dashboard_data.js", () => ({
  monitorData: mockMonitorData,
  PLACEHOLDER_HOSTNAME: "_$_NO_MACHINE_$_"
}));
vi.doMock("../../3dp_lib/dashboard_storage.js", () => ({ saveUnifiedStorage: vi.fn() }));
vi.doMock("../../3dp_lib/dashboard_spool.js", () => ({
  getSpoolById: (id) => mockSpools[id] || null,
  getMaterialDensity: () => 1.24,
  weightFromLength: (mm, density, dia) => {
    const r = (dia || 1.75) / 2;
    return Math.PI * r * r * (mm / 1000) * (density || 1.24);
  }
}));
vi.doMock("../../3dp_lib/dashboard_filament_ledger.js", () => ({
  attributedUsed: (job, spoolId) => {
    const fi = (job?.filamentInfo || []).find(f => f.spoolId === spoolId);
    return fi ? fi.usedMm : (job?.materialUsedMm || 0);
  },
  deriveSpoolRemaining: (id) => ({ remainingMm: mockSpools[id]?.remainingLengthMm ?? 0 })
}));
vi.doMock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  notificationManager: {
    getWebhookUrls: () => [], getWebhookIndependent: () => false,
    statusSnapshotEnabled: false, statusSnapshotIntervalSec: 30,
    setWebhookUrls: vi.fn(), setWebhookIndependent: vi.fn(), setStatusSnapshot: vi.fn()
  }
}));

const { ItemKeeperIntegration } = await import("../../3dp_lib/dashboard_integration_itemkeeper.js");

/** 設定済みインスタンスを生成 */
function newIK(settings = {}) {
  const ik = new ItemKeeperIntegration();
  ik.settings = { ...ik.settings, ...settings };
  return ik;
}

/** 履歴ジョブ生成ヘルパー（parse 後スキーマ） */
function job(o) {
  return {
    id: o.id,
    filename: o.filename ?? "a.gcode",
    rawFilename: o.rawFilename ?? "/card/gcodes/a.gcode",
    filemd5: o.filemd5 ?? "abc123",
    startTime: o.startTime ?? "2026-06-08T15:00:00.000Z",
    finishTime: o.finishTime ?? null,
    printfinish: o.printfinish ?? null,
    materialUsedMm: o.materialUsedMm ?? 0,
    filamentId: o.filamentId,
    filamentType: o.filamentType,
    filamentColor: o.filamentColor,
    filamentInfo: o.filamentInfo ?? []
  };
}

beforeEach(() => {
  mockMonitorData.machines = {};
  mockMonitorData.appSettings = { connectionTargets: [], itemkeeper: {} };
});

describe("normalizeEndpoint", () => {
  const ik = newIK();
  it("空入力は空文字", () => expect(ik.normalizeEndpoint("")).toBe(""));
  it("ホストのみ → https + 既定パス", () =>
    expect(ik.normalizeEndpoint("itemkeeper.com")).toBe("https://itemkeeper.com/api/ingest/print-events"));
  it("ホスト:ポート → https + 既定パス", () =>
    expect(ik.normalizeEndpoint("itemkeeper.com:8443")).toBe("https://itemkeeper.com:8443/api/ingest/print-events"));
  it("パス指定済みURLは尊重", () =>
    expect(ik.normalizeEndpoint("https://x.example/custom")).toBe("https://x.example/custom"));
});

describe("buildJob", () => {
  const ik = newIK();
  it("完了・成功ジョブ", () => {
    const j = ik.buildJob(job({
      id: 1700000000, finishTime: "2026-06-08T15:47:30.000Z",
      printfinish: 1, materialUsedMm: 14256,
      filamentInfo: [{ spoolId: "s1", usedMm: 14256 }]
    }));
    expect(j.jobId).toBe(1700000000);
    expect(j.state).toBe("finished");
    expect(j.result).toBe("success");
    expect(j.printfinish).toBe(1);
    expect(j.materialUsedMm).toBe(14256);
    expect(j.filename).toBe("a.gcode");
    expect(j.filaments).toHaveLength(1);
    expect(j.filaments[0].usedMm).toBe(14256);
  });
  it("進行中ジョブは state=printing / result=null", () => {
    const j = ik.buildJob(job({ id: 1700000100, finishTime: null, printfinish: null }));
    expect(j.state).toBe("printing");
    expect(j.result).toBeNull();
    expect(j.printfinish).toBeNull();
  });
  it("失敗ジョブは result=failed", () => {
    const j = ik.buildJob(job({ id: 1700000200, finishTime: "2026-06-08T16:00:00.000Z", printfinish: 0 }));
    expect(j.result).toBe("failed");
  });
  it("filename 未指定なら rawFilename の basename", () => {
    const j = ik.buildJob({ id: 1, rawFilename: "/card/gcodes/dragon.gcode" });
    expect(j.filename).toBe("dragon.gcode");
  });
});

describe("buildFilaments", () => {
  const ik = newIK();
  it("複数スプール: per-spool usedMm を正しく分配", () => {
    const fil = ik.buildFilaments(job({
      id: 5, materialUsedMm: 1000,
      filamentInfo: [{ spoolId: "s1", usedMm: 300 }, { spoolId: "s2", usedMm: 700 }]
    }));
    expect(fil).toHaveLength(2);
    expect(fil[0].spoolId).toBe("s1");
    expect(fil[0].usedMm).toBe(300);
    expect(fil[0].material).toBe("PLA");
    expect(fil[0].colorHex).toBe("#2ECC71");
    expect(fil[0].brand).toBe("CC3D");
    expect(fil[1].spoolId).toBe("s2");
    expect(fil[1].usedMm).toBe(700);
    expect(fil[0].usedGram).toBeGreaterThan(0);
  });
  it("filamentInfo 欠落の旧ジョブは単一スプールにフォールバック", () => {
    const fil = ik.buildFilaments(job({ id: 6, filamentId: "s1", materialUsedMm: 500, filamentInfo: [] }));
    expect(fil).toHaveLength(1);
    expect(fil[0].spoolId).toBe("s1");
    expect(fil[0].usedMm).toBe(500);
  });
  it("§6.6 必須フィールドが揃う", () => {
    const fil = ik.buildFilaments(job({ id: 7, filamentInfo: [{ spoolId: "s1", usedMm: 100 }] }));
    const f = fil[0];
    expect(f).toHaveProperty("material");
    expect(f).toHaveProperty("colorHex");
    expect(f).toHaveProperty("spoolId");
    expect(f).toHaveProperty("usedMm");
  });
});

describe("buildSnapshot", () => {
  beforeEach(() => {
    mockMonitorData.appSettings.connectionTargets = [
      { dest: "192.168.1.5:9999", hostname: "k1", label: "1号機", ikDeviceAlias: "1号機", macAddress: "fc:ee:28:11:22:33" },
      { dest: "192.168.1.6:9999", hostname: "k2", label: "2号機", ikEnabled: false }
    ];
    mockMonitorData.machines.k1 = {
      storedData: { model: { rawValue: "K1 Max" } },
      printStore: {
        history: [
          job({ id: 1700000000, finishTime: "2026-06-08T15:47:30.000Z", printfinish: 1, materialUsedMm: 1000, filamentInfo: [{ spoolId: "s1", usedMm: 1000 }] }),
          job({ id: 1700000500, finishTime: "2026-06-08T16:47:30.000Z", printfinish: 1, materialUsedMm: 2000, filamentInfo: [{ spoolId: "s1", usedMm: 2000 }] })
        ]
      }
    };
    mockMonitorData.machines.k2 = { storedData: {}, printStore: { history: [job({ id: 1700000900, materialUsedMm: 5 })] } };
  });

  it("エンベロープ schema と機器配列", () => {
    const ik = newIK();
    const snap = ik.buildSnapshot("print.finished", "k1");
    expect(snap.schema).toBe("3dpmon.ik.history.v1");
    expect(snap.trigger.event).toBe("print.finished");
    expect(snap.trigger.deviceKey).toBe("1号機");
    expect(Array.isArray(snap.devices)).toBe(true);
  });
  it("ikEnabled=false の機器を除外する", () => {
    const ik = newIK();
    const snap = ik.buildSnapshot("print.finished", "k1");
    expect(snap.devices).toHaveLength(1);
    expect(snap.devices[0].deviceKey).toBe("1号機");
  });
  it("device メタ（alias/hostname/ip/mac/model）", () => {
    const ik = newIK();
    const d = ik.buildSnapshot("print.finished", "k1").devices[0];
    expect(d.device.hostname).toBe("k1");
    expect(d.device.ip).toBe("192.168.1.5");
    expect(d.device.mac).toBe("fc:ee:28:11:22:33");
    expect(d.device.model).toBe("K1 Max");
    expect(d.jobs).toHaveLength(2);
  });
  it("historyScope=recent:1 で直近1件のみ", () => {
    const ik = newIK({ historyScope: "recent:1" });
    const d = ik.buildSnapshot("print.finished", "k1").devices[0];
    expect(d.jobs).toHaveLength(1);
    expect(d.jobs[0].jobId).toBe(1700000500); // id が大きい方
  });
});

describe("buildHeaders", () => {
  it("Bearer と X-IK-* を付与", () => {
    const ik = newIK({ clientId: "cid", secret: "sec" });
    const h = ik.buildHeaders("print.finished");
    expect(h.Authorization).toBe("Bearer cid.sec");
    expect(h["X-IK-Encoding"]).toBe("none");
    expect(h["X-IK-Trigger"]).toBe("print.finished");
    expect(h["X-IK-Nonce"]).toBeTruthy();
    expect(h["X-IK-Request-Id"]).toBeTruthy();
    expect(h["X-IK-Timestamp"]).toMatch(/^\d+$/);
  });
});

describe("testConnection（fetch モック）", () => {
  it("2xx で成功", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const ik = newIK();
    const cb = vi.fn();
    await ik.testConnection({ endpoint: "itemkeeper.com", clientId: "c", secret: "s" }, cb);
    expect(cb).toHaveBeenCalledWith(true, expect.stringContaining("200"));
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer c.s");
    expect(opts.headers["X-IK-Trigger"]).toBe("ingest.test");
  });
  it("401 は認証エラー", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401 }));
    const ik = newIK();
    const cb = vi.fn();
    await ik.testConnection({ endpoint: "itemkeeper.com", clientId: "c", secret: "s" }, cb);
    expect(cb).toHaveBeenCalledWith(false, expect.stringContaining("認証エラー"));
  });
  it("URL 未設定はエラー", async () => {
    const ik = newIK();
    const cb = vi.fn();
    await ik.testConnection({ endpoint: "", clientId: "c", secret: "s" }, cb);
    expect(cb).toHaveBeenCalledWith(false, expect.stringContaining("URL"));
  });
});

describe("送信ゲート", () => {
  it("enabled=false なら sendSnapshot は skipped", async () => {
    const ik = newIK({ enabled: false });
    const r = await ik.sendSnapshot({ trigger: "print.started", host: "k1" });
    expect(r.skipped).toBe(true);
  });
  it("onStart=false なら開始イベントで送らない", () => {
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", onStart: false });
    const spy = vi.spyOn(ik, "sendSnapshot").mockResolvedValue({ ok: true });
    ik.onPrintEvent("k1", "started");
    expect(spy).not.toHaveBeenCalled();
  });
  it("per-host ikEnabled=false なら送らない", () => {
    mockMonitorData.appSettings.connectionTargets = [{ dest: "d", hostname: "k1", ikEnabled: false }];
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", onFinish: true });
    const spy = vi.spyOn(ik, "sendSnapshot").mockResolvedValue({ ok: true });
    ik.onPrintEvent("k1", "finished");
    expect(spy).not.toHaveBeenCalled();
  });
  it("条件を満たせば finished で sendSnapshot 呼び出し", () => {
    mockMonitorData.appSettings.connectionTargets = [{ dest: "d", hostname: "k1" }];
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", onFinish: true });
    const spy = vi.spyOn(ik, "sendSnapshot").mockResolvedValue({ ok: true });
    ik.onPrintEvent("k1", "finished");
    expect(spy).toHaveBeenCalledWith({ trigger: "print.finished", host: "k1" });
  });
});

describe("一時停止トリガ (onPause)", () => {
  it("onPause=false なら一時停止で送らない", () => {
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", onPause: false });
    const spy = vi.spyOn(ik, "sendSnapshot").mockResolvedValue({ ok: true });
    ik.onPrintEvent("k1", "paused");
    expect(spy).not.toHaveBeenCalled();
  });
  it("onPause=true なら print.paused トリガで送る", () => {
    mockMonitorData.appSettings.connectionTargets = [{ dest: "d", hostname: "k1" }];
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", onPause: true });
    const spy = vi.spyOn(ik, "sendSnapshot").mockResolvedValue({ ok: true });
    ik.onPrintEvent("k1", "paused");
    expect(spy).toHaveBeenCalledWith({ trigger: "print.paused", host: "k1" });
  });
});

describe("指定タイミング定期送信 (onInterval)", () => {
  it("onInterval=false ならタイマー無し", () => {
    const ik = newIK({ enabled: true, onInterval: false });
    ik._restartIntervalTimer();
    expect(ik._intervalTimer).toBeNull();
  });
  it("enabled+onInterval でタイマー作動し snapshot.interval を送る", () => {
    vi.useFakeTimers();
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", onInterval: true, intervalMin: 1 });
    const spy = vi.spyOn(ik, "sendSnapshot").mockResolvedValue({ ok: true });
    ik._restartIntervalTimer();
    expect(ik._intervalTimer).not.toBeNull();
    vi.advanceTimersByTime(60 * 1000);
    expect(spy).toHaveBeenCalledWith({ trigger: "snapshot.interval" });
    clearInterval(ik._intervalTimer);
    vi.useRealTimers();
  });
});
