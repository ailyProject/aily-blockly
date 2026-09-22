import { createAilyProjectDataValue, createProjectDataMarker, AilyDataRef } from '@domain/project/public-api';
import { prepareAbsProjectData, assertLegacyAbsWorkspaceSupported, compactAbsProjectDataLiterals } from './abs-project-data';
import { convertAbiToAbs, convertAbsToAbi } from './abi-abs-converter';

describe('ABS asynchronous Project Data preparation', () => {
  const ref: AilyDataRef = { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`,
    codec: 'utf8-v1', logicalType: 'text', storage: 'raw-v1', rawLength: 40000, storedLength: 40000 } };
  const source = () => ({ blocks: { blocks: [{ id: 'b', type: 'custom', fields: { TEXT: 'x'.repeat(40000) } }] } });
  let current: boolean;
  let runtime: any;
  const assertCurrent = () => { if (!current) throw new Error('stale'); };
  beforeEach(() => {
    current = true;
    runtime = { put: jasmine.createSpy('put').and.resolveTo(ref),
      flushPending: jasmine.createSpy('flush').and.resolveTo(),
      prepareValue: jasmine.createSpy('prepare').and.resolveTo(),
      resolve: jasmine.createSpy('resolve').and.resolveTo('x'.repeat(40000)) };
  });
  it('prepares references before returning a compact document and materializes only on request', async () => {
    const input = source();
    const result = await prepareAbsProjectData(input, assertCurrent, runtime);
    expect(runtime.prepareValue).toHaveBeenCalledWith(result.document);
    expect(runtime.resolve).not.toHaveBeenCalled();
    expect(result.document.blocks.blocks[0].fields.TEXT as unknown).toEqual(createAilyProjectDataValue(ref));
    expect(await result.materialize()).toEqual(input);
    expect(input.blocks.blocks[0].fields.TEXT.length).toBe(40000);
  });
  it('keeps preparation and materialization evidence independent of callbacks and returned objects', async () => {
    const input = source();
    runtime.prepareValue.and.callFake(async value => { value.blocks.blocks[0].fields.TEXT = 'changed by callback'; });
    const result = await prepareAbsProjectData(input, assertCurrent, runtime);
    expect(result.document.blocks.blocks[0].fields.TEXT as unknown).toEqual(createAilyProjectDataValue(ref));
    result.document.blocks.blocks[0].fields.TEXT = 'changed by caller';
    (result.externalized[0].ref.$ailyData as any).id = `sha256:${'b'.repeat(64)}`;
    expect(await result.materialize()).toEqual(input);
    expect(runtime.resolve.calls.mostRecent().args[0]).toEqual(ref);
    const loaded = await result.materialize();
    loaded.blocks.blocks[0].fields.TEXT = 'changed by native loader';
    expect(await result.materialize()).toEqual(input);
  });
  for (const phase of ['put', 'flushPending', 'prepareValue', 'resolve']) {
    it(`stops a stale resource session after ${phase}`, async () => {
      runtime[phase].and.callFake(async () => { current = false; return phase === 'put' ? ref : 'x'.repeat(40000); });
      if (phase === 'resolve') {
        const result = await prepareAbsProjectData(source(), assertCurrent, runtime);
        await expectAsync(result.materialize()).toBeRejectedWithError('stale');
      } else await expectAsync(prepareAbsProjectData(source(), assertCurrent, runtime)).toBeRejectedWithError('stale');
    });
  }
  it('does not start writing when already stale and stops before a second oversized value', async () => {
    current = false;
    await expectAsync(prepareAbsProjectData(source(), assertCurrent, runtime)).toBeRejectedWithError('stale');
    expect(runtime.put).not.toHaveBeenCalled();
    current = true;
    const input = source();
    Object.assign(input.blocks.blocks[0].fields, { OTHER: 'y'.repeat(40000) });
    runtime.put.and.callFake(async () => { current = false; return ref; });
    await expectAsync(prepareAbsProjectData(input, assertCurrent, runtime)).toBeRejectedWithError('stale');
    expect(runtime.put).toHaveBeenCalledTimes(1);
    expect(runtime.prepareValue).not.toHaveBeenCalled();
  });
  it('keeps direct converters strict and rejects serializer loss even for small state', () => {
    expect(() => convertAbiToAbs(source())).toThrow();
    expect(() => convertAbiToAbs({ blocks: { blocks: [] }, models: { id: 'model' } })).toThrowError(/serializer/);
    expect(() => assertLegacyAbsWorkspaceSupported({ blocks: {}, variables: [], $ailyProjectData: {} })).not.toThrow();
    const abs = `unknown(TEXT=${JSON.stringify('x'.repeat(40000))})`;
    expect(convertAbsToAbi(abs).success).toBeFalse();
    expect(convertAbsToAbi(abs, { deferProjectDataExternalization: true }).success).toBeTrue();
  });
  it('retains the mandatory data schema when descriptive headers are disabled', async () => {
    const input = source(); input.blocks.blocks[0].type = 'text';
    const { document } = await prepareAbsProjectData({ ...input, $ailyProjectData: createProjectDataMarker() }, assertCurrent, runtime);
    const abs = convertAbiToAbs(document, { includeHeader: false });
    expect(abs).not.toContain('# Blockly ABS File');
    const result = convertAbsToAbi(abs, { requireProjectDataHeader: true, deferProjectDataExternalization: true });
    expect(result.success).toBeTrue();
    expect(result.abiJson.blocks.blocks[0].fields.TEXT).toEqual(createAilyProjectDataValue(ref));
  });
  it('replaces only prepared literals, preserving CRLF, comments, unused declarations and ordinary code', async () => {
    const input = source();
    const text = input.blocks.blocks[0].fields.TEXT;
    const abs = `# header ${JSON.stringify(text)}\r\n@var unused: String = ${JSON.stringify(text)}\r\n\r\ncustom( TEXT = ${JSON.stringify(text)} ) # keep me\r\n`;
    const result = await prepareAbsProjectData(input, assertCurrent, runtime);
    const compact = compactAbsProjectDataLiterals(abs, input, result.externalized);
    expect(compact).toBe(`# header ${JSON.stringify(text)}\r\n@var unused: String = ${JSON.stringify(text)}\r\n\r\ncustom( TEXT = ${JSON.stringify(createAilyProjectDataValue(ref))} ) # keep me\r\n`);
  });
  it('replaces a nested mixed-payload literal and respects legacy @json field transport', async () => {
    const input = { blocks: { blocks: [{ id: 'b', type: 'custom', fields: { STATE: { existing: ref, text: 'x'.repeat(40000) } } }] } };
    const payload = input.blocks.blocks[0].fields.STATE;
    const result = await prepareAbsProjectData(input, assertCurrent, runtime);
    const expected = `custom(STATE=${JSON.stringify({ existing: ref, text: createAilyProjectDataValue(ref) })})`;
    expect(compactAbsProjectDataLiterals(`custom(STATE=${JSON.stringify(payload)})`, input, result.externalized)).toBe(expected);
    expect(compactAbsProjectDataLiterals(`custom(STATE=${JSON.stringify('@json:' + JSON.stringify(payload))})`, input, result.externalized)).toBe(expected);
  });
  it('leaves single-quoted/positional or unlocatable oversized input unapplied instead of regenerating code', async () => {
    const input = source();
    const result = await prepareAbsProjectData(input, assertCurrent, runtime);
    for (const abs of [`custom('${input.blocks.blocks[0].fields.TEXT}')`, `custom(${JSON.stringify(input.blocks.blocks[0].fields.TEXT)})`, 'custom(TEXT="different")']) {
      expect(() => compactAbsProjectDataLiterals(abs, input, result.externalized)).toThrowError(/具名字段/);
    }
  });
  it('treats an @extra string as opaque even when it starts with @json:', async () => {
    const value = '@json:' + 'x'.repeat(40000);
    const input = { blocks: { blocks: [{ id: 'b', type: 'custom', extraState: value }] } };
    const result = await prepareAbsProjectData(input, assertCurrent, runtime);
    expect(compactAbsProjectDataLiterals(`custom() @extra:${JSON.stringify(value)} # extra`, input, result.externalized))
      .toBe(`custom() @extra:${JSON.stringify(createAilyProjectDataValue(ref))} # extra`);
  });
  it('requires every occurrence, including duplicate values, to have a reliable source location', async () => {
    const input = source();
    input.blocks.blocks.push({ ...input.blocks.blocks[0], id: 'other' });
    const text = JSON.stringify(input.blocks.blocks[0].fields.TEXT);
    const result = await prepareAbsProjectData(input, assertCurrent, runtime);
    expect(() => compactAbsProjectDataLiterals(`custom(TEXT=${text})\ncustom(${text})`, input, result.externalized)).toThrowError(/具名字段/);
    const compact = compactAbsProjectDataLiterals(`custom(TEXT=${text})\ncustom(TEXT=${text})`, input, result.externalized);
    expect(compact.match(/\$ailyProjectDataValue/g)?.length).toBe(2);
  });
});
