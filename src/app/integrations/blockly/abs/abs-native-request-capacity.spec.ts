import { assertSynchronousNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate-policy';
import { NATIVE_CANDIDATE_LIMITS } from '../../../editors/blockly-editor/services/blockly-native-budget';
import { assertNativeRequestCapacity, nativeRequestPayload } from '../../../editors/blockly-editor/services/blockly-native-request-capacity';
import { nativeRequestFootprint } from '../../../editors/blockly-editor/services/blockly-native-request-footprint';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { cloneNativeCandidateRequest, encodeNativeCandidateRequest, decodeNativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-transfer';
import { restoreAbsFailure, serializeAbsFailure } from './abs-diagnostics';
import { AbsGenerationToolsService } from './abs-generation-tools.service';

describe('native request capacity accounting', () => {
  const limit = NATIVE_CANDIDATE_LIMITS.requestCharacters;
  const request = (value: unknown): NativeCandidateRequest => ({ steps: [], blocks: [], values: [{ ref: {} as any, value }] });
  const oversizedRuntime = (): NativeCandidateRequest => ({ steps: [{ kind: 'context', messages: { FIXTURE: 'x'.repeat(limit) } }], blocks: [], abs: 'fixture()' });

  it('retains inclusive UTF-16 text limits, without switching Chinese source to UTF-8 bytes', () => {
    const input: NativeCandidateRequest = { steps: [], blocks: [], abs: '' };
    const overhead = JSON.stringify(input).length;
    input.abs = '界'.repeat(limit - overhead);
    expect(nativeRequestFootprint(input)).toEqual({ textCharacters: limit, backingBytes: 0, backingBuffers: 0, units: limit });
    expect(() => assertNativeRequestCapacity(input)).not.toThrow();
    input.abs += '界';
    expect(() => assertNativeRequestCapacity(input)).toThrowMatching((error: any) => error.code === 'ABS_LIMIT' && error.diagnostic.capacity.actual === limit + 1);
  });

  it('counts binary backing bytes instead of JSON numeric-index expansion', () => {
    const value = new Uint8Array(1536000).fill(255), input = request(value);
    expect(JSON.stringify(input).length).toBeGreaterThan(limit);
    const footprint = nativeRequestFootprint(input);
    expect(footprint.backingBytes).toBe(value.buffer.byteLength);
    expect(footprint.textCharacters).toBeLessThan(200);
    expect(footprint.units).toBeLessThan(limit);
    expect(() => assertSynchronousNativeCandidate(input)).not.toThrow();
  });

  it('counts the whole store of a thin view and rejects excess capacity', () => {
    const backing = new ArrayBuffer(limit), input = request(new Uint8Array(backing, 17, 1));
    expect(nativeRequestFootprint(input).backingBytes).toBe(limit);
    expect(() => assertNativeRequestCapacity(input)).toThrowMatching((error: any) => error.code === 'ABS_LIMIT' && error.diagnostic.reason === 'native-resource-capacity');
  });

  it('deduplicates overlapping/shared backing stores but not independent stores or raw buffers', () => {
    const shared = new ArrayBuffer(1024), independent = new ArrayBuffer(1024);
    const value = { raw: shared, first: new Uint8Array(shared, 0, 200), overlap: new Uint16Array(shared, 100, 100),
      data: new DataView(shared, 2, 10), independent };
    expect(nativeRequestFootprint(request(value)).backingBytes).toBe(2048);
    expect(nativeRequestFootprint(request(value)).backingBuffers).toBe(2);
    expect(nativeRequestFootprint(request(new DataView(independent, 3, 1))).backingBytes).toBe(1024);
  });

  it('brands cross-Realm buffers without trusting a spoofed toStringTag', () => {
    const frame = document.createElement('iframe'); document.body.appendChild(frame);
    try {
      const RealmArrayBuffer = (frame.contentWindow as any).ArrayBuffer;
      const RealmUint8Array = (frame.contentWindow as any).Uint8Array;
      const backing = new RealmArrayBuffer(4096);
      expect(nativeRequestFootprint(request({ raw: backing, view: new RealmUint8Array(backing, 7, 1) })).backingBytes).toBe(4096);
      const fake = { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: limit * 2 };
      expect(nativeRequestFootprint(request(fake)).backingBytes).toBe(0);
    } finally { frame.remove(); }
  });

  it('does not mutate data or change structured-clone/send alias semantics', () => {
    const backing = new ArrayBuffer(16), first = new Uint8Array(backing, 2, 3), second = new DataView(backing, 4, 2);
    first[0] = 77;
    const input = request({ first, second, backing });
    const cloned = cloneNativeCandidateRequest(input), before = nativeRequestFootprint(cloned);
    const decoded = decodeNativeCandidateRequest(structuredClone(encodeNativeCandidateRequest(cloned)));
    const output = decoded.values![0].value as any;
    expect(nativeRequestFootprint(decoded)).toEqual(before);
    expect(output.first.buffer).toBe(output.backing); expect(output.second.buffer).toBe(output.backing);
    expect(output.first[0]).toBe(77); expect(output.backing).not.toBe(backing);
    expect(first[0]).toBe(77); expect(first.buffer).toBe(backing);
  });

  it('preserves the existing clone-before-policy boundary instead of invoking caller toJSON', () => {
    let hooks = 0;
    const view = new Uint8Array(new ArrayBuffer(limit), 3, 1);
    Object.defineProperty(view, 'toJSON', { value: () => { hooks++; return null; } });
    const detached = cloneNativeCandidateRequest(request(view));
    expect(nativeRequestFootprint(detached).backingBytes).toBe(limit);
    expect(() => assertNativeRequestCapacity(detached)).toThrowMatching((error: any) => error.code === 'ABS_LIMIT');
    expect(hooks).toBe(0);
    expect(() => cloneNativeCandidateRequest(request({ toJSON() { hooks++; return null; } }))).toThrow();
    expect(hooks).toBe(0);
  });

  it('reports exact bounded text components without exposing source, labels or values', () => {
    const input = oversizedRuntime(), footprint = nativeRequestFootprint(input), payload = nativeRequestPayload(input, footprint);
    expect(Object.values(payload.components).reduce((sum, value) => sum + value, 0)).toBe(footprint.units);
    expect(payload.replay.context).toBe(JSON.stringify(input.steps[0]).length);
    try { assertNativeRequestCapacity(input); fail('oversized'); }
    catch (error) {
      const wire = serializeAbsFailure(restoreAbsFailure(serializeAbsFailure(error)));
      expect(wire.diagnostic!.requestPayload).toEqual(payload);
      expect(wire.diagnostic!.reason).toBe('native-runtime-capacity');
      expect(wire.diagnostic!.hint).not.toContain('local Blockly library');
      expect(wire.diagnostic!.hint).toContain('Preserve');
      expect(JSON.stringify(wire).length).toBeLessThan(2000);
      expect(JSON.stringify(wire)).not.toContain('FIXTURE');
    }
  });

  it('preserves the numeric profile through the real ABS tool failure boundary', async () => {
    const input = oversizedRuntime();
    const sync = { exportGeneration: async () => assertNativeRequestCapacity(input) };
    const result: any = await new AbsGenerationToolsService(sync as any).execute('abs_projection', {
      version: 2, requestId: 'native-payload-diagnostic-request', expectedAbiHash: 'sha256:' + 'a'.repeat(64),
    });
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_LIMIT'); expect(result.receipt).toBeUndefined();
    expect(result.diagnostic.requestPayload.replay.context).toBeGreaterThan(limit);
    expect(result.recovery).toContain('Host runtime replay');
  });

  it('rejects malformed profile counters and strips unrecognized data', () => {
    const payload = nativeRequestPayload(request('small'), nativeRequestFootprint(request('small')));
    expect(serializeAbsFailure({ diagnostic: { requestPayload: { ...payload, units: Infinity } } }).diagnostic).toBeUndefined();
    expect(serializeAbsFailure({ diagnostic: { requestPayload: { ...payload, backingBytes: -1 } } }).diagnostic).toBeUndefined();
    expect(serializeAbsFailure({ diagnostic: { requestPayload: { ...payload, privateSource: 'secret' } } }).diagnostic!.requestPayload).toEqual(payload);
  });
});
