import { AuthService } from '@core/auth/public-api';
import {
  AILY_CODER_EDITOR_CODE_COMPLETION_EVENT_CHANNEL,
  AILY_CODER_EDITOR_CODE_COMPLETION_REQUEST_CHANNEL,
  CodeCompletionHostBridgeService,
} from './code-completion-host-bridge.service';

type PostedEvent = {
  channel?: string;
  requestId?: string;
  type?: string;
  status?: number;
  headers?: Record<string, string>;
  chunk?: string;
  code?: string;
};

describe('CodeCompletionHostBridgeService', () => {
  let authService: {
    isSessionInvalidating: boolean;
    getToken2: jasmine.Spy;
    refreshAuthToken: jasmine.Spy;
  };
  let service: CodeCompletionHostBridgeService;
  let target: Window;
  let posted: PostedEvent[];
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    authService = {
      isSessionInvalidating: false,
      getToken2: jasmine.createSpy('getToken2').and.resolveTo('host-token'),
      refreshAuthToken: jasmine
        .createSpy('refreshAuthToken')
        .and.resolveTo(true),
    };
    service = new CodeCompletionHostBridgeService(
      authService as unknown as AuthService,
    );
    posted = [];
    target = {
      postMessage: (message: PostedEvent) => posted.push(message),
    } as unknown as Window;
    service.registerFrame(target);
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => service.dispose());

  function completionPayload(
    requestId: string,
    prefix = 'void setup() {',
    suffix = '}',
  ) {
    return {
      opportunityId: requestId,
      triggerKind: 'automatic',
      document: {
        languageId: 'cpp',
        relativePath: 'src/main.cpp',
        version: 3,
      },
      position: { line: 0, character: 14 },
      prefix,
      suffix,
      context: [],
      capabilities: { stream: true, partialAccept: true },
      client: {
        name: 'aily-coder-editor',
        version: '0.1.2',
        sessionId: 'session-1',
      },
    };
  }

  function completionMessage(
    requestId: string,
    payload = completionPayload(requestId),
  ) {
    return {
      channel: AILY_CODER_EDITOR_CODE_COMPLETION_REQUEST_CHANNEL,
      operation: 'complete',
      requestId,
      payload,
    };
  }

  function dispatch(data: unknown, source: Window = target): boolean {
    return service.handleMessage({ data, source } as unknown as MessageEvent);
  }

  async function waitForEvent(
    type: string,
    requestId?: string,
  ): Promise<PostedEvent> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const event = posted.find(
        (item) =>
          item.type === type &&
          (requestId == null || item.requestId === requestId),
      );
      if (event != null) return event;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Timed out waiting for ${type}`);
  }

  function streamingResponse(
    raw: string,
    extraHeaders: Record<string, string> = {},
  ): Response {
    const bytes = new TextEncoder().encode(raw);
    const splitAt = Math.max(1, Math.floor(bytes.byteLength / 2));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        ...extraHeaders,
      },
    });
  }

  it('ignores completion-channel messages from any window except the registered Coder iframe', () => {
    const wrongSource = { postMessage: () => undefined } as unknown as Window;

    expect(dispatch(completionMessage('request-1'), wrongSource)).toBeFalse();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('adds host auth and forwards the decoded SSE text without exposing arbitrary headers', async () => {
    const requestId = 'request-2';
    const rawSse =
      'data: {"id":"completion-1","choices":[{"text":"  你好\\n"}]}\n\ndata: [DONE]\n\n';
    fetchSpy.and.resolveTo(
      streamingResponse(rawSse, {
        'X-Aily-Completion-Id': 'completion-1',
        'X-Provider-Secret': 'must-not-cross-the-bridge',
      }),
    );

    expect(dispatch(completionMessage(requestId))).toBeTrue();
    await waitForEvent('end', requestId);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.calls.mostRecent().args as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(/\/api\/v3\/code\/completions$/);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer host-token');
    expect(headers['Accept']).toBe('text/event-stream');
    expect(headers['X-Request-ID']).toBe(requestId);
    expect(headers['X-Aily-Client-Version']).toBe('0.1.2');
    expect(JSON.parse(String(init.body)).Authorization).toBeUndefined();

    const responseEvent = posted.find((event) => event.type === 'response');
    expect(responseEvent?.headers?.['x-aily-completion-id']).toBe(
      'completion-1',
    );
    expect(responseEvent?.headers?.['x-provider-secret']).toBeUndefined();
    expect(
      posted
        .filter((event) => event.type === 'chunk')
        .map((event) => event.chunk)
        .join(''),
    ).toBe(rawSse);
    expect(JSON.stringify(posted)).not.toContain('host-token');
    expect(posted.at(-1)?.channel).toBe(
      AILY_CODER_EDITOR_CODE_COMPLETION_EVENT_CHANNEL,
    );
  });

  it('releases a 401 body, refreshes once, and retries with the new host token', async () => {
    let firstBodyCanceled = false;
    const firstBody = new ReadableStream<Uint8Array>({
      cancel() {
        firstBodyCanceled = true;
      },
    });
    const responses = [
      new Response(firstBody, { status: 401 }),
      streamingResponse(
        'data: {"id":"completion-2","choices":[{"text":"ok"}]}\n\ndata: [DONE]\n\n',
      ),
    ];
    fetchSpy.and.callFake(async () => responses.shift()!);
    authService.getToken2.and.returnValues(
      Promise.resolve('expired-token'),
      Promise.resolve('fresh-token'),
    );

    dispatch(completionMessage('request-3'));
    await waitForEvent('end', 'request-3');

    expect(firstBodyCanceled).toBeTrue();
    expect(authService.refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchSpy.calls.argsFor(1)[1].headers as Record<
      string,
      string
    >;
    expect(retryHeaders['Authorization']).toBe('Bearer fresh-token');
  });

  it('forwards retry and quota headers on a stable service error', async () => {
    fetchSpy.and.resolveTo(
      new Response(
        JSON.stringify({
          code: 'CODE_COMPLETION_RATE_LIMITED',
          message: '代码补全请求过于频繁。',
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '10',
            'X-Completion-Quota-Reset': 'Wed, 26 Aug 2026 10:00:00 GMT',
            'X-Provider-Secret': 'must-not-cross-the-bridge',
          },
        },
      ),
    );

    dispatch(completionMessage('request-rate-limited'));
    const error = await waitForEvent('error', 'request-rate-limited');

    expect(error).toEqual(
      jasmine.objectContaining({
        status: 429,
        code: 'CODE_COMPLETION_RATE_LIMITED',
      }),
    );
    expect(error.headers?.['retry-after']).toBe('10');
    expect(error.headers?.['x-completion-quota-reset']).toBe(
      'Wed, 26 Aug 2026 10:00:00 GMT',
    );
    expect(error.headers?.['x-provider-secret']).toBeUndefined();
  });

  it('aborts the upstream fetch when Coder cancels the request', async () => {
    let requestSignal: AbortSignal | undefined;
    fetchSpy.and.callFake(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });

    dispatch(completionMessage('request-4'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestSignal?.aborted).toBeFalse();

    dispatch({
      channel: AILY_CODER_EDITOR_CODE_COMPLETION_REQUEST_CHANNEL,
      operation: 'cancel',
      requestId: 'request-4',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestSignal?.aborted).toBeTrue();
    expect(posted.some((event) => event.type === 'error')).toBeFalse();
  });

  it('rejects a request whose UTF-8 JSON body exceeds 256 KiB before calling Services', () => {
    const requestId = 'request-5';
    const payload = completionPayload(
      requestId,
      '中'.repeat(96_000),
      '中'.repeat(32_000),
    );

    dispatch(completionMessage(requestId, payload));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual(
      jasmine.objectContaining({
        requestId,
        type: 'error',
        status: 413,
        code: 'CODE_COMPLETION_REQUEST_TOO_LARGE',
      }),
    );
  });

  it('projects feedback to the allowed metadata fields and URL-encodes the completion id', async () => {
    fetchSpy.and.resolveTo(new Response(null, { status: 204 }));

    dispatch({
      channel: AILY_CODER_EDITOR_CODE_COMPLETION_REQUEST_CHANNEL,
      operation: 'feedback',
      requestId: 'feedback-1',
      completionId: 'completion/one',
      payload: {
        event: 'accepted',
        acceptedCharacters: 12,
        opportunityId: 'request-6',
        source: 'must not be uploaded',
      },
    });
    for (
      let attempt = 0;
      attempt < 100 && fetchSpy.calls.count() === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.calls.mostRecent().args as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(
      /\/api\/v3\/code\/completions\/completion%2Fone\/feedback$/,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      event: 'accepted',
      acceptedCharacters: 12,
      opportunityId: 'request-6',
    });
  });
});
