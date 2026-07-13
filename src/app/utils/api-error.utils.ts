import { TranslateService } from '@ngx-translate/core';

type TranslationLike = Pick<TranslateService, 'instant'>;

export interface ApiErrorDetails {
  errorCode: string | null;
  errorArgs: Record<string, unknown>;
  message: string;
}

interface ResolveApiErrorMessageOptions {
  fallbackMessage?: string;
  translationPrefix?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeText(item))
      .filter(Boolean)
      .join(', ')
      .trim();
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  return '';
}

function extractPayload(source: unknown): Record<string, unknown> | null {
  if (!isRecord(source)) {
    return null;
  }

  if (isRecord(source['error'])) {
    return source['error'];
  }

  return source;
}

function getNestedPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }

  for (const key of ['detail', 'data', 'error']) {
    if (isRecord(payload[key])) {
      return payload[key];
    }
  }

  return null;
}

export function extractApiErrorDetails(source: unknown, fallbackMessage = ''): ApiErrorDetails {
  const payload = extractPayload(source);
  const nestedPayload = getNestedPayload(payload);
  const errorCode = normalizeText(
    payload?.['errorCode']
      ?? payload?.['error_code']
      ?? nestedPayload?.['errorCode']
      ?? nestedPayload?.['error_code'],
  ) || null;
  const errorArgs = isRecord(payload?.['errorArgs'])
    ? payload['errorArgs']
    : isRecord(payload?.['error_args'])
      ? payload['error_args']
      : isRecord(nestedPayload?.['errorArgs'])
        ? nestedPayload['errorArgs']
        : isRecord(nestedPayload?.['error_args'])
          ? nestedPayload['error_args']
          : {};

  const sourceMessage = normalizeText(isRecord(source) ? source['message'] : undefined);
  const payloadMessage = normalizeText(
    payload?.['errorMessage']
      ?? payload?.['error_message']
      ?? payload?.['messages']
      ?? payload?.['message']
      ?? payload?.['detail'],
  );
  const nestedMessage = normalizeText(
    nestedPayload?.['errorMessage']
      ?? nestedPayload?.['error_message']
      ?? nestedPayload?.['messages']
      ?? nestedPayload?.['message']
      ?? nestedPayload?.['detail'],
  );

  const message = payloadMessage
    || nestedMessage
    || sourceMessage
    || fallbackMessage;

  return {
    errorCode,
    errorArgs,
    message,
  };
}

export function createApiError(source: unknown, fallbackMessage = ''): ApiErrorDetails & { raw: unknown; status?: number } {
  const details = extractApiErrorDetails(source, fallbackMessage);
  const payload = extractPayload(source);
  const status = isRecord(source) && typeof source['status'] === 'number'
    ? source['status']
    : typeof payload?.['status'] === 'number'
      ? payload['status']
      : undefined;

  return {
    ...details,
    raw: source,
    status,
  };
}

export function resolveTranslatedApiErrorMessage(
  source: unknown,
  translate?: TranslationLike | null,
  options: ResolveApiErrorMessageOptions = {},
): string {
  const { fallbackMessage = '', translationPrefix = 'AUTH_ERRORS' } = options;
  const details = extractApiErrorDetails(source, fallbackMessage);

  if (translate && details.errorCode) {
    const translationKey = `${translationPrefix}.${details.errorCode}`;
    const translated = normalizeText(translate.instant(translationKey, details.errorArgs));
    if (translated && translated !== translationKey) {
      return translated;
    }
  }

  return details.message || fallbackMessage;
}
