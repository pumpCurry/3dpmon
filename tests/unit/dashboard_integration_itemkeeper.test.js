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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
  formatSpoolDisplayId: (sp) => "#" + String(sp?.serialNo || 0).padStart(3, "0"),
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
/** printmanager.getFileList を mock（_attachFiles の動的 import が解決する） */
const mockFiles = {};
vi.doMock("../../3dp_lib/dashboard_printmanager.js", () => ({
  getFileList: (host) => mockFiles[host] || []
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

describe("カメラ画像添付 (attachCamera / device.camera)", () => {
  beforeEach(() => {
    mockMonitorData.appSettings.connectionTargets = [
      { dest: "192.168.1.5:9999", hostname: "k1", label: "1号機", ikDeviceAlias: "1号機" },
      { dest: "192.168.1.6:9999", hostname: "k2", label: "2号機", ikCamera: false }
    ];
    mockMonitorData.machines.k1 = { storedData: {}, printStore: { history: [job({ id: 1700000000, materialUsedMm: 10 })] } };
    mockMonitorData.machines.k2 = { storedData: {}, printStore: { history: [job({ id: 1700000900, materialUsedMm: 5 })] } };
  });

  it("既定では attachCamera は false（下位互換）", () => {
    const ik = newIK();
    expect(ik.settings.attachCamera).toBe(false);
  });

  it("buildSnapshot 自体は camera を付けない（純粋・同期のまま）", () => {
    const ik = newIK({ attachCamera: true });
    const snap = ik.buildSnapshot("print.finished", "k1");
    expect(snap.devices.every(d => d.camera === undefined)).toBe(true);
  });

  it("_attachCameras は取得成功機に device.camera を付与する", async () => {
    const ik = newIK({ attachCamera: true });
    vi.spyOn(ik, "_captureCamera").mockResolvedValue({
      mime: "image/jpeg", dataBase64: "AAAA", bytes: 3, capturedAt: "2026-06-17T00:00:00.000Z"
    });
    const snap = ik.buildSnapshot("print.finished", "k1");
    await ik._attachCameras(snap);
    const d = snap.devices.find(x => x.device.hostname === "k1");
    expect(d.camera).toEqual({
      mime: "image/jpeg", dataBase64: "AAAA", bytes: 3, capturedAt: "2026-06-17T00:00:00.000Z"
    });
  });

  it("機器別 ikCamera=false の機器は camera を付与しない", async () => {
    const ik = newIK({ attachCamera: true });
    const spy = vi.spyOn(ik, "_captureCamera").mockResolvedValue({ mime: "image/jpeg", dataBase64: "AAAA", bytes: 3, capturedAt: "x" });
    const snap = ik.buildSnapshot("print.finished", "k1"); // k2 は ikCamera=false（ただし ikEnabled は既定ON）
    await ik._attachCameras(snap);
    const k2 = snap.devices.find(x => x.device.hostname === "k2");
    expect(k2.camera).toBeUndefined();
    // k1 は対象なので _captureCamera が呼ばれている
    expect(spy).toHaveBeenCalledWith("k1");
    expect(spy).not.toHaveBeenCalledWith("k2");
  });

  it("取得失敗(null)の機器は camera を省略する（JSON は valid）", async () => {
    const ik = newIK({ attachCamera: true });
    vi.spyOn(ik, "_captureCamera").mockResolvedValue(null);
    const snap = ik.buildSnapshot("print.finished", "k1");
    await ik._attachCameras(snap);
    expect(snap.devices.every(d => d.camera === undefined)).toBe(true);
  });

  it("_captureCamera は Electron IPC(getCameraSnapshot) の結果を camera 化する", async () => {
    const ik = newIK({ attachCamera: true });
    const prevWindow = globalThis.window;
    globalThis.window = { electronAPI: { getCameraSnapshot: vi.fn().mockResolvedValue({ mime: "image/jpeg", dataBase64: "Zm9v", bytes: 3 }) } };
    try {
      const cam = await ik._captureCamera("k1");
      expect(globalThis.window.electronAPI.getCameraSnapshot).toHaveBeenCalledWith("k1");
      expect(cam.dataBase64).toBe("Zm9v");
      expect(cam.mime).toBe("image/jpeg");
      expect(cam.bytes).toBe(3);
      expect(typeof cam.capturedAt).toBe("string");
    } finally {
      globalThis.window = prevWindow;
    }
  });

  it("attachCamera=ON のとき sendSnapshot は _attachCameras を呼ぶ", async () => {
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", attachCamera: true });
    const attach = vi.spyOn(ik, "_attachCameras").mockResolvedValue();
    vi.spyOn(ik, "_post").mockResolvedValue({ ok: true });
    await ik.sendSnapshot({ trigger: "print.finished", host: "k1" });
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("attachCamera=OFF のとき sendSnapshot は _attachCameras を呼ばない", async () => {
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", attachCamera: false });
    const attach = vi.spyOn(ik, "_attachCameras").mockResolvedValue();
    vi.spyOn(ik, "_post").mockResolvedValue({ ok: true });
    await ik.sendSnapshot({ trigger: "print.finished", host: "k1" });
    expect(attach).not.toHaveBeenCalled();
  });
});

describe("状態パネル添付 (attachState / device.state)", () => {
  beforeEach(() => {
    mockMonitorData.appSettings.connectionTargets = [
      { dest: "192.168.1.5:9999", hostname: "k1", label: "1号機", ikDeviceAlias: "1号機" }
    ];
    mockMonitorData.machines.k1 = {
      storedData: {
        nozzleTemp: { rawValue: 215.34, computedValue: { value: "215.3", unit: "℃" } },
        state:      { rawValue: 1, computedValue: "印刷中" },
        bare:       { rawValue: 42, computedValue: null }
      },
      printStore: { history: [job({ id: 1700000000, materialUsedMm: 10 })] }
    };
  });

  it("既定では attachState/attachFiles/attachFileThumbs は false（下位互換）", () => {
    const ik = newIK();
    expect(ik.settings.attachState).toBe(false);
    expect(ik.settings.attachFiles).toBe(false);
    expect(ik.settings.attachFileThumbs).toBe(false);
  });

  it("_buildState は raw＋正規化(value/unit/text)を併記する", () => {
    const ik = newIK();
    const st = ik._buildState("k1");
    expect(st.fields.nozzleTemp).toEqual({ raw: 215.34, value: "215.3", unit: "℃", text: "215.3℃" });
    expect(st.fields.state).toEqual({ raw: 1, value: "印刷中", unit: "", text: "印刷中" });
    // computedValue=null は raw を value に流用、unit 無し
    expect(st.fields.bare).toEqual({ raw: 42, value: "42", unit: "", text: "42" });
    expect(typeof st.capturedAt).toBe("string");
  });

  it("_attachState は各 device に state を付与する", () => {
    const ik = newIK();
    const snap = ik.buildSnapshot("print.finished", "k1");
    ik._attachState(snap);
    const d = snap.devices.find(x => x.device.hostname === "k1");
    expect(d.state.fields.nozzleTemp.text).toBe("215.3℃");
  });

  it("attachState=ON のとき sendSnapshot は _attachState を呼ぶ", async () => {
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", attachState: true });
    const spy = vi.spyOn(ik, "_attachState");
    vi.spyOn(ik, "_post").mockResolvedValue({ ok: true });
    await ik.sendSnapshot({ trigger: "print.finished", host: "k1" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("ファイル一覧添付 (attachFiles / device.files)", () => {
  beforeEach(() => {
    for (const k of Object.keys(mockFiles)) delete mockFiles[k];
    mockMonitorData.appSettings.connectionTargets = [
      { dest: "192.168.1.5:9999", hostname: "k1", label: "1号機", ikDeviceAlias: "1号機" }
    ];
    mockMonitorData.machines.k1 = { storedData: {}, printStore: { history: [job({ id: 1700000000, materialUsedMm: 10 })] } };
  });

  it("_attachFiles は getFileList を整形して device.files に付与する", async () => {
    mockFiles.k1 = [
      { basename: "a.gcode", filename: "/card/gcodes/a.gcode", size: 1234, layer: 100, mtime: new Date(1700000000000), expect: 5000, thumbUrl: "http://192.168.1.5/downloads/a.png" }
    ];
    const ik = newIK();
    const snap = ik.buildSnapshot("print.finished", "k1");
    await ik._attachFiles(snap, false);
    const d = snap.devices.find(x => x.device.hostname === "k1");
    expect(d.files.items).toHaveLength(1);
    expect(d.files.items[0]).toMatchObject({
      name: "a.gcode", path: "/card/gcodes/a.gcode", sizeBytes: 1234, layer: 100, expectMm: 5000,
      modifiedSec: 1700000000, thumbnailUrl: "http://192.168.1.5/downloads/a.png"
    });
    expect(d.files.items[0].thumbnail).toBeUndefined(); // withThumbs=false
  });

  it("ファイル一覧が空の機器は files を付けない", async () => {
    const ik = newIK();
    const snap = ik.buildSnapshot("print.finished", "k1");
    await ik._attachFiles(snap, false);
    const d = snap.devices.find(x => x.device.hostname === "k1");
    expect(d.files).toBeUndefined();
  });

  it("withThumbs=true は IPC(getImageBase64) 結果を thumbnail に入れる", async () => {
    mockFiles.k1 = [
      { basename: "a.gcode", filename: "/card/gcodes/a.gcode", size: 1, thumbUrl: "http://192.168.1.5/downloads/a.png" }
    ];
    const prevWindow = globalThis.window;
    globalThis.window = { electronAPI: { getImageBase64: vi.fn().mockResolvedValue({ mime: "image/png", dataBase64: "Zm9v", bytes: 3 }) } };
    try {
      const ik = newIK();
      const snap = ik.buildSnapshot("print.finished", "k1");
      await ik._attachFiles(snap, true);
      const it = snap.devices.find(x => x.device.hostname === "k1").files.items[0];
      expect(globalThis.window.electronAPI.getImageBase64).toHaveBeenCalledWith("k1", "/downloads/a.png");
      expect(it.thumbnail).toEqual({ mime: "image/png", dataBase64: "Zm9v", bytes: 3 });
    } finally {
      globalThis.window = prevWindow;
    }
  });

  it("attachFiles=ON のとき sendSnapshot は _attachFiles を呼ぶ", async () => {
    mockFiles.k1 = [{ basename: "a.gcode", filename: "/card/gcodes/a.gcode", size: 1 }];
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", attachFiles: true });
    const spy = vi.spyOn(ik, "_attachFiles");
    vi.spyOn(ik, "_post").mockResolvedValue({ ok: true });
    await ik.sendSnapshot({ trigger: "print.finished", host: "k1" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.anything(), false); // attachFileThumbs 既定OFF
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

describe("フィラメント更新履歴添付 (attachFilamentHistory)", () => {
  beforeEach(() => {
    mockMonitorData.appSettings.connectionTargets = [
      { dest: "192.168.1.5:9999", hostname: "k1", label: "1号機", ikDeviceAlias: "1号機" }
    ];
    mockMonitorData.machines.k1 = { storedData: {}, printStore: { history: [job({ id: 1700000000, materialUsedMm: 10 })] } };
    mockMonitorData.filamentSpools = [
      { id: "s1", serialNo: 1, name: "緑PLA", materialName: "PLA", colorName: "Leaf Green", filamentColor: "#2ECC71",
        manufacturerName: "CC3D", filamentDiameter: 1.75, density: 1.24, totalLengthMm: 330000, remainingLengthMm: 187400,
        printCount: 3, isActive: true, hostname: "k1", usedLengthLog: [{ jobId: 1700000000, used: 14256 }] },
      { id: "s9", serialNo: 9, name: "削除済", deleted: true }
    ];
    mockMonitorData.mountHistory = [
      { evId: "mount_s1_1", ts: 1700000000000, type: "mount", host: "k1", spoolId: "s1", anchorRemainingMm: 200000, sinceJobId: 0 },
      { evId: "unmount_s0_0", ts: 1699000000000, type: "unmount", host: "k2", spoolId: "s0", untilJobId: 1699 }
    ];
    mockMonitorData.filamentEventContext = {
      k1: { evId: "fctx_k1_1", ts: 1700000500000, stateAtEvent: 5, oldSpoolId: "s1", oldRemainingMm: 1000,
        oldRemainingPct: 0.5, runout: true, resolved: false, resolution: null, jobIdAtEvent: 1700000000 }
    };
  });

  it("既定で attachFilamentHistory は false（下位互換）", () => {
    expect(newIK().settings.attachFilamentHistory).toBe(false);
  });

  it("_buildSpoolRegistry は画面識別子(#NNN/name)＋消費ログを含み削除済を除外", () => {
    const reg = newIK()._buildSpoolRegistry();
    expect(reg).toHaveLength(1); // s9(deleted) 除外
    expect(reg[0]).toMatchObject({
      spoolId: "s1", serialNo: 1, serialDisplay: "#001", name: "緑PLA",
      material: "PLA", colorName: "Leaf Green", colorHex: "#2ECC71", brand: "CC3D",
      remainingLengthMm: 187400, isActive: true, hostname: "k1"
    });
    expect(reg[0].usedLengthLog).toEqual([{ jobId: "1700000000", usedMm: 14256 }]);
  });

  it("_attachFilamentHistory はトップレベル filaments[]＋各機 filamentHistory を付与(host別)", () => {
    const ik = newIK();
    const snap = ik.buildSnapshot("print.finished", "k1");
    ik._attachFilamentHistory(snap);
    expect(Array.isArray(snap.spools)).toBe(true);
    expect(snap.spools[0].serialDisplay).toBe("#001");
    const d = snap.devices.find(x => x.device.hostname === "k1");
    expect(d.filamentHistory.mountHistory).toHaveLength(1); // k2分は除外
    expect(d.filamentHistory.mountHistory[0]).toMatchObject({ type: "mount", spoolId: "s1", anchorRemainingMm: 200000, sinceJobId: "0" });
    expect(d.filamentHistory.events).toHaveLength(1);
    expect(d.filamentHistory.events[0]).toMatchObject({ oldSpoolId: "s1", runout: true, resolved: false });
  });

  it("attachFilamentHistory=ON のとき sendSnapshot は _attachFilamentHistory を呼ぶ", async () => {
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", attachFilamentHistory: true });
    const spy = vi.spyOn(ik, "_attachFilamentHistory");
    vi.spyOn(ik, "_post").mockResolvedValue({ ok: true });
    await ik.sendSnapshot({ trigger: "print.finished", host: "k1" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ジョブ毎 filaments[] に serialDisplay(#NNN)＋name が入る", () => {
    const fil = newIK().buildFilaments(job({ id: 5, filamentInfo: [{ spoolId: "s1", usedMm: 100, spoolName: "緑PLA" }] }));
    expect(fil[0].serialDisplay).toBe("#001"); // mockSpools s1 serialNo=1
    expect(fil[0].name).toBe("緑PLA");
  });
});

describe("リレー子ガード／親逆反映 (relay mirror)", () => {
  afterEach(() => { delete globalThis.window; });

  it("リレー子(window._3dpmonRelayChild=true)では sendSnapshot が送信せずスキップ", async () => {
    globalThis.window = { _3dpmonRelayChild: true };
    const ik = newIK({ enabled: true, endpoint: "x.com", clientId: "c", secret: "s", onStart: true });
    const r = await ik.sendSnapshot({ trigger: "print.started", host: "k1" });
    expect(r.skipped).toBe("relay-child");
  });

  it("parent/standalone(window未設定)では sendSnapshot のガードを通過する", async () => {
    // window 無し（node）＝ _isRelayChild()=false。enabled だが endpoint 不足で別理由 skip になることを確認
    const ik = newIK({ enabled: true, endpoint: "", clientId: "", secret: "" });
    const r = await ik.sendSnapshot({ trigger: "print.started", host: "k1" });
    expect(r.skipped).toBe(true);   // relay-child ではなく endpoint 不足の skip
    expect(r.skipped).not.toBe("relay-child");
  });

  it("リレー子では定期送信タイマーを起動しない", () => {
    globalThis.window = { _3dpmonRelayChild: true };
    const ik = newIK({ enabled: true, onInterval: true, intervalMin: 1 });
    ik._restartIntervalTimer();
    expect(ik._intervalTimer).toBeNull();
  });

  it("applyRemoteSettings は satellite の設定を親で確定保存する", () => {
    const ik = newIK();
    ik.applyRemoteSettings({
      enabled: true, endpoint: "ik.example.com", clientId: "c", secret: "s",
      attachState: true, attachFiles: true, attachFilamentHistory: true
    });
    expect(ik.settings.enabled).toBe(true);
    expect(ik.settings.attachState).toBe(true);
    expect(ik.settings.attachFilamentHistory).toBe(true);
    expect(ik.settings.encoding).toBe("none");
    // persist で monitorData へ書き込まれる（次回 relay-delta で子へミラー還流する元）
    expect(mockMonitorData.appSettings.itemkeeper.attachState).toBe(true);
    expect(mockMonitorData.appSettings.itemkeeper.attachFilamentHistory).toBe(true);
  });
});
