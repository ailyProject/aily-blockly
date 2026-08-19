export const SUPPORTED_LANGUAGE_CODES = [
  'zh_cn',
  'zh_hk',
  'en',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'pt',
  'ru',
  'ar',
] as const;

export type SupportedLanguageCode = typeof SUPPORTED_LANGUAGE_CODES[number];

const SUPPORTED_LANGUAGE_CODE_SET = new Set<string>(SUPPORTED_LANGUAGE_CODES);

export function normalizeLanguageCode(language: unknown): SupportedLanguageCode {
  if (typeof language !== 'string' || !language.trim()) {
    return 'zh_cn';
  }

  const normalized = language.trim().toLowerCase().replace(/-/g, '_');
  const parts = normalized.split('_').filter(Boolean);
  const baseLanguage = parts[0];

  if (baseLanguage === 'zh') {
    return parts.some(part => ['hant', 'cht', 'hk', 'tw', 'mo'].includes(part))
      ? 'zh_hk'
      : 'zh_cn';
  }

  return SUPPORTED_LANGUAGE_CODE_SET.has(baseLanguage)
    ? baseLanguage as SupportedLanguageCode
    : 'en';
}
