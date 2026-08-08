/**
 * capture_k2_benchy_print.mjs の単体テスト。
 *
 * 実機印刷は行わず、K2 Pro Combo から観測した retGcodeFileInfo2 / boxsInfo 形状に対して
 * Benchy 候補選択と CFS tool source 要約が安定していることを検証する。
 */
import { describe, expect, it } from "vitest";
import {
  extractMatchedTool,
  normalizeK2GcodeFiles,
  parseArgs,
  selectK2GcodeFile,
  summarizeK2ToolSource,
} from "../../scripts/capture_k2_benchy_print.mjs";

describe("capture_k2_benchy_print helpers", () => {
  it("CLI 引数を K2 benchy capture 用の既定値付きで解析する", () => {
    const options = parseArgs([
      "--host",
      "192.0.2.21",
      "--out",
      "tmp/benchy",
      "--allow-mismatched-tool",
    ]);

    expect(options.host).toBe("192.0.2.21");
    expect(options.outDir).toBe("tmp/benchy");
    expect(options.fileContains).toBe("bench");
    expect(options.preferredTool).toBe("T1C");
    expect(options.allowMismatchedTool).toBe(true);
  });

  it("K2 retGcodeFileInfo2 から単色 Benchy を 4color Benchy より優先して選ぶ", () => {
    const payload = {
      retGcodeFileInfo2: [
        {
          name: "4color-3DBench_PLA_31m.gcode",
          path: "/mnt/UDISK/printer_data/gcodes/4color-3DBench_PLA_31m.gcode",
          material: "PLA;PLA;PLA;PLA",
          match: "T1A=T1D T1B=T1A T1C=T1C T1D=T1B ",
        },
        {
          name: "3DBench_PLA_21m.gcode",
          path: "/mnt/UDISK/printer_data/gcodes/3DBench_PLA_21m.gcode",
          material: "PLA",
          match: "T1A=T1B ",
        },
      ],
    };

    const files = normalizeK2GcodeFiles(payload);
    const selected = selectK2GcodeFile(files, { fileContains: "bench" });

    expect(selected.name).toBe("3DBench_PLA_21m.gcode");
    expect(extractMatchedTool(selected, "T1A")).toBe("T1B");
  });

  it("CFS colorMatch から T1C の box/material/color/remaining evidence を要約する", () => {
    const source = summarizeK2ToolSource({
      materialBoxs: [
        { id: 0, type: 1, state: 0, materials: [{ id: 0, percent: 100, state: 1 }] },
        {
          id: 1,
          type: 0,
          state: 1,
          materials: [
            { id: 0, name: "Generic PLA", type: "PLA", color: "#0ffffff", percent: 100, state: 1 },
            { id: 2, name: "Generic PLA-Silk", type: "PLA", color: "#09ea7ae", percent: 100, state: 1 },
          ],
        },
      ],
      colorMatch: [
        { id: "T1A", boxId: 1, materialId: 0 },
        { id: "T1C", boxId: 1, materialId: 2 },
      ],
    }, "T1C");

    expect(source).toEqual({
      toolAlias: "T1C",
      boxId: 1,
      materialId: 2,
      boxType: 0,
      boxState: 1,
      materialName: "Generic PLA-Silk",
      materialType: "PLA",
      color: "#09ea7ae",
      percent: 100,
      materialState: 1,
    });
  });
});
