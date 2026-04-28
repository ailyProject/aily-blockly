/**
 * HTTP 错误处理工具函数
 *
 * 从 AilyChatComponent 提取的纯函数集合，用于：
 * - 从复杂的错误对象中提取可读的错误信息
 * - 根据 HTTP 状态码生成友好文案
 */

/**
 * 获取首选的 HTTP 错误消息
 */
export function getPreferredHttpErrorMessage(err: any): string {
  const detailMessage = extractErrorDetailMessage(err);
  if (detailMessage) {
    return detailMessage;
  }
  return getHttpErrorFallbackMessage(err);
}

function isGenericTransportErrorText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  return [
    /\bhttp\s*error\b/i,
    /\brequest failed with status code \d{3}\b/i,
    /\bstatus(?:\s+code)?\s*[:=]?\s*\d{3}\b/i,
    /\bnetwork\s*error\b/i,
    /\bnetworkerror\b/i,
    /^network$/i,
    /\bfailed to fetch\b/i,
    /\bload failed\b/i,
    /\btimeout of \d+ms exceeded\b/i,
    /^timeout$/i
  ].some(pattern => pattern.test(normalized));
}

/**
 * 从错误对象中提取详细错误信息
 */
export function extractErrorDetailMessage(err: any): string {
  if (!err) return '';

  const detailCandidate =
    err?.error ??
    err?.response?.data ??
    err?.data ??
    err?.cause?.error;

  const asObject = detailCandidate && typeof detailCandidate === 'object' ? detailCandidate : null;
  if (asObject) {
    const objectCode = asObject.code;
    const objectMessage =
      asObject.message ??
      asObject.msg ??
      asObject.error_description ??
      asObject.error ??
      asObject.detail;

    if (objectCode !== undefined && objectCode !== null) {
      if (typeof objectMessage === 'string' && objectMessage.trim()) {
        return objectMessage.trim();
      }
    }

    if (typeof objectMessage === 'string' && objectMessage.trim()) {
      return objectMessage.trim();
    }
  }

  const directTextCandidates = [
    err?.detail,
    err?.error?.detail,
    err?.error?.message,
    err?.response?.data?.message,
    err?.response?.data?.detail,
    err?.message,
    typeof err === 'string' ? err : ''
  ];

  for (const candidate of directTextCandidates) {
    if (typeof candidate !== 'string') continue;

    const text = candidate.trim();
    if (!text) continue;

    if (isGenericTransportErrorText(text)) continue;

    return text;
  }

  return '';
}

/**
 * 根据 HTTP 状态码返回 fallback 消息
 */
export function getHttpErrorFallbackMessage(err: any): string {
  const status = extractHttpStatusCode(err);

  const statusMessageMap: Record<number, string> = {
    400: '请求格式错误，请检查。',
    401: '登录已失效，请重新登录。',
    403: '无权限执行该操作。',
    404: '资源不存在，请确认。',
    408: '请求超时，请重试。',
    429: '请求过快，请稍后再试。',
    500: '服务器异常，请稍后再试。',
    502: '服务连接波动，请稍后重试。',
    503: '服务暂时不可用，请稍后重试。',
    504: '服务响应超时，请重试。'
  };

  return statusMessageMap[status] || '网络波动，请重试。';
}

/**
 * 从错误对象中提取 HTTP 状态码
 */
export function extractHttpStatusCode(err: any): number {
  const directCandidate =
    err?.status ??
    err?.statusCode ??
    err?.response?.status ??
    err?.error?.status ??
    err?.error?.statusCode ??
    err?.cause?.status ??
    err?.cause?.statusCode;

  const directStatus = Number(directCandidate);
  if (Number.isFinite(directStatus) && directStatus >= 100 && directStatus <= 599) {
    return directStatus;
  }

  const textCandidates = [
    err?.message,
    err?.error?.message,
    err?.response?.statusText,
    err?.cause?.message,
    typeof err === 'string' ? err : ''
  ].filter(Boolean);

  for (const text of textCandidates) {
    const matched = String(text).match(/\b(?:http\s*error[^\d]*|request failed with status code\s*|status(?:\s+code)?\s*[:=]?\s*)(\d{3})\b/i);
    if (matched?.[1]) {
      return Number(matched[1]);
    }
  }

  const joined = textCandidates.map(v => String(v)).join(' | ').toLowerCase();
  if (
    joined.includes('failed to fetch') ||
    joined.includes('networkerror') ||
    joined.includes('network error') ||
    /\bnetwork\b/.test(joined) ||
    joined.includes('load failed') ||
    joined.includes('timeout')
  ) {
    return 0;
  }

  return 0;
}

/**
 * 判断错误是否为瞬态网络错误（适合自动重试）。
 *
 * 覆盖场景：
 * - TypeError: network / Failed to fetch / Load failed（浏览器 fetch 网络断开）
 * - AbortError 除外（用户主动取消不应重试）
 * - 无 HTTP 状态码或状态码为 0 的错误
 * - HTTP 502/503/504 且 message 含 DNS/连接类关键词（服务重启后短暂不可达）
 */
export function isTransientNetworkError(err: any): boolean {
  if (!err) return false;
  if ((err as Error)?.name === 'AbortError') return false;

  // TypeError (message 包含 network / failed to fetch / load failed)
  if (err instanceof TypeError) {
    const msg = (err.message || '').toLowerCase();
    if (
      msg === 'network' ||
      msg.includes('failed to fetch') ||
      msg.includes('load failed') ||
      msg.includes('network error') ||
      msg.includes('networkerror')
    ) {
      return true;
    }
  }

  // 流读取中途断连（HTTP 200 但 body 未完整传输）
  const errMsg = ((err as Error)?.message || '').toLowerCase();
  if (
    errMsg.includes('err_incomplete_chunked_encoding') ||
    errMsg.includes('net::err_incomplete_chunked_encoding') ||
    errMsg.includes('premature close') ||
    errMsg.includes('err_content_length_mismatch') ||
    errMsg.includes('err_connection_closed') ||
    errMsg.includes('err_http2_protocol_error') ||
    errMsg.includes('aborted') && !(err as Error)?.name?.includes('AbortError')
  ) {
    return true;
  }

  const status = extractHttpStatusCode(err);

  // 502/503/504 且 message 含连接/DNS 类关键词 → 服务暂时不可达
  if (status === 502 || status === 503 || status === 504) {
    const detail = extractErrorDetailMessage(err);
    const msg = (err?.message || '').toLowerCase();
    const combined = `${detail} ${msg}`.toLowerCase();
    if (TRANSIENT_CONNECTIVITY_PATTERNS.some(p => p.test(combined))) {
      return true;
    }
  }

  // 无状态码(0) 代表网络层失败
  if (status === 0) {
    const detail = extractErrorDetailMessage(err);
    // 有明确业务错误信息的不算瞬态网络错误
    if (detail && !isGenericTransportErrorText(detail)) return false;
    return true;
  }

  return false;
}

/** 匹配 DNS/连接层瞬态错误消息的模式 */
const TRANSIENT_CONNECTIVITY_PATTERNS: RegExp[] = [
  /name resolution failed/i,
  /dns/i,
  /econnrefused/i,
  /econnreset/i,
  /enotfound/i,
  /connection refused/i,
  /connection reset/i,
  /socket hang up/i,
  /service(?:.*?)unavailable/i,
  /invalid response.*upstream/i,
  /upstream/i,
  /bad gateway/i,
  /gateway timeout/i,
];

/**
 * 判断 HTTP 错误是否很可能由服务端会话丢失引起（如服务重启后旧 sessionId 失效）。
 *
 * 典型表现：
 * - 404 + code 21001（服务端明确返回 session not found）
 * - 500 + 通用错误消息（"An unexpected error occurred" / "Internal Server Error" 等）
 *   服务端在处理无效 session 时抛出未捕获异常
 *
 * 不匹配有明确业务语义的 500（如 message 包含 token/rate/quota 等关键词）。
 */
export function isLikelySessionLostError(err: any): boolean {
  if (!err) return false;
  const status = extractHttpStatusCode(err);
  const code = err?.code ?? err?.error?.code;

  // 明确的 session not found
  if (status === 404 && code === 21001) return true;

  // 500 + 通用/空消息 → 很可能是会话丢失导致的未处理异常
  if (status === 500) {
    const detail = extractErrorDetailMessage(err);
    if (!detail) return true; // 无消息体
    return SESSION_LOST_GENERIC_PATTERNS.some(p => p.test(detail));
  }

  return false;
}

/** 服务端会话丢失时常见的通用错误消息 */
const SESSION_LOST_GENERIC_PATTERNS: RegExp[] = [
  /^an unexpected error occurred$/i,
  /^internal server error$/i,
  /^unknown error$/i,
  /^unexpected error$/i,
  /^server error$/i,
  /session.*not found/i,
  /session.*expired/i,
  /session.*invalid/i,
  /session.*does not exist/i,
];
