import { AuthService } from '@core/auth/public-api';
import { CodeSuggestionHostBridgeService } from './code-suggestion-host-bridge.service';
import { SUGGESTION_REQUEST_CHANNEL, type SuggestionRequest, type SuggestionResult } from './code-suggestion-protocol';
import { beginCodeRequest } from './code-completion-request-gate';
import { BehaviorSubject } from 'rxjs';

describe('CodeSuggestionHostBridgeService', () => {
  let service: CodeSuggestionHostBridgeService;
  let posted: Array<Record<string, unknown>>;
  let target: Window;
  let fetchSpy: jasmine.Spy;
  let auth: { isSessionInvalidating: boolean; getToken2: jasmine.Spy; refreshAuthToken: jasmine.Spy; userInfo$: BehaviorSubject<{ id: string } | null> };
  const id = '11111111-1111-4111-8111-111111111111';
  function request(): SuggestionRequest {
    return { protocolVersion: 2, requestId: id, opportunityId: id, workspaceSessionId: 'workspace-test',
      client: { name: 'aily-coder-editor', version: '0.1.6', sessionId: 'session-test' }, mode: 'completion', trigger: 'typing',
      active: { fileId: 'main', snapshotId: 'snapshot-1', position: { line: 0, character: 0 } },
      documents: [{ fileId: 'main', snapshotId: 'snapshot-1', relativePath: 'main.cpp', languageId: 'cpp', version: 1, permission: 'edit', windows: [
        { windowId: 'cursor', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, purpose: 'completion', text: '' },
      ] }], recentEdits: [], diagnostics: [], options: { crossFile: false, autoImports: false, partialInsertAccept: true, maxCandidates: 1 } };
  }
  function result(): SuggestionResult {
    return { protocolVersion: 2, requestId: id, opportunityId: id, completionId: 'sug_0123456789abcdef0123456789abcdef', expiresInMs: 15000, finishReason: 'complete',
      suggestions: [{ candidateId: 'sug_0123456789abcdef0123456789abcdef_0', fileId: 'main', snapshotId: 'snapshot-1', kind: 'insert', primary: { range: request().documents[0]!.windows[0]!.range, expectedText: '', newText: 'const char* label = "中文 😀";\n' }, additionalEdits: [] }] };
  }
  function response(complete = true): Response {
    const value = result(); const identity = { protocolVersion: 2, requestId: id, opportunityId: id, completionId: value.completionId };
    const stream = [JSON.stringify({ type: 'meta', ...identity }), JSON.stringify({ type: 'result', ...value }), ...(complete ? [JSON.stringify({ type: 'done', ...identity })] : [])].map(text => `data: ${text}\n\n`).join('');
    const bytes = new TextEncoder().encode(stream);
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 11) controller.enqueue(bytes.slice(i, i + 11)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  function dispatch(operation = 'suggest', payload: unknown = request(), frame = target): boolean {
    return service.handleMessage({ source: frame, data: { channel: SUGGESTION_REQUEST_CHANNEL, operation, requestId: id, payload } } as unknown as MessageEvent);
  }
  async function waitFor(type: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 100; i++) { const event = posted.find(item => item['type'] === type); if (event) return event; await new Promise(resolve => setTimeout(resolve, 0)); }
    throw new Error(`No ${type} event`);
  }
  beforeEach(() => {
    posted = []; target = { postMessage: (message: Record<string, unknown>) => posted.push(message) } as unknown as Window;
    auth = { isSessionInvalidating: false, getToken2: jasmine.createSpy().and.resolveTo('host-only-token'), refreshAuthToken: jasmine.createSpy().and.resolveTo(true), userInfo$: new BehaviorSubject<{ id: string } | null>({ id: 'user-1' }) };
    service = new CodeSuggestionHostBridgeService(auth as unknown as AuthService); service.registerFrame(target); fetchSpy = spyOn(globalThis, 'fetch');
  });
  afterEach(() => service.dispose());
  it('rejects a foreign frame without network activity', () => { expect(dispatch('suggest', request(), {} as Window)).toBeFalse(); expect(fetchSpy).not.toHaveBeenCalled(); });
  it('cancels old-account output and notifies the child on sign-out', async () => {
    let resolve!: (response: Response) => void;
    fetchSpy.and.returnValue(new Promise<Response>(done => { resolve = done; })); dispatch();
    await new Promise(done => setTimeout(done, 0)); auth.userInfo$.next(null); resolve(response());
    await new Promise(done => setTimeout(done, 10));
    expect(posted.some(item => item['type'] === 'session-changed')).toBeTrue();
    expect(posted.some(item => item['type'] === 'result')).toBeFalse();
  });
  it('forwards only the v4 request and host-owned auth, validating UTF-8 SSE', async () => {
    fetchSpy.and.resolveTo(response()); dispatch(); const event = await waitFor('result');
    expect(event['result']).toEqual(result()); const [url, init] = fetchSpy.calls.mostRecent().args;
    expect(url).toContain('/api/v4/code/suggestions'); expect(JSON.parse(init.body)).toEqual(request()); expect(init.headers.Authorization).toBe('Bearer host-only-token');
    expect(JSON.stringify(posted)).not.toContain('host-only-token');
  });
  it('refuses a truncated stream even when the result JSON was valid', async () => {
    fetchSpy.and.resolveTo(response(false)); dispatch(); const event = await waitFor('error'); expect(event['code']).toBe('TRUNCATED_SUGGESTION_STREAM'); expect(posted.some(item => item['type'] === 'result')).toBeFalse();
  });
  it('rejects arbitrary URLs and tools in the child payload', async () => { dispatch('suggest', { ...request(), tools: [], endpoint: 'https://example.com' }); expect((await waitFor('error'))['status']).toBe(400); expect(fetchSpy).not.toHaveBeenCalled(); });
  it('refreshes an expired token once', async () => { fetchSpy.and.returnValues(Promise.resolve(new Response('', { status: 401 })), Promise.resolve(response())); dispatch(); await waitFor('result'); expect(auth.refreshAuthToken).toHaveBeenCalledTimes(1); expect(fetchSpy).toHaveBeenCalledTimes(2); });
  it('returns 402 without retrying a different endpoint', async () => { fetchSpy.and.resolveTo(new Response('', { status: 402 })); dispatch(); expect((await waitFor('error'))['status']).toBe(402); expect(fetchSpy).toHaveBeenCalledTimes(1); });
  it('acknowledges capability negotiation and exposes only supported features', async () => {
    fetchSpy.and.resolveTo(Response.json({ protocolVersions: [2, 3], modes: ['completion', 'next-edit', 'arbitrary'], features: { crossFile: true, atomicAdditionalEdits: true }, maxCandidates: 10, maxRequestBytes: 500000, maxOutputBytes: 500000, quota: { enabled: true, allowed: true, remaining: 9 }, model: { id: 'public-model', apiKey: 'never-forward' } }));
    dispatch('capabilities'); expect(posted[0]?.['type']).toBe('ack'); const event = await waitFor('capabilities'); const capabilities = event['capabilities'] as Record<string, unknown>;
    expect(capabilities['maxCandidates']).toBe(3); expect(JSON.stringify(event)).not.toContain('never-forward'); expect(JSON.stringify(event)).not.toContain('arbitrary');
  });
  it('shares cancellation with a v3 request on the same frame', async () => {
    const previous = new AbortController(); beginCodeRequest(target, previous);
    fetchSpy.and.resolveTo(response()); dispatch(); await waitFor('result'); expect(previous.signal.aborted).toBeTrue();
  });
  it('does not publish results after frame replacement', async () => {
    let resolve!: (value: Response) => void; fetchSpy.and.returnValue(new Promise<Response>(done => { resolve = done; })); dispatch();
    await new Promise(done => setTimeout(done, 0)); service.registerFrame({} as Window); resolve(response()); await new Promise(done => setTimeout(done, 10));
    expect(posted.some(item => item['type'] === 'result')).toBeFalse();
  });
});
