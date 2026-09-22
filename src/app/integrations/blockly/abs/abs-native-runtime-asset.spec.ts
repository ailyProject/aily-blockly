import { loadNativeRuntimeAsset } from '../../../editors/blockly-editor/services/blockly-native-runtime-asset';
import { serializeAbsFailure } from './abs-diagnostics';

describe('native runtime asset loading', () => {
  const base = 'http://localhost:4200/editor/';
  const url = base + 'blockly/runtime/native-candidate.js';
  const source = '/* native runtime 中文 */';
  let hash: string;
  beforeAll(async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  });
  const load = (signal = new AbortController().signal, uri = base) => loadNativeRuntimeAsset(uri, hash, signal);
  const failure = async (operation: Promise<unknown>) => {
    try { await operation; fail('expected asset failure'); } catch (error) { return serializeAbsFailure(error); }
    throw new Error('unreachable');
  };

  it('returns only verified source and requests the build resource once without stale-cache preference', async () => {
    const fetch = spyOn(window, 'fetch').and.resolveTo(new Response(source));
    expect(await load()).toBe(source);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [target, options] = fetch.calls.mostRecent().args;
    expect(String(target)).toBe(url); expect(options!.cache).toBe('no-cache');
    expect(options!.credentials).toBe('omit');
  });

  it('distinguishes network failure from ABS syntax and preserves actionable evidence', async () => {
    const fetch = spyOn(window, 'fetch').and.rejectWith(new TypeError('Failed to fetch'));
    const result = await failure(load());
    expect(result.code).toBe('ABS_NATIVE_ASSET_UNAVAILABLE');
    expect(result.diagnostic!.reason).toBe('fetch-failed');
    expect(result.diagnostic!.resource).toEqual({ url, expectedHash: hash });
    expect(result.diagnostic!.hint).toContain('do not retry');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  for (const status of [0, 404, 503]) it(`reports HTTP status ${status} without consuming the error body`, async () => {
    const response = status ? new Response('private server error', { status }) : Response.error();
    const read = spyOn(response, 'arrayBuffer').and.callThrough();
    spyOn(window, 'fetch').and.resolveTo(response);
    const result = await failure(load());
    expect(result.code).toBe('ABS_NATIVE_ASSET_UNAVAILABLE');
    expect(result.diagnostic!.reason).toBe('http-status');
    expect(result.diagnostic!.resource!.status).toBe(status);
    expect(read).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('private server error');
  });

  it('distinguishes a truncated body and integrity failure from network failure', async () => {
    const response = new Response(source);
    spyOn(response, 'arrayBuffer').and.rejectWith(new Error('connection lost'));
    const fetch = spyOn(window, 'fetch').and.resolveTo(response);
    expect((await failure(load())).diagnostic!.reason).toBe('body-read-failed');
    fetch.and.resolveTo(new Response('different build'));
    const mismatch = await failure(load());
    expect(mismatch.code).toBe('ABS_NATIVE_ASSET_MISMATCH');
    expect(mismatch.diagnostic!.resource!.expectedHash).toBe(hash);
    expect(mismatch.diagnostic!.resource!.actualHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mismatch.diagnostic!.resource!.actualHash).not.toBe(hash);
  });

  it('classifies unavailable integrity checking without accepting unverified code', async () => {
    spyOn(window, 'fetch').and.resolveTo(new Response(source));
    spyOn(crypto.subtle, 'digest').and.rejectWith(new Error('unavailable'));
    expect((await failure(load())).diagnostic!.reason).toBe('integrity-check-unavailable');
  });

  for (const uri of ['invalid URL', 'file:///app/index.html']) it(`rejects unsupported renderer URLs before fetch: ${uri}`, async () => {
    const fetch = spyOn(window, 'fetch');
    expect((await failure(load(undefined, uri))).code).toBe('ABS_NATIVE_ASSET_UNAVAILABLE');
    expect(fetch).not.toHaveBeenCalled();
  });

  for (const stage of ['before', 'fetch', 'body', 'digest']) it(`preserves cancellation and timeout reasons during ${stage}`, async () => {
    const abort = new AbortController(), reason = new Error('Native candidate timed out.');
    const response = new Response(source), fetch = spyOn(window, 'fetch').and.resolveTo(response);
    if (stage === 'before') abort.abort(reason);
    if (stage === 'fetch') fetch.and.callFake(async () => { abort.abort(reason); throw new TypeError('Failed to fetch'); });
    if (stage === 'body') spyOn(response, 'arrayBuffer').and.callFake(async () => { abort.abort(reason); throw new TypeError('aborted'); });
    if (stage === 'digest') spyOn(crypto.subtle, 'digest').and.callFake(async () => { abort.abort(reason); throw new Error('aborted'); });
    await expectAsync(load(abort.signal)).toBeRejectedWith(reason);
    if (stage === 'before') expect(fetch).not.toHaveBeenCalled();
  });
});
