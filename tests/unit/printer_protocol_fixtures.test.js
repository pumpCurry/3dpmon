/**
 * @fileoverview Printer Core v3 実機 fixture の最小リプレイ検査
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const FIXTURE_ROOT = path.resolve("tests", "fixtures", "printers");
const FIXTURE_VERSION = 1;
const PRIVATE_IPV4_PATTERN = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/u;
const IPV6_PATTERN = /\b(?=(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}\b)(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/iu;
const MAC_PATTERN = /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b|\b[0-9a-f]{2}(?:-[0-9a-f]{2}){5}\b/iu;
const RAW_GCODE_PATTERN = /\b(?!FILE_\d{3}\b)[^/\\:"<>|?*\r\n]+\.g(?:code|co|code3mf)\b/iu;
const SENSITIVE_KEY_PATTERN = /(?:^hostname$|reportedHostname|deviceName|printerName|^sn$|serial|machineId|deviceId|^token$|printId|jobId|taskId|rfid|^mac$|macAddress|wifiMac|ethernetMac)/i;
const REDACTION_TOKEN_PATTERN = /^<[A-Z]+_\d{3}>$/u;
const REDACTED_GCODE_PATTERN = /^<FILE_\d{3}>\.g(?:code|co|code3mf)$/iu;

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

function listFixtureDirs(root) {
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const capturePath = path.join(fullPath, "capture.json");
      if (fs.existsSync(capturePath)) {
        results.push(fullPath);
      }
      results.push(...listFixtureDirs(fullPath));
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isAllowedSensitiveValue(value) {
  if (value === null || value === undefined || value === "") {
    return true;
  }
  if (typeof value === "boolean") {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  return REDACTION_TOKEN_PATTERN.test(value) || REDACTED_GCODE_PATTERN.test(value);
}

function assertNoRawSensitiveValues(value, filePath, keyPath = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawSensitiveValues(entry, filePath, `${keyPath}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, childValue] of Object.entries(value)) {
      const nextPath = keyPath ? `${keyPath}.${key}` : key;
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        expect(isAllowedSensitiveValue(childValue), `${filePath}:${nextPath}`).toBe(true);
      }
      assertNoRawSensitiveValues(childValue, filePath, nextPath);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  expect(value, filePath).not.toMatch(PRIVATE_IPV4_PATTERN);
  expect(value, filePath).not.toMatch(IPV6_PATTERN);
  expect(value, filePath).not.toMatch(MAC_PATTERN);
  expect(value, filePath).not.toMatch(RAW_GCODE_PATTERN);
}

describe("Printer protocol fixtures", () => {
  const eventFiles = listEventFiles(FIXTURE_ROOT);
  const fixtureDirs = listFixtureDirs(FIXTURE_ROOT);

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

  it("capture/metadata/events の3ファイルが同じfixture内容を指している", () => {
    for (const dirPath of fixtureDirs) {
      const capturePath = path.join(dirPath, "capture.json");
      const metadataPath = path.join(dirPath, "metadata.json");
      const eventsPath = path.join(dirPath, "events.ndjson");
      const capture = readJson(capturePath);
      const metadata = readJson(metadataPath);
      const events = readNdjson(eventsPath);

      expect(capture.fixtureVersion, capturePath).toBe(FIXTURE_VERSION);
      expect(capture.metadata, metadataPath).toEqual(metadata);
      expect(capture.events, eventsPath).toEqual(events);
      expect(metadata.fixtureVersion, metadataPath).toBe(FIXTURE_VERSION);
      if (metadata.validation) {
        expect(metadata.validation.eventCount, metadataPath).toBe(events.length);
        expect(typeof metadata.validation.success, metadataPath).toBe("boolean");
        expect(Array.isArray(metadata.validation.failureReasons), metadataPath).toBe(true);
        expect(typeof metadata.validation.observations?.errorCount, metadataPath).toBe("number");
      }
    }
  });

  it("公開fixtureに実環境の識別子が残っていない", () => {
    for (const dirPath of fixtureDirs) {
      const capturePath = path.join(dirPath, "capture.json");
      const metadataPath = path.join(dirPath, "metadata.json");
      const eventsPath = path.join(dirPath, "events.ndjson");

      assertNoRawSensitiveValues(readJson(capturePath), capturePath);
      assertNoRawSensitiveValues(readJson(metadataPath), metadataPath);
      assertNoRawSensitiveValues(readNdjson(eventsPath), eventsPath);
    }
  });
});
