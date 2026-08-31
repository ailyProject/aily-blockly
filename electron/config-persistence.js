const { isDeepStrictEqual } = require('node:util');

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]),
    );
  }
  return value;
}

function mergeRecordChanges(base, next, latest) {
  const result = {};
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(next),
    ...Object.keys(latest),
  ]);

  for (const key of keys) {
    const baseHasKey = Object.prototype.hasOwnProperty.call(base, key);
    const nextHasKey = Object.prototype.hasOwnProperty.call(next, key);
    const latestHasKey = Object.prototype.hasOwnProperty.call(latest, key);

    if (!nextHasKey) {
      if (!baseHasKey && latestHasKey) {
        result[key] = cloneJsonValue(latest[key]);
      }
      continue;
    }

    if (!baseHasKey) {
      result[key] = cloneJsonValue(next[key]);
      continue;
    }

    const baseValue = base[key];
    const nextValue = next[key];
    if (isDeepStrictEqual(baseValue, nextValue)) {
      if (latestHasKey) {
        result[key] = cloneJsonValue(latest[key]);
      }
      continue;
    }

    if (isRecord(baseValue) && isRecord(nextValue)) {
      result[key] = mergeRecordChanges(
        baseValue,
        nextValue,
        latestHasKey && isRecord(latest[key]) ? latest[key] : {},
      );
      continue;
    }

    result[key] = cloneJsonValue(nextValue);
  }

  return result;
}

/**
 * Apply only the fields changed by one renderer to the latest on-disk config.
 * Unchanged fields keep the latest value, preventing a stale BrowserWindow
 * snapshot from reverting settings saved by another window.
 */
function mergeConfigChanges(base, next, latest) {
  if (!isRecord(base) || !isRecord(next) || !isRecord(latest)) {
    throw new TypeError('Config snapshots must be JSON objects');
  }
  return mergeRecordChanges(base, next, latest);
}

module.exports = {
  mergeConfigChanges,
};
