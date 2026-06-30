import type { TranslateService } from '@ngx-translate/core';

let translateServiceRef: Pick<TranslateService, 'instant'> | null = null;

export function setChatTranslateService(translate: Pick<TranslateService, 'instant'> | null | undefined): void {
  translateServiceRef = translate ?? null;
}

export function chatI18n(
  key: string,
  params?: Record<string, unknown>,
  fallback?: string,
): string {
  const translated = translateServiceRef?.instant?.(key, params);
  if (typeof translated === 'string' && translated && translated !== key) {
    return translated;
  }
  return fallback ?? key;
}
