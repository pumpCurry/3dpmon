/**
 * @fileoverview K2 WebRTC camera probe CLI の単体テスト
 *
 * @version 1.390.1392 (PR #432)
 * @since 1.390.1392 (PR #432)
 * @lastModified 2026-08-26 09:48:13
 */

import { describe, expect, it } from "vitest";
import { resolve } from "path";
import {
  __private__,
  buildSignalingUrl,
  parseArgs,
} from "../../scripts/probe_k2_webrtc_camera.mjs";

describe("probe_k2_webrtc_camera", () => {
  it("既定ではK2実機向けの8000/call/webrtc_localをsignalling URLにする", () => {
    const options = parseArgs([]);

    expect(options.host).toBe("192.168.54.153");
    expect(options.signalingUrl).toBe("http://192.168.54.153:8000/call/webrtc_local");
    expect(options.timeoutMs).toBe(30000);
  });

  it("明示signaling-urlはport/path生成より優先する", () => {
    const options = parseArgs([
      "--host", "192.168.54.153",
      "--signaling-port", "443",
      "--signaling-url", "https://192.168.54.153/call/webrtc_local",
    ]);

    expect(options.signalingUrl).toBe("https://192.168.54.153/call/webrtc_local");
  });

  it("hostにURLやportが混ざってもhost部分へ正規化する", () => {
    expect(buildSignalingUrl({
      host: "http://192.168.54.153:4408/#/settings",
      signalingPort: 8000,
    })).toBe("http://192.168.54.153:8000/call/webrtc_local");
    expect(__private__.normalizeHost("192.168.54.153:9999")).toBe("192.168.54.153");
  });

  it("未知optionは実機POST前に拒否する", () => {
    expect(() => parseArgs(["--danger"])).toThrow("Unknown option");
  });

  it("Electron childへ渡す内部pathはproject root相対にする", () => {
    const projectPath = resolve("scripts", "probe_k2_webrtc_camera_electron.js");

    expect(__private__.toProjectRelativePath(projectPath)).toBe("scripts/probe_k2_webrtc_camera_electron.js");
  });

  it("Windowsでは既存E2Eと同じshell経由でElectron shimを起動する", () => {
    const spec = __private__.buildElectronSpawnSpec(
      resolve("node_modules", ".bin", "electron"),
      ["scripts/probe_k2_webrtc_camera_electron.js"]
    );

    if (process.platform === "win32") {
      expect(spec.shell).toBe(true);
      expect(spec.args).toEqual(["scripts/probe_k2_webrtc_camera_electron.js"]);
    } else {
      expect(spec.shell).toBe(false);
    }
  });
});
