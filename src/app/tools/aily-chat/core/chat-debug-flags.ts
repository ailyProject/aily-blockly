const VERBOSE_DEBUG_FLAG = 'aily.chat.verboseDebug';
const VERBOSE_DEBUG_GLOBAL_KEYS = [
  '__AILY_CHAT_VERBOSE_DEBUG__',
  'AILY_CHAT_VERBOSE_DEBUG',
] as const;

export function parseAilyDebugFlag(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1'
      || normalized === 'true'
      || normalized === 'on'
      || normalized === 'yes';
  }
  return false;
}

export function isAilyDebugFlagEnabled(
  localStorageKey: string,
  globalKeys: readonly string[] = [],
): boolean {
  try {
    const runtime = globalThis as Record<string, unknown>;
    for (const key of globalKeys) {
      if (parseAilyDebugFlag(runtime[key])) {
        return true;
      }
    }
    return parseAilyDebugFlag(globalThis.localStorage?.getItem?.(localStorageKey));
  } catch {
    return false;
  }
}

export function isAilyVerboseDebugEnabled(): boolean {
  return isAilyDebugFlagEnabled(VERBOSE_DEBUG_FLAG, VERBOSE_DEBUG_GLOBAL_KEYS);
}

export function isAilyCategoryDebugEnabled(
  localStorageKey: string,
  globalKeys: readonly string[] = [],
): boolean {
  return isAilyVerboseDebugEnabled() || isAilyDebugFlagEnabled(localStorageKey, globalKeys);
}
