function boundedText(value: unknown, maximum = 2_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

/** Map the main application's language code to the Monaco/VS Code language pack id. */
export function toAilyCoderWorkbenchLocale(language: unknown): string | null {
  const normalized = boundedText(language, 40).toLowerCase().replace(/_/g, '-');
  if (!normalized || normalized === 'en' || normalized.startsWith('ar')) return null;
  if (normalized === 'zh' || normalized.startsWith('zh-cn') || normalized.includes('hans')) {
    return 'zh-hans';
  }
  if (
    normalized.startsWith('zh-hk')
    || normalized.startsWith('zh-tw')
    || normalized.includes('hant')
  ) {
    return 'zh-hant';
  }
  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-br';
  return ['de', 'es', 'fr', 'ja', 'ko', 'ru'].includes(normalized) ? normalized : null;
}

/** Stable language identity used to decide whether the embedded Workbench must restart. */
export function normalizeAilyCoderHostLanguage(language: unknown): string {
  const normalized = boundedText(language, 40).toLowerCase().replace(/-/g, '_');
  return normalized || 'en';
}
