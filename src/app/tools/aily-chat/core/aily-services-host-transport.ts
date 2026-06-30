import type {
  AilyServicesEndpointHeadersLike,
  AilyServicesEndpointTransport,
  AilyServicesEndpointTransportResponse,
  AilyServicesV2Event,
} from 'aily-lex/browser';

interface ElectronAilyServicesStreamPayload {
  type: 'headers' | 'event' | 'error' | 'done' | 'cancelled';
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  event?: AilyServicesV2Event;
  message?: string;
  bodyText?: string;
  code?: string;
}

interface ElectronAilyServicesStreamApi {
  start(data: Record<string, unknown>): Promise<{ ok?: boolean; streamId?: string; error?: string }>;
  cancel(streamId: string): Promise<unknown>;
  onEvent(streamId: string, callback: (payload: ElectronAilyServicesStreamPayload) => void): () => void;
}

class RecordHeaders implements AilyServicesEndpointHeadersLike {
  constructor(private readonly headers: Record<string, string> = {}) {}

  get(name: string): string | null {
    const key = name.toLowerCase();
    return this.headers[key] ?? null;
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private error: unknown;

  constructor(private readonly maxBufferedItems = 20000) {}

  push(item: T): void {
    if (this.closed || this.error) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    if (this.items.length >= this.maxBufferedItems) {
      this.closeWithError(new Error('Aily services host stream queue overflow'));
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  closeWithError(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.error = error;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.error) {
          return Promise.reject(this.error);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function createHostStreamError(payload: ElectronAilyServicesStreamPayload): Error {
  const error = new Error(payload.message || payload.bodyText || 'Aily services host stream failed');
  if (payload.code) {
    (error as Error & { code?: string }).code = payload.code;
  }
  return error;
}

function createResponse(
  ok: boolean,
  status: number,
  headers: Record<string, string> | undefined,
  events: AsyncIterable<AilyServicesV2Event> | undefined,
  text: () => Promise<string>,
): AilyServicesEndpointTransportResponse {
  return {
    ok,
    status,
    headers: new RecordHeaders(headers),
    events,
    text,
  };
}

function getElectronStreamApi(): ElectronAilyServicesStreamApi | null {
  const api = (globalThis as any)?.electronAPI?.ailyServicesStream;
  if (!api || typeof api.start !== 'function' || typeof api.cancel !== 'function' || typeof api.onEvent !== 'function') {
    return null;
  }
  return api;
}

function nextStreamId(requestId?: string): string {
  const suffix = Math.random().toString(16).slice(2);
  return `aily_services_${requestId || 'request'}_${Date.now()}_${suffix}`;
}

export function createElectronAilyServicesTransport(): AilyServicesEndpointTransport | null {
  const api = getElectronStreamApi();
  if (!api) {
    return null;
  }

  return async request => {
    const streamId = nextStreamId(request.requestId);
    const events = new AsyncEventQueue<AilyServicesV2Event>();
    let dispose: (() => void) | undefined;
    let headerState: {
      ok: boolean;
      status: number;
      headers?: Record<string, string>;
    } | undefined;
    let nonOkBodyText = '';
    let settled = false;
    let abortListener: (() => void) | undefined;
    let resolveResponse!: (response: AilyServicesEndpointTransportResponse) => void;
    let rejectResponse!: (reason?: unknown) => void;
    const responsePromise = new Promise<AilyServicesEndpointTransportResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });

    const cleanup = () => {
      if (dispose) {
        dispose();
        dispose = undefined;
      }
      if (request.signal && abortListener) {
        request.signal.removeEventListener('abort', abortListener);
        abortListener = undefined;
      }
    };
    const resolveOnce = (response: AilyServicesEndpointTransportResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveResponse(response);
    };
    const rejectOnce = (reason?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      rejectResponse(reason);
    };

    const finishNonOk = () => {
      if (!headerState || headerState.ok) {
        return;
      }
      resolveOnce(createResponse(false, headerState.status, headerState.headers, undefined, async () => nonOkBodyText));
    };

    dispose = api.onEvent(streamId, payload => {
      if (!payload || typeof payload.type !== 'string') {
        return;
      }
      switch (payload.type) {
        case 'headers':
          headerState = {
            ok: payload.ok !== false,
            status: typeof payload.status === 'number' ? payload.status : 0,
            headers: payload.headers,
          };
          if (headerState.ok) {
            resolveOnce(createResponse(true, headerState.status, headerState.headers, events, async () => ''));
          }
          break;
        case 'event':
          if (payload.event) {
            events.push(payload.event);
          }
          break;
        case 'error':
          if (headerState && !headerState.ok) {
            nonOkBodyText = payload.bodyText || payload.message || '';
            finishNonOk();
            events.close();
            cleanup();
            return;
          }
          events.closeWithError(createHostStreamError(payload));
          rejectOnce(createHostStreamError(payload));
          cleanup();
          break;
        case 'cancelled':
          events.close();
          rejectOnce(new DOMException('Aily services host stream cancelled', 'AbortError'));
          cleanup();
          break;
        case 'done':
          if (!headerState) {
            rejectOnce(new Error('Aily services host stream ended before response headers'));
          } else if (!headerState.ok) {
            finishNonOk();
          }
          events.close();
          cleanup();
          break;
      }
    });

    abortListener = () => {
      void api.cancel(streamId);
      events.close();
      cleanup();
    };
    if (request.signal) {
      if (request.signal.aborted) {
        abortListener();
        throw new DOMException('Aily services host stream aborted', 'AbortError');
      }
      request.signal.addEventListener('abort', abortListener, { once: true });
    }

    try {
      const startResult = await api.start({
        streamId,
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        requestId: request.requestId,
      });
      if (!startResult?.ok) {
        throw new Error(startResult?.error || 'Failed to start Aily services host stream');
      }
      return await responsePromise;
    } catch (error) {
      events.closeWithError(error);
      cleanup();
      throw error;
    }
  };
}
