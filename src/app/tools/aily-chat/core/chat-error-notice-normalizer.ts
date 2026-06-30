export interface ChatErrorNoticeInput {
  readonly message?: string;
  readonly code?: string;
  readonly details?: unknown;
  readonly metadata?: Record<string, unknown>;
}

export interface NormalizedChatErrorNotice {
  readonly message: string;
  readonly code?: string;
  readonly retryable: boolean;
  readonly metadata?: Record<string, unknown>;
}

const AILY_SERVICES_CODE_RE = /aily-services\s*\[\s*([^\]\s]+)\s*\]/i;

const RETRYABLE_ERROR_CODES = new Set([
  '29001',
  '429',
  '1305',
  'request_failed',
  'rate_limit',
  'rate_limited',
  'provider_rate_limited',
  'upstream_rate_limited',
  'upstream_overloaded',
  'upstream_error',
  'server_overloaded',
]);

export function normalizeChatErrorNotice(input: ChatErrorNoticeInput): NormalizedChatErrorNotice {
  const details = asRecord(input.details) ?? readRecord(input.metadata?.['details']);
  const errorDetails = readRecord(input.metadata?.['errorDetails']);
  const code = firstNonEmptyString(
    input.code,
    input.metadata?.['code'],
    input.metadata?.['errorCode'],
    errorDetails?.['code'],
    errorDetails?.['errorCode'],
    details?.['code'],
    details?.['errorCode'],
    details?.['providerCode'],
    parseAilyServicesCode(input.message),
  );
  const rawMessage = stripAilyServicesPrefix(firstNonEmptyString(input.message, details?.['message']) ?? 'Request failed');
  const providerMessage = readProviderMessage(details, errorDetails);
  const retryable = isRetryableChatErrorCode(code)
    || hasProviderPressureSignal(rawMessage)
    || hasProviderPressureSignal(providerMessage)
    || hasRetryableDetails(details)
    || hasRetryableDetails(errorDetails);
  const message = chooseDisplayMessage(rawMessage, providerMessage, retryable);
  const metadata = buildErrorNoticeMetadata({
    inputMetadata: input.metadata,
    details,
    errorDetails,
    code,
    message,
    rawMessage,
    providerMessage,
    retryable,
  });

  return {
    message,
    code,
    retryable,
    metadata,
  };
}

export function isRetryableChatErrorCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  return RETRYABLE_ERROR_CODES.has(code.trim().toLowerCase());
}

function chooseDisplayMessage(rawMessage: string, providerMessage: string | undefined, retryable: boolean): string {
  if (providerMessage && (!rawMessage || isGenericAilyServicesMessage(rawMessage))) {
    return providerMessage;
  }
  if (providerMessage && hasProviderPressureSignal(providerMessage) && isGenericAilyServicesMessage(rawMessage)) {
    return providerMessage;
  }
  if (retryable && isGenericAilyServicesMessage(rawMessage)) {
    return '模型服务当前访问量较高，请稍后重试。';
  }
  return rawMessage;
}

function buildErrorNoticeMetadata(input: {
  readonly inputMetadata?: Record<string, unknown>;
  readonly details?: Record<string, unknown>;
  readonly errorDetails?: Record<string, unknown>;
  readonly code?: string;
  readonly message: string;
  readonly rawMessage: string;
  readonly providerMessage?: string;
  readonly retryable: boolean;
}): Record<string, unknown> | undefined {
  const base: Record<string, unknown> = input.inputMetadata ? { ...input.inputMetadata } : {};
  if (input.code) {
    base['code'] = input.code;
  }
  if (input.details) {
    base['details'] = input.details;
  }

  const errorDetails: Record<string, unknown> = input.errorDetails ? { ...input.errorDetails } : {};
  if (input.code) {
    errorDetails['code'] = input.code;
  }
  if (input.providerMessage) {
    errorDetails['providerMessage'] = input.providerMessage;
  }
  if (input.rawMessage && input.rawMessage !== input.message) {
    errorDetails['originalMessage'] = input.rawMessage;
  }
  if (input.details && !('details' in errorDetails)) {
    errorDetails['details'] = input.details;
  }
  if (input.retryable) {
    errorDetails['confirmationButtons'] = [
      {
        data: { ailyContinueOnError: true },
        label: '重试',
      },
    ];
  }

  if (Object.keys(errorDetails).length > 0) {
    base['errorDetails'] = errorDetails;
  }

  return Object.keys(base).length > 0 ? base : undefined;
}

function readProviderMessage(...records: Array<Record<string, unknown> | undefined>): string | undefined {
  for (const record of records) {
    if (!record) {
      continue;
    }
    const direct = firstNonEmptyString(
      record['providerMessage'],
      record['upstreamMessage'],
      record['rawMessage'],
      record['displayMessage'],
    );
    if (direct && !isGenericAilyServicesMessage(direct)) {
      return stripAilyServicesPrefix(direct);
    }

    const nestedError = readRecord(record['error']);
    const nestedResponse = readRecord(record['response']);
    const nestedResponseError = readRecord(nestedResponse?.['error']);
    const nestedCause = readRecord(record['cause']);
    const nested = firstNonEmptyString(
      nestedError?.['message'],
      nestedResponseError?.['message'],
      nestedCause?.['message'],
    );
    if (nested && !isGenericAilyServicesMessage(nested)) {
      return stripAilyServicesPrefix(nested);
    }
  }

  return undefined;
}

function hasRetryableDetails(record: Record<string, unknown> | undefined): boolean {
  if (!record) {
    return false;
  }
  const status = firstNonEmptyString(record['status'], record['statusCode'], record['httpStatus'], record['http_status']);
  if (status === '429') {
    return true;
  }
  if (record['rateLimited'] === true || record['retryable'] === true) {
    return true;
  }
  return hasProviderPressureSignal(firstNonEmptyString(
    record['code'],
    record['errorCode'],
    record['providerCode'],
    record['message'],
    record['providerMessage'],
  ));
}

function hasProviderPressureSignal(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const lower = value.toLowerCase();
  return value.includes('访问量过大')
    || value.includes('稍后再试')
    || value.includes('稍后重试')
    || lower.includes('too many requests')
    || lower.includes('rate limit')
    || lower.includes('rate_limited')
    || lower.includes('overload')
    || lower.includes('retry later')
    || lower.includes('try again later');
}

function isGenericAilyServicesMessage(message: string): boolean {
  const trimmed = stripAilyServicesPrefix(message).trim();
  const lower = trimmed.toLowerCase();
  return trimmed === '对话流处理异常，请稍后重试'
    || trimmed === '对话流已中断'
    || trimmed === '请求失败，请稍后重试'
    || lower === 'request failed'
    || lower.includes('dialog stream processing failed')
    || lower.includes('chat stream processing failed');
}

function parseAilyServicesCode(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  return message.match(AILY_SERVICES_CODE_RE)?.[1]?.trim();
}

function stripAilyServicesPrefix(message: string): string {
  return message.replace(AILY_SERVICES_CODE_RE, '').replace(/^[:：]\s*/, '').trim();
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return readRecord(value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
