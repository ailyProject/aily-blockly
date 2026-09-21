import * as Blockly from 'blockly';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import { BlocklyGeneratorRuntimeService } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import type { NativeCandidateRequest, NativeReplayStep } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { nativeHardwareFixtures } from './abs-native-hardware.fixture';
import { nativeAbsArgumentOrder } from './abs-native-arguments';
import type { NativeInputDeclaration } from '../../../editors/blockly-editor/services/blockly-native-structure';

describe('independent native candidate Realm', () => {
  const definition = { type: 'native_candidate_test', message0: '%1', args0: [{ type: 'field_input', name: 'TEXT', text: 'default' }], output: null };
  const candidate = (extra: NativeReplayStep[] = []): NativeCandidateRequest => ({
    steps: [{ kind: 'definitions', definitions: [definition] }, ...extra],
    blocks: [{ id: 'candidate-id', type: definition.type, fields: [{ name: 'TEXT', value: 'edited' }] }],
  });
  const run = (request: NativeCandidateRequest) => evaluateNativeCandidate(request, { assertCurrent: () => {} });
  afterEach(() => expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0));

  it('fails asset loading before constructing a candidate realm', async () => {
    spyOn(window, 'fetch').and.rejectWith(new TypeError('Failed to fetch'));
    const create = spyOn(document, 'createElement').and.callThrough();
    try { await run(candidate()); fail('accepted missing asset'); }
    catch (error) { expect(error.code).toBe('ABS_NATIVE_ASSET_UNAVAILABLE'); }
    expect(create.calls.allArgs().some(args => args[0] === 'iframe')).toBeFalse();
  });

  it('rejects a stale or altered candidate asset before evaluating any code', async () => {
    spyOn(window, 'fetch').and.resolveTo(new Response('window.alteredCandidateRan = true;'));
    await expectAsync(run(candidate())).toBeRejectedWithError(/does not match the host build/);
    expect(window['alteredCandidateRan']).toBeUndefined();
  });

  for (const mode of ['arduino', 'micropython', 'python'] as const) it(`bootstraps the actual ${mode} generator without exposing other modes`, async () => {
    const request = candidate([{ kind: 'context', mode, messages: { CANDIDATE_TRANSLATION: 'translated' } }, {
      kind: 'script', label: 'host-bootstrap', source: `
        const generator = ${mode === 'arduino' ? 'Arduino' : mode === 'micropython' ? 'MPY' : 'Python'};
        if (typeof generator.valueToCode !== 'function' || typeof generator.workspaceToCode !== 'function') throw Error('not a generator');
        if ([window.Arduino, window.MPY, window.Python].filter(Boolean).length !== 1) throw Error('mode leak');
        if (Blockly.Msg.CANDIDATE_TRANSLATION !== 'translated' || typeof pinyinPro.pinyin !== 'function') throw Error('missing host dependency');
        generator.forBlock.native_candidate_test = function(block) { return [block.getFieldValue('TEXT'), 0]; };
        if (generator.forBlock.native_candidate_test({ getFieldValue: () => 'real' })[0] !== 'real') throw Error('handler missing');
      `,
    }]);
    await run(request);
    expect(Blockly.Msg['CANDIDATE_TRANSLATION']).toBeUndefined();
  });

  it('registers actual custom fields and roundtrips multiline text without a field substitute', async () => {
    const text = 'line one\nline two 中文 😀';
    const request = candidate([{ kind: 'script', label: 'fields', source: `
      for (const type of ['field_multilinetext', 'field_audio', 'field_u8g2_animation', 'field_tftespi_animation',
        'field_led_matrix_image', 'field_bitmap_u8g2', 'field_slider']) {
        if (!Blockly.registry.getClass(Blockly.registry.Type.FIELD, type)) throw Error('missing field ' + type);
      }
    ` }]);
    request.steps.push({ kind: 'definitions', definitions: [{ ...definition, args0: [{ type: 'field_multilinetext', name: 'TEXT', text: '' }] }] });
    request.blocks[0].fields[0].value = text;
    expect((await run(request)).state['blocks'].blocks[0].fields.TEXT).toBe(text);
  });

  it('uses independent registries, prototypes, globals and workspace models', async () => {
    const before = Blockly.Block.prototype['candidateMark'];
    const original = Blockly.Blocks['text'];
    const result = await run(candidate([{ kind: 'script', label: 'isolation', source: `
      Blockly.Block.prototype.candidateMark = 'child';
      Blockly.Blocks.text = { init() {} };
      Blockly.Msg.CANDIDATE_ONLY = 'private';
      window.candidateOnly = true;
      if (typeof window.fs !== 'undefined' || typeof window.electron !== 'undefined') throw Error('preload leaked');
      try { parent.document.body; throw Error('parent accessible'); } catch (e) { if (e.name !== 'SecurityError') throw e; }
    ` }]));
    expect(result.state['blocks'].blocks[0].fields.TEXT).toBe('edited');
    expect(Blockly.Block.prototype['candidateMark']).toBe(before);
    expect(Blockly.Blocks['text']).toBe(original);
    expect(Blockly.Msg['CANDIDATE_ONLY']).toBeUndefined();
    expect(window['candidateOnly']).toBeUndefined();
  });

  it('preserves classic-script lexical sharing only within the candidate', async () => {
    const request = candidate();
    request.steps.unshift({ kind: 'script', label: 'first', source: `const candidateLabel = 'private';` });
    request.steps.push({ kind: 'script', label: 'second', source: `if (candidateLabel !== 'private') throw Error('lexical binding missing');` });
    await run(request); await run(request);
    expect(window['candidateLabel']).toBeUndefined();
  });

  for (const source of [
    `setTimeout(() => { try { fetch('https://example.invalid/'); } catch {} }, 1)`,
    `try { queueMicrotask(() => {}); } catch {}`,
    `try { Promise.resolve().then(() => {}); } catch {}`,
    `(async () => { await 0; })()`,
    `try { setInterval(() => {}, 1); } catch {}`,
    `try { fetch('https://example.invalid/'); } catch {}`,
    `try { projectService.save(); } catch {}`,
    `import('./unused.js')`,
  ]) it(`rejects unsupported effects even if caught: ${source}`, async () => {
    await expectAsync(run(candidate([{ kind: 'script', label: 'effects', source }]))).toBeRejectedWithError(/does not support/);
    expect(Blockly.Msg['LATE']).toBeUndefined();
  });

  it('drains finite registration tasks and nested tasks before creating instances', async () => {
    const request = candidate([{ kind: 'script', label: 'deferred-registration', source: `
      const cancelled = setTimeout(() => { throw Error('cancelled task ran'); }, 1); clearTimeout(cancelled);
      setTimeout(value => { setTimeout(() => {
        const init = Blockly.Blocks.native_candidate_test.init;
        Blockly.Blocks.native_candidate_test.init = function() { init.call(this); this.appendDummyInput().appendField(new Blockly.FieldNumber(value), 'LATE'); };
      }, 1); }, 1, 7);
    ` }]);
    request.blocks[0].fields.push({ name: 'LATE', value: 9 });
    expect((await run(request)).state['blocks'].blocks[0].fields.LATE).toBe(9);
  });

  for (const source of [
    `setTimeout(() => { Blockly.getMainWorkspace().createVariable('unowned'); }, 1)`,
    `setTimeout(() => { throw Error('deferred failure'); }, 1)`,
    `try { for(let i = 0; i < 129; i++) clearTimeout(setTimeout(() => {}, 0)); } catch {}`,
    `try { setTimeout(() => {}, 2001); } catch {}`,
    `setTimeout(() => { try { setInterval(() => {}, 1); } catch {} }, 1)`,
  ]) it('rejects invalid deferred registration without leaving tasks: ' + source, async () => {
    await expectAsync(run(candidate([{ kind: 'script', label: 'bad-deferred', source }]))).toBeRejected();
    await run(candidate());
  });

  it('drains bounded UI tasks without waiting and without changing persisted meaning', async () => {
    const request = candidate([{ kind: 'script', label: 'deferred-ui', source: `
      const init = Blockly.Blocks.native_candidate_test.init;
      Blockly.Blocks.native_candidate_test.init = function() {
        init.call(this);
        const cancelled = setTimeout(() => { throw Error('cancelled UI task ran'); }, 0); clearTimeout(cancelled);
        setTimeout(label => { this.setTooltip(label); setTimeout(() => this.setTooltip('nested label'), 100); }, 50, 'label');
      };
    ` }]);
    expect((await run(request)).state['blocks'].blocks[0].fields.TEXT).toBe('edited');
  });

  for (const effect of [
    `this.setFieldValue('lost', 'TEXT')`,
    `this.appendValueInput('DEFERRED')`,
    `this.workspace.createVariable('unowned')`,
    `try { fetch('https://example.invalid/'); } catch {}`,
    `return Promise.resolve()`,
    `const repeat = () => setTimeout(repeat, 0); repeat()`,
    `try { setTimeout(() => {}, 2001); } catch {}`,
  ]) it('rejects deferred semantic changes or unbounded work: ' + effect, async () => {
    const request = candidate([{ kind: 'script', label: 'bad-ui', source: `
      const init = Blockly.Blocks.native_candidate_test.init;
      Blockly.Blocks.native_candidate_test.init = function() { init.call(this); setTimeout(() => { ${effect}; }, 0); };
    ` }]);
    await expectAsync(run(request)).toBeRejected();
    await run(candidate());
  });

  for (const effect of ['queueMicrotask(() => {})', 'Promise.resolve().then(() => {})'])
  it('rejects caught state-neutral configuration tasks: ' + effect, async () => {
    const request = candidate([{ kind: 'script', label: 'late-init', source: `
      const init = Blockly.Blocks.native_candidate_test.init;
      Blockly.Blocks.native_candidate_test.init = function() { init.call(this); try { ${effect}; } catch {} };
    ` }]);
    await expectAsync(run(request)).toBeRejectedWithError(/does not support/);
  });

  it('discards partial registry/block changes on errors and accepts the next clean candidate', async () => {
    const request = candidate([{ kind: 'script', label: 'broken', source: `
      Blockly.Msg.CANDIDATE_ERROR = 'child';
      Blockly.getMainWorkspace().newBlock('native_candidate_test'); throw Error('extension failed');
    ` }]);
    await expectAsync(run(request)).toBeRejectedWithError(/extension failed/);
    expect(Blockly.Msg['CANDIDATE_ERROR']).toBeUndefined();
    await run(candidate());
  });

  it('rejects unrequested models and blocks instead of adopting side effects', async () => {
    for (const source of [`Blockly.getMainWorkspace().createVariable('extra')`, `Blockly.getMainWorkspace().newBlock('native_candidate_test')`]) {
      await expectAsync(run(candidate([{ kind: 'script', label: 'extra', source }]))).toBeRejectedWithError(/workspace state/);
    }
    const request = candidate([{ kind: 'script', label: 'init-effect', source: `
      const original = Blockly.Blocks.native_candidate_test.init;
      Blockly.Blocks.native_candidate_test.init = function() { original.call(this); this.workspace.createVariable('extra'); };
    ` }]);
    await expectAsync(run(request)).toBeRejectedWithError(/unrequested blocks or models/);
  });

  it('uses real DHT and MAX31865 native configuration without host probes or source templates', async () => {
    const pins = [['P5', '5'], ['P18', '18']];
    const definitions = Object.values(nativeHardwareFixtures).flatMap(fixture => JSON.parse(JSON.stringify(fixture.blocks).replaceAll('"${board.digitalPins}"', JSON.stringify(pins))));
    const request: NativeCandidateRequest = {
      steps: [{ kind: 'context', boardConfig: { digitalPins: pins, i2c: [['Wire', 'Wire'], ['Wire1', 'Wire1']] } },
        ...Object.values(nativeHardwareFixtures).map((fixture, i): NativeReplayStep => ({ kind: 'script', label: `fixture-${i}`, source: fixture.source })),
        { kind: 'definitions', definitions }],
      blocks: [
        { id: 'dht', type: 'dht_init', fields: [{ name: 'TYPE', value: 'DHT20' }, { name: 'WIRE', value: 'Wire1' }] },
        { id: 'rtd', type: 'max31865_init', fields: [{ name: 'SPI_MODE', value: 'SW' }, { name: 'SW_MOSI_PIN', value: '18' }] },
      ],
    };
    const probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    const result = await run(request);
    expect(probe).not.toHaveBeenCalled();
    expect(result.state['blocks'].blocks.find(block => block.id === 'dht').fields.WIRE).toBe('Wire1');
    const rtd = result.structures.find(block => block.id === 'rtd')!;
    const order = nativeAbsArgumentOrder(definitions.find(block => block.type === rtd.type), rtd.rows as unknown as NativeInputDeclaration[]);
    expect(order?.map(arg => arg.name)).toEqual(['VAR', 'SPI_MODE', 'CS_PIN', 'WIRES', 'SW_SCK_PIN', 'SW_MOSI_PIN', 'SW_MISO_PIN']);
    request.blocks[0].fields = [{ name: 'PIN', value: '18' }, { name: 'TYPE', value: 'DHT22' }];
    await expectAsync(run(request)).toBeRejectedWithError(/overwrote field/);
  });

  it('does not silently skip missing fields, invalid values or duplicate identities', async () => {
    const missing = candidate(); missing.blocks[0].fields[0].name = 'MISSING';
    await expectAsync(run(missing)).toBeRejectedWithError(/unavailable/);
    const duplicate = candidate(); duplicate.blocks.push(duplicate.blocks[0]);
    await expectAsync(run(duplicate)).toBeRejectedWithError(/unique/);
    const coerced = candidate(); coerced.blocks[0].fields[0].value = 12;
    await expectAsync(run(coerced)).toBeRejectedWithError(/did not retain/);
  });

  it('checks cancellation and freshness before exposing a result', async () => {
    const abort = new AbortController(); abort.abort(new Error('cancelled'));
    await expectAsync(evaluateNativeCandidate(candidate(), { signal: abort.signal, assertCurrent: () => {} })).toBeRejectedWithError('cancelled');
    let calls = 0;
    await expectAsync(evaluateNativeCandidate(candidate(), { assertCurrent: () => { if (++calls >= 3) throw Error('stale'); } })).toBeRejectedWithError('stale');
  });

  it('retains native extraState or rejects ignored state without manual input synthesis', async () => {
    const request = candidate([{ kind: 'script', label: 'mutator', source: `
      const oldInit = Blockly.Blocks.native_candidate_test.init;
      Blockly.Blocks.native_candidate_test.init = function() {
        oldInit.call(this);
        this.loadExtraState = state => { this.count = state.count; this.appendValueInput('DYNAMIC'); };
        this.saveExtraState = () => ({ count: this.count });
      };
    ` }]);
    request.blocks[0].extraState = { count: 1 };
    const result = await run(request);
    expect(result.state['blocks'].blocks[0].extraState).toEqual({ count: 1 });
    request.steps.push({ kind: 'script', label: 'ignored-state', source: `
      const currentInit = Blockly.Blocks.native_candidate_test.init;
      Blockly.Blocks.native_candidate_test.init = function() { currentInit.call(this); this.saveExtraState = () => ({count: 0}); };
    ` });
    await expectAsync(run(request)).toBeRejectedWithError(/extraState/);
  });

  it('rejects serializer callbacks changing requested state after initial field checks', async () => {
    const request = candidate([{ kind: 'script', label: 'serializer-effect', source: `
      const oldInit = Blockly.Blocks.native_candidate_test.init;
      Blockly.Blocks.native_candidate_test.init = function() {
        oldInit.call(this);
        this.saveExtraState = () => { this.setFieldValue('lost', 'TEXT'); return {}; };
      };
    ` }]);
    await expectAsync(run(request)).toBeRejectedWithError(/serialization changed requested field|configuration overwrote field/);
  });

  it('compares nested extraState by JSON value while retaining array order', async () => {
    const request = candidate([{ kind: 'script', label: 'state-key-order', source: `
      const definition = Blockly.Blocks.native_candidate_test;
      definition.loadExtraState = function(state) { this.state = state; };
      definition.saveExtraState = function() {
        return { z: this.state.z, a: { last: this.state.a.last, first: this.state.a.first } };
      };` }]);
    request.blocks[0].extraState = { a: { first: 1, last: 2 }, z: [7, 9] };
    expect((await run(request)).state['blocks'].blocks[0].extraState).toEqual(request.blocks[0].extraState);
    request.steps.push({ kind: 'script', label: 'changed-array-order', source: `
      Blockly.Blocks.native_candidate_test.saveExtraState = function() { return { a: this.state.a, z: this.state.z.slice().reverse() }; };` });
    await expectAsync(run(request)).toBeRejectedWithError(/requested extraState/);
  });

  it('keeps request objects detached from field and extraState callbacks', async () => {
    const field = candidate([{ kind: 'script', label: 'mutating-load', source: `
      const init = Blockly.Blocks.native_candidate_test.init;
      Blockly.Blocks.native_candidate_test.init = function() {
        init.call(this); const field = this.getField('TEXT');
        field.loadState = value => { value.data = 'changed'; field.data = value; };
        field.saveState = () => field.data;
      };
    ` }]);
    field.blocks[0].fields[0].value = { data: 'requested' };
    await expectAsync(run(field)).toBeRejectedWithError(/did not retain requested value/);
    expect(field.blocks[0].fields[0].value).toEqual({ data: 'requested' });
    const extra = candidate([{ kind: 'script', label: 'mutating-extra', source: `
      const init = Blockly.Blocks.native_candidate_test.init;
      Blockly.Blocks.native_candidate_test.init = function() {
        init.call(this);
        this.loadExtraState = value => { value.count = 2; this.data = value; };
        this.saveExtraState = () => this.data;
      };
    ` }]);
    extra.blocks[0].extraState = { count: 1 };
    await expectAsync(run(extra)).toBeRejectedWithError(/requested extraState/);
    expect(extra.blocks[0].extraState).toEqual({ count: 1 });
  });

  it('captures source order in the active runtime and invalidates replay on changes', async () => {
    const runtime = new BlocklyGeneratorRuntimeService();
    try {
      runtime.activate({ mode: 'arduino', boardConfig: { value: 'first' }, getWorkspace: () => null });
      runtime.loadGenerator('first.js', `const replayLabel = boardConfig.value;`);
      runtime.updateBoardConfig({ value: 'second' });
      runtime.loadGenerator('second.js', `if (replayLabel !== 'first' || boardConfig.value !== 'second') throw Error('order');`);
      runtime.recordNativeBlockDefinitions([definition]);
      const replay = runtime.captureNativeReplay();
      expect(replay.steps.map(step => step.kind)).toEqual(['context', 'script', 'context', 'script', 'definitions']);
      const result = await runtime.evaluateNativeCandidate(candidate().blocks, { assertCurrent: () => {} });
      expect(result.state['blocks'].blocks[0].id).toBe('candidate-id');
      const locale = runtime.captureNativeReplay(); runtime.refreshBlocklyMessageSnapshot();
      expect(() => locale.assertCurrent()).toThrow();
      runtime.setLibraryI18n('changed', {}); expect(() => replay.assertCurrent()).toThrow();
      const other = runtime.captureNativeReplay(); runtime.destroy(); expect(() => other.assertCurrent()).toThrow();
    } finally { runtime.destroy(); }
  });
});
