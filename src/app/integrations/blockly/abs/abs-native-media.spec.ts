import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest, NativeReplayStep } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { nativeCandidateValues } from '../../../editors/blockly-editor/services/blockly-native-values';
import { collectProjectDataReferences, projectDataRuntime } from '@domain/project/project-data/public-api';
import { captureAbsNativeValues } from './abs-native-resources';
import { absJson } from './abs-json';

describe('native read-only media snapshot and shared generator projection', () => {
  const run = (input: NativeCandidateRequest) => evaluateNativeCandidate(input, { assertCurrent: () => {} });
  const ref = (codec = 'u8g2-xbm-v1', length = 1) => ({ $ailyData: {
    schemaVersion: 1 as const, id: `sha256:${'b'.repeat(64)}` as `sha256:${string}`, codec,
    logicalType: 'binary' as const, storage: 'raw-v1' as const, rawLength: length, storedLength: length,
  } });
  const cases = [
    { field: 'field_bitmap_u8g2', codec: 'u8g2-xbm-v1', key: 'bitmap', bytes: [129],
      patch: { width: 8, height: 1 }, check: 'value[0][0] === 1 && value[0][7] === 1 && value[0][1] === 0' },
    { field: 'field_u8g2_animation', codec: 'u8g2-xbm-frames-v1', key: 'frames', bytes: [129, 2],
      patch: { width: 8, height: 1, frameCount: 2 }, check: 'value.frames[0][0][7] === 1 && value.frames[1][0][1] === 1' },
    { field: 'field_tftespi_animation', codec: 'tft-rgb565-be-frames-v1', key: 'frames', bytes: [18, 52, 171, 205],
      patch: { width: 1, height: 1, frameCount: 2 }, check: 'value.frames[0] === "EjQ=" && value.frames[1] === "q80="' },
    { field: 'field_tftespi_image', codec: 'tft-rgb565-be-frames-v1', key: 'frames', bytes: [18, 52],
      patch: { width: 1, height: 1, frameCount: 1 }, check: 'value.data === "EjQ="' },
    { field: 'field_led_matrix_image', codec: 'led-matrix-mono-v1', key: 'pixels', bytes: [129],
      patch: { width: 8, height: 1 }, check: 'value.pixels[0][0] === 1 && value.pixels[0][7] === 1' },
  ];
  const fixture = async (entry: { field: string; codec: string; key: string; bytes: number[]; patch: Record<string, unknown>; check: string } = cases[0]) => {
    const steps: NativeReplayStep[] = [{ kind: 'context', mode: 'arduino' },
      { kind: 'definitions', libraryName: 'unlisted-media-library', definitions: [{ type: 'native_media', message0: '%1',
        args0: [{ type: entry.field, name: 'PAYLOAD', width: 8, height: 1 }], previousStatement: null, nextStatement: null }] },
      { kind: 'script', label: 'legacy-media-generator', source: `Arduino.forBlock.native_media = block => {
        const value = block.getFieldValue('PAYLOAD');
        if (!(${entry.check})) throw Error('Media projection lost bytes');
        return '// media verified\\n';
      };` }];
    const initial = await run({ steps, blocks: [{ type: 'native_media', id: 'initial', fields: [] }] });
    const reference = ref(entry.codec, entry.bytes.length);
    const state = { ...initial.state['blocks'].blocks[0].fields.PAYLOAD, ...entry.patch, [entry.key]: reference };
    // The real exporter orders JSON keys; native fields reconstruct their own
    // property order. Equality must compare JSON values, not insertion order.
    return { steps, blocks: [], abs: '# ABS Schema: 2\nnative_media(' + absJson(state) + ')',
      values: [{ ref: reference, value: new Uint8Array(entry.bytes) }] } satisfies NativeCandidateRequest;
  };
  const verify = async (input: NativeCandidateRequest) => {
    const bound = await run(input), instance = bound.binding!.instances[0];
    return { steps: input.steps, blocks: [], values: input.values, verify: { state: bound.state,
      contracts: { fields: { [instance.id]: instance.shape.fields }, syntax: { [instance.id]: instance.shape.argumentOrder } } } } as NativeCandidateRequest;
  };
  afterEach(() => expect(document.querySelector('[data-blockly-native-candidate]')).toBeNull());

  const imageFixture = async (bytes?: number[]) => {
    if (!bytes) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!; context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1, 1);
      bytes = Array.from(atob(canvas.toDataURL().split(',')[1]), char => char.charCodeAt(0));
    }
    return fixture({ field: 'field_image_preview', codec: 'image-original-v1', key: 'image', bytes,
      patch: { width: 8, height: 8, mediaType: 'image/png', filePath: 'same.png', byteLength: bytes.length },
      check: `value.filePath.startsWith('sha256:') && window.tftImageCache[value.filePath].processedSizes[8].every(pixel => pixel === '0xF800')` });
  };

  it('prepares a real image from private bytes before the synchronous generator without changing ABI', async () => {
    const input = await imageFixture(), request = await verify(input), result = await run(request);
    expect(result.state).toEqual(request.verify!.state);
    expect(result.state['blocks'].blocks[0].fields.PAYLOAD.filePath).toBe('same.png');
    expect(collectProjectDataReferences(result.state)).toEqual([input.values[0].ref]);
  });

  it('rejects undecodable images instead of accepting generated placeholders', async () => {
    const request = await verify(await imageFixture([1, 2, 3]));
    await expectAsync(run(request)).toBeRejectedWithError(/Image resource decoding failed/);
  });

  it('rejects a replacement hook even on a bundled image field', async () => {
    const request = await verify(await imageFixture());
    request.steps.push({ kind: 'script', label: 'replaced-image-preparation', source: `
      const init = Blockly.Blocks.native_media.init;
      Blockly.Blocks.native_media.init = function() { init.call(this);
        this.getField('PAYLOAD').prepareForCodeGeneration = () => {};
      };` });
    await expectAsync(run(request)).toBeRejectedWithError(/unregistered asynchronous/);
  });

  it('rejects masking a required bundled preparation hook with null', async () => {
    const request = await verify(await imageFixture());
    request.steps.push({ kind: 'script', label: 'removed-image-preparation', source: `
      const init = Blockly.Blocks.native_media.init;
      Blockly.Blocks.native_media.init = function() { init.call(this);
        this.getField('PAYLOAD').prepareForCodeGeneration = null;
      };` });
    await expectAsync(run(request)).toBeRejectedWithError(/unregistered asynchronous/);
  });

  for (const entry of cases) it(`preserves ${entry.field} envelopes while verifying the actual legacy generator bytes`, async () => {
    const input = await fixture(entry), request = await verify(input);
    const result = await run(request);
    expect(result.state).toEqual(request.verify!.state);
    expect(collectProjectDataReferences(result.state)).toEqual([input.values[0].ref]);
    expect(input.values[0].value).toEqual(new Uint8Array(entry.bytes));
  });

  it('rejects missing, altered and duplicate media snapshots before accepting a candidate', async () => {
    const input = await fixture(); input.values = [];
    await expectAsync(run(input)).toBeRejectedWithError(/not prepared/);
    const request = await verify(await fixture());
    request.values![0].ref = { $ailyData: { ...request.values![0].ref.$ailyData, storedLength: 2 } };
    await expectAsync(run(request)).toBeRejectedWithError(/metadata changed/);
    const duplicate = await fixture(); duplicate.values.push(duplicate.values[0]);
    await expectAsync(run(duplicate)).toBeRejectedWithError(/duplicate/);
  });

  it('rejects corrupt binary payload lengths during actual generation', async () => {
    const request = await verify(await fixture()); request.values![0].value = new Uint8Array(0);
    await expectAsync(run(request)).toBeRejectedWithError(/length mismatch/);
  });

  it('does not expose mutable cached bytes or filesystem services through the read-only facade', async () => {
    const request = await verify(await fixture());
    request.steps.push({ kind: 'script', label: 'read-only-consumer', source: `
      const original = Arduino.forBlock.native_media;
      Arduino.forBlock.native_media = block => {
        const ref = block.getField('PAYLOAD').getValue().bitmap;
        const bytes = ailyProjectData.getPrepared(ref); bytes[0] = 0;
        if (ailyProjectData.getPrepared(ref)[0] !== 129 || ailyProjectData.put || ailyProjectData.resolve) throw Error('Leaked snapshot');
        const serializedArray = { getFieldValue: () => JSON.stringify([ref]) };
        if (ailyProjectData.getPreparedFieldPayload(serializedArray, 'PAYLOAD')[0] !== 129) throw Error('Field JSON semantics differ');
        return original(block);
      };` });
    await run(request);
    expect((request.values![0].value as Uint8Array)[0]).toBe(129);
  });

  it('makes missing resource reads sticky even if a generator catches the error', async () => {
    const request = await verify(await fixture());
    request.steps.push({ kind: 'script', label: 'caught-read', source: `Arduino.forBlock.native_media = block => {
      try { ailyProjectData.getPrepared({}); } catch {} return ''; };` });
    await expectAsync(run(request)).toBeRejectedWithError(/reference is invalid/);
  });

  for (const effect of ['setTimeout(() => {}, 0)', 'queueMicrotask(() => {})', 'Promise.resolve().then(() => setTimeout(() => {}, 0))'])
  it('rejects caught asynchronous Generator work after resource preparation: ' + effect, async () => {
    const request = await verify(await imageFixture());
    request.steps.push({ kind: 'script', label: 'late-generator-work', source: `Arduino.forBlock.native_media = () => {
      try { ${effect}; } catch {} return ''; };` });
    await expectAsync(run(request)).toBeRejectedWithError(/does not support/);
  });

  it('rejects an unregistered library preparation hook without executing it', async () => {
    const request = await verify(await fixture());
    request.steps.push({ kind: 'script', label: 'derived-cache', source: `
      const init = Blockly.Blocks.native_media.init;
      Blockly.Blocks.native_media.init = function() { init.call(this);
        this.getField('PAYLOAD').prepareForCodeGeneration = () => { throw Error('unregistered hook executed'); };
      };` });
    await expectAsync(run(request)).toBeRejectedWithError(/unregistered asynchronous derived-resource preparation/);
  });

  it('uses the same reference discovery for strings, nested payloads and host snapshots', async () => {
    const reference = ref(), input = { fields: [reference, { more: reference }, JSON.stringify({ image: reference })] };
    const resolver = spyOn(projectDataRuntime, 'resolve').and.resolveTo(new Uint8Array([129]));
    const current = jasmine.createSpy('current');
    const entries = await captureAbsNativeValues(input, current);
    expect(resolver.calls.count()).toBe(1); expect(current.calls.count()).toBeGreaterThan(1);
    const snapshot = nativeCandidateValues(entries);
    (snapshot.get(reference) as Uint8Array)[0] = 0;
    expect(snapshot.get(reference)).toEqual(new Uint8Array([129]));
    expect(() => collectProjectDataReferences([reference, { $ailyData: { ...reference.$ailyData, rawLength: 2 } }])).toThrow();
    await expectAsync(captureAbsNativeValues(input, () => { throw Error('stale session'); })).toBeRejectedWithError('stale session');
    expect(resolver.calls.count()).toBe(1);
  });
});
