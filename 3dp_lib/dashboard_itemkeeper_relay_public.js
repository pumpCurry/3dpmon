/**
 * R19-a: allowlist for non-authoritative ItemKeeper relay display settings.
 * Never mirror the HTTP ingestion credential pair to readonly/satellite child.
 * This is a UI data boundary, not protection for the parent's persisted secret.
 */
export const RELAY_VISIBLE_ITEMKEEPER_KEYS = Object.freeze([
  "enabled", "endpoint", "encoding", "attachCamera", "attachState",
  "attachFiles", "attachFileThumbs", "attachFilamentHistory",
  "onStart", "onFinish", "onPause", "onInterval", "intervalMin", "historyScope"
]);

export function itemKeeperRelayPublicSettings(settings) {
  const src = settings && typeof settings === "object" ? settings : {};
  const result = {};
  for (const key of RELAY_VISIBLE_ITEMKEEPER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) result[key] = src[key];
  }
  return result;
}
