/**
 * @fileoverview Printer Core v3 実機 fixture の最小リプレイ検査
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const FIXTURE_ROOT = path.resolve("tests", "fixtures", "printers");

function listEventFiles(root) {
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...listEventFiles(fullPath));
    } else if (entry.isFile() && entry.name === "events.ndjson") {
      results.push(fullPath);
    }
  }
  return results;
}

function readNdjson(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Printer protocol fixtures", () => {
  const eventFiles = listEventFiles(FIXTURE_ROOT);

  it("Gate 0 baseline fixture が存在する", () => {
    const normalized = eventFiles.map((filePath) => filePath.replace(/\\/g, "/"));

    expect(normalized.some((filePath) => filePath.endsWith("k1-max/device-a/events.ndjson"))).toBe(true);
    expect(normalized.some((filePath) => filePath.endsWith("k1-max/device-b/events.ndjson"))).toBe(true);
    expect(normalized.some((filePath) => filePath.endsWith("k2-pro-cfs/events.ndjson"))).toBe(true);
    expect(normalized.some((filePath) => filePath.endsWith("ir3v2/events.ndjson"))).toBe(true);
  });

  it("K1C+CFS-C は外部環境での取得待ちとして明示されている", () => {
    const pendingNote = path.join(FIXTURE_ROOT, "k1c-cfs-c", "README.md");
    const text = fs.readFileSync(pendingNote, "utf8");

    expect(text).toContain("pending");
    expect(text).toContain("separate K1C environment");
  });

  it("全fixtureがsequence順と非減少atMsを保持する", () => {
    for (const filePath of eventFiles) {
      const events = readNdjson(filePath);
      expect(events.length, filePath).toBeGreaterThan(0);

      let previousAtMs = -1;
      events.forEach((event, index) => {
        expect(event.sequence, filePath).toBe(index + 1);
        expect(typeof event.atMs, filePath).toBe("number");
        expect(event.atMs, filePath).toBeGreaterThanOrEqual(previousAtMs);
        expect(["in", "out", "event", "marker"], filePath).toContain(event.direction);
        previousAtMs = event.atMs;
      });
    }
  });

  it("公開fixtureにローカルIPと生MACが残っていない", () => {
    for (const filePath of eventFiles) {
      const text = fs.readFileSync(filePath, "utf8");
      expect(text, filePath).not.toMatch(/192\.168\.54\./u);
      expect(text, filePath).not.toMatch(/\b[0-9A-F]{12}\b/u);
      expect(text, filePath).not.toMatch(/\b[0-9A-F]{2}(?::[0-9A-F]{2}){5}\b/u);
    }
  });
});
