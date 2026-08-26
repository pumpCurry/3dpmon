/**
 * @fileoverview Printer Core v3 PrinterSession metadata の単体テスト
 */
import { describe, expect, it } from "vitest";
import {
  PRINTER_SESSION_SCHEMA_VERSION,
  clonePrinterSession,
  closePrinterSession,
  createPrinterSession,
} from "../../3dp_lib/printer_core/dashboard_printer_session.js";

describe("Printer Core v3 PrinterSession metadata", () => {
  it("複数transportをread-only metadataとして保持する", () => {
    const session = createPrinterSession({
      deviceId: "serial:k2pro",
      sessionId: "k2-live:test",
      family: "k2",
      adapterId: "k2-adapter",
      protocol: "creality-ws9999",
      openedAt: "2026-08-09T01:00:00.000Z",
      transports: [
        { kind: "ws9999", endpoint: "192.0.2.21:9999", role: "status-stream" },
        { kind: "http-info", endpoint: "192.0.2.21:80", role: "identity-probe" },
        { kind: "ws9999", endpoint: "192.0.2.21:9999", role: "status-stream" },
      ],
      metadata: { source: "unit-test" },
    });

    expect(session).toMatchObject({
      schemaVersion: PRINTER_SESSION_SCHEMA_VERSION,
      deviceId: "serial:k2pro",
      sessionId: "k2-live:test",
      family: "k2",
      adapterId: "k2-adapter",
      protocol: "creality-ws9999",
      status: "active",
      openedAt: "2026-08-09T01:00:00.000Z",
      closedAt: null,
      metadata: { source: "unit-test" },
    });
    expect(session.transports).toEqual([
      {
        kind: "ws9999",
        endpoint: "192.0.2.21:9999",
        role: "status-stream",
        authority: "read-only-observation",
        observedAt: null,
        metadata: {},
      },
      {
        kind: "http-info",
        endpoint: "192.0.2.21:80",
        role: "identity-probe",
        authority: "read-only-observation",
        observedAt: null,
        metadata: {},
      },
    ]);
  });

  it("closeは冪等で、cloneは外部mutationから内部値を守る", () => {
    const session = createPrinterSession({
      deviceId: "serial:k1",
      sessionId: "k1-live:test",
      transports: { kind: "ws9999", metadata: { sequence: 1 } },
    });

    closePrinterSession(session, { closedAt: "2026-08-09T01:00:01.000Z" });
    closePrinterSession(session, { closedAt: "2026-08-09T01:00:02.000Z" });
    const cloned = clonePrinterSession(session);
    cloned.transports[0].metadata.sequence = 999;

    expect(session.status).toBe("closed");
    expect(session.closedAt).toBe("2026-08-09T01:00:01.000Z");
    expect(session.transports[0].metadata.sequence).toBe(1);
  });
});
