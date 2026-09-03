import { Injectable } from '@angular/core';
import { AuthService } from '@core/auth/public-api';
import { API } from '../../../configs/api.config';

export const AILY_CODER_EDITOR_CODE_COMPLETION_REQUEST_CHANNEL =
  'aily-coder-editor-code-completion-request';
export const AILY_CODER_EDITOR_CODE_COMPLETION_EVENT_CHANNEL =
  'aily-coder-editor-code-completion-event';

const MAX_COMPLETION_BODY_BYTES = 256 * 1024;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_COMPLETION_ID_LENGTH = 256;

const RESPONSE_HEADER_ALLOWLIST = [
  'content-type',
  'cache-control',
  'retry-after',
  'x-request-id',
  'x-aily-completion-id',
  'x-aily-completion-model',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-completion-quota-limit',
  'x-completion-quota-remaining',
  'x-completion-quota-reset',
] as const;

const FEEDBACK_EVENTS = new Set([
  'shown',
  'partially_accepted',
  'accepted',
  'rejected',
  'ignored',
  'superseded',
]);

type CompletionPayload = {
  opportunityId: string;
  triggerKind: 'automatic' | 'invoke';
  document: {
    languageId: string;
    relativePath?: string;
    version: number;
  };
  position: {
    line: number;
    character: number;
  };
  prefix: string;
  suffix: string;
  selectedCompletionInfo?: {
    text: string;
  };
  context: Array<{
    kind: 'snippet';
    languageId: string;
    relativePath?: string;
    text: string;
  }>;
  capabilities: {
    stream: true;
    partialAccept: boolean;
  };
  client: {
    name: 'aily-coder-editor';
    version: string;
    sessionId: string;
  };
};

type FeedbackPayload = {
  event: string;
  acceptedCharacters?: number;
  opportunityId: string;
};

type CompletionEvent = {
  channel: typeof AILY_CODER_EDITOR_CODE_COMPLETION_EVENT_CHANNEL;
  requestId: string;
  type: 'response' | 'chunk' | 'end' | 'error';
  status?: number;
  headers?: Record<string, string>;
  chunk?: string;
  code?: string;
  message?: string;
};

class CompletionBridgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'CompletionBridgeError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length <= maximum
    ? value
    : undefined;
}

function nonEmptyBoundedString(
  value: unknown,
  maximum: number,
): string | undefined {
  const text = boundedString(value, maximum);
  return text != null && text.length > 0 ? text : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  const requestId = nonEmptyBoundedString(value, MAX_REQUEST_ID_LENGTH);
  return requestId != null && /^[A-Za-z0-9._:-]+$/u.test(requestId)
    ? requestId
    : undefined;
}

function safeRelativePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const relativePath = nonEmptyBoundedString(value, 1024)?.replace(/\\/gu, '/');
  if (
    relativePath == null ||
    relativePath.startsWith('/') ||
    /^[A-Za-z]:\//u.test(relativePath) ||
    relativePath.split('/').includes('..')
  ) {
    return undefined;
  }
  return relativePath;
}

function sanitizeCompletionPayload(
  value: unknown,
  requestId: string,
): CompletionPayload | undefined {
  const payload = asRecord(value);
  const document = asRecord(payload?.['document']);
  const position = asRecord(payload?.['position']);
  const capabilities = asRecord(payload?.['capabilities']);
  const client = asRecord(payload?.['client']);
  if (
    payload?.['opportunityId'] !== requestId ||
    (payload['triggerKind'] !== 'automatic' &&
      payload['triggerKind'] !== 'invoke') ||
    document == null ||
    position == null ||
    capabilities == null ||
    client == null
  ) {
    return undefined;
  }

  const languageId = nonEmptyBoundedString(document['languageId'], 128);
  const documentVersion = nonNegativeInteger(document['version']);
  const line = nonNegativeInteger(position['line']);
  const character = nonNegativeInteger(position['character']);
  const prefix = boundedString(payload['prefix'], 200_000);
  const suffix = boundedString(payload['suffix'], 100_000);
  const clientVersion = nonEmptyBoundedString(client['version'], 64);
  const sessionId = nonEmptyBoundedString(client['sessionId'], 128);
  if (
    languageId == null ||
    documentVersion == null ||
    line == null ||
    character == null ||
    prefix == null ||
    suffix == null ||
    capabilities['stream'] !== true ||
    typeof capabilities['partialAccept'] !== 'boolean' ||
    client['name'] !== 'aily-coder-editor' ||
    clientVersion == null ||
    !/^[A-Za-z0-9._+-]+$/u.test(clientVersion) ||
    sessionId == null
  ) {
    return undefined;
  }

  const rawRelativePath = document['relativePath'];
  const relativePath = safeRelativePath(rawRelativePath);
  if (rawRelativePath !== undefined && relativePath == null) return undefined;

  const selected = asRecord(payload['selectedCompletionInfo']);
  const selectedText =
    selected == null ? undefined : boundedString(selected['text'], 16_384);
  if (payload['selectedCompletionInfo'] !== undefined && selectedText == null)
    return undefined;

  const rawContext = payload['context'];
  if (!Array.isArray(rawContext) || rawContext.length > 32) return undefined;
  const context: CompletionPayload['context'] = [];
  for (const entryValue of rawContext) {
    const entry = asRecord(entryValue);
    const entryLanguageId = nonEmptyBoundedString(entry?.['languageId'], 128);
    const text = boundedString(entry?.['text'], 100_000);
    const rawEntryPath = entry?.['relativePath'];
    const entryPath = safeRelativePath(rawEntryPath);
    if (
      entry?.['kind'] !== 'snippet' ||
      entryLanguageId == null ||
      text == null ||
      (rawEntryPath !== undefined && entryPath == null)
    ) {
      return undefined;
    }
    context.push({
      kind: 'snippet',
      languageId: entryLanguageId,
      ...(entryPath != null ? { relativePath: entryPath } : {}),
      text,
    });
  }

  return {
    opportunityId: requestId,
    triggerKind: payload['triggerKind'],
    document: {
      languageId,
      ...(relativePath != null ? { relativePath } : {}),
      version: documentVersion,
    },
    position: { line, character },
    prefix,
    suffix,
    ...(selectedText != null
      ? { selectedCompletionInfo: { text: selectedText } }
      : {}),
    context,
    capabilities: {
      stream: true,
      partialAccept: capabilities['partialAccept'],
    },
    client: {
      name: 'aily-coder-editor',
      version: clientVersion,
      sessionId,
    },
  };
}

function sanitizeFeedbackPayload(value: unknown): FeedbackPayload | undefined {
  const payload = asRecord(value);
  const event = payload?.['event'];
  const opportunityId = safeRequestId(payload?.['opportunityId']);
  if (
    typeof event !== 'string' ||
    !FEEDBACK_EVENTS.has(event) ||
    opportunityId == null
  ) {
    return undefined;
  }
  const rawAcceptedCharacters = payload?.['acceptedCharacters'];
  const acceptedCharacters =
    rawAcceptedCharacters === undefined
      ? undefined
      : nonNegativeInteger(rawAcceptedCharacters);
  if (rawAcceptedCharacters !== undefined && acceptedCharacters == null)
    return undefined;
  return {
    event,
    ...(acceptedCharacters != null ? { acceptedCharacters } : {}),
    opportunityId,
  };
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name);
    if (value != null) headers[name] = value;
  }
  return headers;
}

function defaultHttpError(status: number): { code: string; message: string } {
  switch (status) {
    case 400:
      return {
        code: 'CODE_COMPLETION_INVALID_REQUEST',
        message: '代码补全请求无效。',
      };
    case 401:
      return {
        code: 'CODE_COMPLETION_UNAUTHORIZED',
        message: '登录状态已失效，请重新登录。',
      };
    case 402:
      return {
        code: 'CODE_COMPLETION_QUOTA_EXCEEDED',
        message: '代码补全额度已用尽。',
      };
    case 403:
      return {
        code: 'CODE_COMPLETION_FORBIDDEN',
        message: '当前账号没有代码补全权限。',
      };
    case 413:
      return {
        code: 'CODE_COMPLETION_REQUEST_TOO_LARGE',
        message: '代码补全上下文过大。',
      };
    case 429:
      return {
        code: 'CODE_COMPLETION_RATE_LIMITED',
        message: '代码补全请求过于频繁。',
      };
    default:
      return {
        code: 'CODE_COMPLETION_UNAVAILABLE',
        message: '代码补全服务暂时不可用。',
      };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

@Injectable()
export class CodeCompletionHostBridgeService {
  private frameWindow: Window | null = null;
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly feedbackRequests = new Set<AbortController>();
  private refreshPromise: Promise<boolean> | null = null;
  private currentClientVersion: string | null = null;
  private disposed = false;

  constructor(private readonly authService: AuthService) {}

  registerFrame(frameWindow: Window | null): void {
    if (this.frameWindow === frameWindow) return;
    this.abortAll();
    this.frameWindow = frameWindow;
    this.currentClientVersion = null;
  }

  handleMessage(event: MessageEvent): boolean {
    const message = asRecord(event.data);
    if (message?.['channel'] !== AILY_CODER_EDITOR_CODE_COMPLETION_REQUEST_CHANNEL) {
      return false;
    }
    const target = this.frameWindow;
    if (this.disposed || target == null || event.source !== target) {
      return false;
    }

    const requestId = safeRequestId(message['requestId']);
    if (requestId == null) {
      this.postError(
        target,
        'invalid-request',
        400,
        'CODE_COMPLETION_INVALID_REQUEST',
        '代码补全请求标识无效。',
      );
      return true;
    }

    switch (message['operation']) {
      case 'complete':
        this.startCompletion(target, requestId, message['payload']);
        break;
      case 'cancel':
        this.cancelCompletion(requestId);
        break;
      case 'feedback':
        this.startFeedback(
          requestId,
          message['completionId'],
          message['payload'],
        );
        break;
      default:
        this.postError(
          target,
          requestId,
          400,
          'CODE_COMPLETION_INVALID_REQUEST',
          '不支持的代码补全操作。',
        );
        break;
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortAll();
    this.frameWindow = null;
    this.currentClientVersion = null;
  }

  private startCompletion(
    target: Window,
    requestId: string,
    rawPayload: unknown,
  ): void {
    const payload = sanitizeCompletionPayload(rawPayload, requestId);
    if (payload == null) {
      this.postError(
        target,
        requestId,
        400,
        'CODE_COMPLETION_INVALID_REQUEST',
        '代码补全请求格式无效。',
      );
      return;
    }

    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).byteLength > MAX_COMPLETION_BODY_BYTES) {
      this.postError(
        target,
        requestId,
        413,
        'CODE_COMPLETION_REQUEST_TOO_LARGE',
        '代码补全上下文超过 256 KiB。',
      );
      return;
    }

    for (const [activeRequestId, controller] of this.activeRequests) {
      if (activeRequestId !== requestId) controller.abort();
    }
    this.activeRequests.get(requestId)?.abort();

    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);
    this.currentClientVersion = payload.client.version;
    void this.runCompletion(
      target,
      requestId,
      payload.client.version,
      body,
      controller,
    ).finally(() => {
      if (this.activeRequests.get(requestId) === controller) {
        this.activeRequests.delete(requestId);
      }
    });
  }

  private async runCompletion(
    target: Window,
    requestId: string,
    clientVersion: string,
    body: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      const response = await this.fetchWithHostAuth(
        API.codeCompletions,
        (token) => ({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            'X-Request-ID': requestId,
            'X-Aily-Client-Version': clientVersion,
          },
          body,
          signal: controller.signal,
        }),
        controller.signal,
      );
      const headers = responseHeaders(response);
      if (!response.ok) {
        const error = await this.readStableHttpError(response);
        this.postError(
          target,
          requestId,
          response.status,
          error.code,
          error.message,
          headers,
        );
        return;
      }
      if (
        !response.headers
          .get('content-type')
          ?.toLowerCase()
          .includes('text/event-stream')
      ) {
        await this.releaseResponseBody(response);
        this.postError(
          target,
          requestId,
          502,
          'INVALID_COMPLETION_STREAM',
          '代码补全服务返回了无效的数据格式。',
          headers,
        );
        return;
      }
      if (response.body == null) {
        this.postError(
          target,
          requestId,
          502,
          'INVALID_COMPLETION_STREAM',
          '代码补全响应缺少数据流。',
          headers,
        );
        return;
      }

      this.postEvent(target, {
        channel: AILY_CODER_EDITOR_CODE_COMPLETION_EVENT_CHANNEL,
        requestId,
        type: 'response',
        status: response.status,
        headers,
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) this.postChunk(target, requestId, chunk);
        }
        const finalChunk = decoder.decode();
        if (finalChunk) this.postChunk(target, requestId, finalChunk);
      } finally {
        reader.releaseLock();
      }

      if (!controller.signal.aborted) {
        this.postEvent(target, {
          channel: AILY_CODER_EDITOR_CODE_COMPLETION_EVENT_CHANNEL,
          requestId,
          type: 'end',
        });
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      const bridgeError =
        error instanceof CompletionBridgeError
          ? error
          : new CompletionBridgeError(
              502,
              'CODE_COMPLETION_NETWORK_ERROR',
              '无法连接代码补全服务。',
            );
      this.postError(
        target,
        requestId,
        bridgeError.status,
        bridgeError.code,
        bridgeError.message,
        bridgeError.headers,
      );
    }
  }

  private cancelCompletion(requestId: string): void {
    const controller = this.activeRequests.get(requestId);
    if (controller == null) return;
    this.activeRequests.delete(requestId);
    controller.abort();
  }

  private startFeedback(
    requestId: string,
    rawCompletionId: unknown,
    rawPayload: unknown,
  ): void {
    const completionId = nonEmptyBoundedString(
      rawCompletionId,
      MAX_COMPLETION_ID_LENGTH,
    );
    const payload = sanitizeFeedbackPayload(rawPayload);
    if (completionId == null || payload == null) return;

    const controller = new AbortController();
    this.feedbackRequests.add(controller);
    const url = `${API.codeCompletions}/${encodeURIComponent(completionId)}/feedback`;
    void this.fetchWithHostAuth(
      url,
      (token) => ({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Request-ID': requestId,
          ...(this.currentClientVersion != null
            ? { 'X-Aily-Client-Version': this.currentClientVersion }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }),
      controller.signal,
    )
      .then((response) => this.releaseResponseBody(response))
      .catch((error) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          console.debug('[CodeCompletionHostBridge] Feedback request failed');
        }
      })
      .finally(() => this.feedbackRequests.delete(controller));
  }

  private async fetchWithHostAuth(
    url: string,
    buildRequest: (token: string) => RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    if (this.authService.isSessionInvalidating) {
      throw new CompletionBridgeError(
        401,
        'CODE_COMPLETION_UNAUTHORIZED',
        '登录状态正在失效。',
      );
    }
    let token = (await this.authService.getToken2())?.trim();
    if (!token) {
      throw new CompletionBridgeError(
        401,
        'CODE_COMPLETION_UNAUTHORIZED',
        '请先登录后再使用代码补全。',
      );
    }

    let response = await fetch(url, buildRequest(token));
    if (response.status !== 401 || signal.aborted) return response;

    await this.releaseResponseBody(response);
    const refreshed = await this.refreshHostToken();
    if (!refreshed || signal.aborted) {
      throw new CompletionBridgeError(
        401,
        'CODE_COMPLETION_UNAUTHORIZED',
        '登录状态已失效，请重新登录。',
      );
    }
    token = (await this.authService.getToken2())?.trim();
    if (!token) {
      throw new CompletionBridgeError(
        401,
        'CODE_COMPLETION_UNAUTHORIZED',
        '刷新登录状态后未取得访问凭证。',
      );
    }
    response = await fetch(url, buildRequest(token));
    return response;
  }

  private refreshHostToken(): Promise<boolean> {
    if (this.refreshPromise != null) return this.refreshPromise;
    const operation = this.authService.refreshAuthToken();
    this.refreshPromise = operation;
    const clear = () => {
      if (this.refreshPromise === operation) this.refreshPromise = null;
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async readStableHttpError(
    response: Response,
  ): Promise<{ code: string; message: string }> {
    const fallback = defaultHttpError(response.status);
    const text = await this.readBoundedBody(response, MAX_ERROR_BODY_BYTES);
    if (!text) return fallback;
    try {
      const record = asRecord(JSON.parse(text));
      const detail = asRecord(record?.['detail']);
      const codeValue =
        record?.['code'] ??
        record?.['errorCode'] ??
        detail?.['code'] ??
        detail?.['errorCode'];
      const messageValue = record?.['message'] ?? detail?.['message'];
      const code =
        typeof codeValue === 'string' &&
        /^[A-Z][A-Z0-9_]{2,63}$/u.test(codeValue)
          ? codeValue
          : fallback.code;
      const normalizedMessage =
        typeof messageValue === 'string'
          ? messageValue.replace(/\s+/gu, ' ').trim()
          : '';
      const message =
        normalizedMessage &&
        normalizedMessage.length <= 240 &&
        !/https?:\/\/|bearer\s|(?:api[_ -]?key)|\bsk-[A-Za-z0-9]/iu.test(
          normalizedMessage,
        )
          ? normalizedMessage
          : fallback.message;
      return { code, message };
    } catch {
      return fallback;
    }
  }

  private async readBoundedBody(
    response: Response,
    maximumBytes: number,
  ): Promise<string> {
    if (response.body == null) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < maximumBytes) {
        const { value, done } = await reader.read();
        if (done) break;
        const remaining = maximumBytes - total;
        const chunk =
          value.byteLength <= remaining ? value : value.slice(0, remaining);
        chunks.push(chunk);
        total += chunk.byteLength;
        if (value.byteLength > remaining) break;
      }
      await reader.cancel();
    } catch {
      return '';
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }

  private async releaseResponseBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      /* Response body may already be consumed or aborted. */
    }
  }

  private postChunk(target: Window, requestId: string, chunk: string): void {
    this.postEvent(target, {
      channel: AILY_CODER_EDITOR_CODE_COMPLETION_EVENT_CHANNEL,
      requestId,
      type: 'chunk',
      chunk,
    });
  }

  private postError(
    target: Window,
    requestId: string,
    status: number,
    code: string,
    message: string,
    headers?: Record<string, string>,
  ): void {
    this.postEvent(target, {
      channel: AILY_CODER_EDITOR_CODE_COMPLETION_EVENT_CHANNEL,
      requestId,
      type: 'error',
      status,
      ...(headers != null ? { headers } : {}),
      code,
      message,
    });
  }

  private postEvent(target: Window, event: CompletionEvent): void {
    if (!this.disposed && this.frameWindow === target) {
      target.postMessage(event, '*');
    }
  }

  private abortAll(): void {
    for (const controller of this.activeRequests.values()) controller.abort();
    this.activeRequests.clear();
    for (const controller of this.feedbackRequests) controller.abort();
    this.feedbackRequests.clear();
  }
}
