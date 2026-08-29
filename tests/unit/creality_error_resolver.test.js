import { describe, expect, it, vi } from "vitest";

vi.mock("../../3dp_lib/dashboard_notification_manager.js", () => ({
  showAlert: vi.fn(),
}));

import {
  formatCrealityError,
  resolveCrealityError,
} from "../../3dp_lib/error_catalog/creality_error_resolver.js";
import { dashboardMapping } from "../../3dp_lib/dashboard_ui_mapping.js";

describe("Creality error catalog resolver", () => {
  it("resolves the observed K2 Pro CFS RFID error from raw errcode/key without using K1 code 1001", () => {
    const result = resolveCrealityError({
      printerType: "creality-k2",
      model: "F012",
      features: ["cfs"],
      raw: {
        errcode: 1001,
        key: 2843,
        value: "",
      },
    });

    expect(result.status).toBe("resolved");
    expect(result.canonicalCode).toBe("FS2843");
    expect(result.record.messageJa).toContain("RFIDを読み取れません");
    expect(formatCrealityError({ resolution: result })).toContain("FS2843");
    expect(formatCrealityError({ resolution: result })).not.toContain("使用できないファイル形式");
  });

  it("does not fall back to the K1 numeric namespace when printer type is unknown", () => {
    const result = resolveCrealityError({
      printerType: "unknown",
      raw: {
        errcode: 1001,
        key: 2843,
        value: "",
      },
    });

    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("printer-type-unknown-no-k1-fallback");
    expect(formatCrealityError({ resolution: result })).toContain("未分類のCrealityエラー");
    expect(formatCrealityError({ resolution: result })).not.toContain("使用できないファイル形式");
  });

  it("keeps the legacy K1 numeric path available for K1 status errors", () => {
    const result = resolveCrealityError({
      printerType: "creality-k1",
      model: "K1 Max",
      raw: {
        errcode: 23,
        key: 0,
      },
    });

    expect(result.status).toBe("resolved");
    expect(result.canonicalCode).toBe("23");
    expect(formatCrealityError({ resolution: result })).toContain("Klippy");
  });

  it("formats dashboard errorStatus with canonical Creality OS information when present", () => {
    const resolution = resolveCrealityError({
      printerType: "creality-k2",
      model: "F012",
      features: ["cfs"],
      raw: {
        errcode: 1001,
        key: 2843,
        value: "",
      },
    });

    const display = dashboardMapping.err.process({
      errcode: 1001,
      key: 2843,
      value: "",
      resolvedError: resolution,
    });

    expect(display.value).toContain("FS2843");
    expect(display.value).toContain("RFIDを読み取れません");
    expect(display.value).toContain("raw: errcode=1001, key=2843");
  });
});
