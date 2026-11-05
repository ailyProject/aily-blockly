import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import { createNativeCandidateRecovery } from '../../../editors/blockly-editor/services/blockly-native-candidate-recovery';
import type { NativeCandidateOptions, NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { indexAbsAbi } from './abs-abi-index';
import { createAbsReadbackVerifier } from './abs-readback';

/** Synthetic graph in the real disposable native runtime. No user project,
 * model, host filesystem, credentials or library downloads participate. */
describe('1243-node native preparation acceptance', () => {
  const size = 1243, callbacks = 53, chainLength = 63, variableCount = 97;
  function request(mutate = false): NativeCandidateRequest {
    const fields = {}, roots: any[] = [];
    for (let start = 0; start < size; start += chainLength) {
      let tail: any;
      for (let n = Math.min(start + chainLength - 1, size - 1); n >= start; n--) {
        const id = `scale-${n}`;
        fields[id] = { TEXT: { type: 'field_input' }, NUM: { type: 'field_number' } };
        tail = { id, type: 'scale_native_probe', fields: { TEXT: `value-${n}`, NUM: n },
          data: JSON.stringify({ ordinal: n, retained: '中文 metadata' }),
          deletable: n % 11 !== 0, movable: n % 13 !== 0, editable: n % 17 !== 0,
          ...(tail ? { next: { block: tail } } : {}) };
      }
      tail.x = 30 + (roots.length % 8) * 250; tail.y = 40 + Math.floor(roots.length / 8) * 1800;
      roots.push(tail);
    }
    roots[0].icons = { comment: { text: 'Retain complete native comment', pinned: true, width: 240, height: 120, x: 410, y: 230 } };
    return { blocks: [], steps: [{ kind: 'context', mode: 'arduino' }, {
      kind: 'script', label: 'synthetic-scale-probe', source: `
        Blockly.Blocks.scale_native_probe = { init() {
          this.appendDummyInput().appendField(new Blockly.FieldTextInput(''), 'TEXT')
            .appendField(new Blockly.FieldNumber(0), 'NUM');
          this.setPreviousStatement(true); this.setNextStatement(true);
          if (this.id === 'scale-0') for (let i = 0; i < ${callbacks}; i++) setTimeout(() => {
            ${mutate ? "if (i === 0) this.setFieldValue('changed', 'TEXT'); if (i === 1) this.setFieldValue('value-0', 'TEXT');" : "this.setTooltip('native UI ready');"}
          }, 0);
        } };
        Arduino.forBlock.scale_native_probe = () => '';
      `,
    }], verify: { state: { blocks: { blocks: roots }, variables: Array.from({ length: variableCount }, (_, n) =>
      ({ id: `scale-variable-${n}`, name: `retainedVariable${n}` })) }, contracts: { fields } } };
  }

  function observe(onPartial?: () => void) {
    const Channel = window.MessageChannel;
    const records: Array<{ callbacks: number; snapshots: number; pending: number }> = [];
    let realms = 0, partial = false;
    spyOn(window, 'MessageChannel').and.callFake(function () {
      const channel = new Channel(); realms++;
      channel.port1.addEventListener('message', event => {
        const ui = event.data?.ui;
        if (!ui) return;
        records.push({ callbacks: ui.callbacks, snapshots: ui.snapshots, pending: ui.pending });
        if (!partial && ui.callbacks > 0 && ui.pending > 0) { partial = true; onPartial?.(); }
      });
      return channel;
    });
    return { records, get realms() { return realms; }, get partial() { return partial; } };
  }

  function report(value: Record<string, unknown>) {
    console.info('NATIVE_SCALE_RESULT', JSON.stringify({ synthetic: true, userProjectAccess: false, blocks: size,
      roots: Math.ceil(size / chainLength), maximumChainLength: chainLength, variables: variableCount, ...value }));
  }
  afterEach(() => { expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0); });

  it('prepares cold and warm complete graphs once with the upfront allowance and full native metadata', async () => {
    const observed = observe();
    for (const run of ['cold', 'warm']) {
      const recordStart = observed.records.length, realmStart = observed.realms;
      const input = request(), original = JSON.stringify(input), start = performance.now();
      const budgets: number[] = [];
      const execute = jasmine.createSpy().and.callFake((value, options) => {
        budgets.push(options.timeoutMs); return evaluateNativeCandidate(value, options);
      });
      const result = await createNativeCandidateRecovery(execute, () => {})(input);
      const elapsedMs = performance.now() - start;
      expect(execute).toHaveBeenCalledTimes(1); expect(budgets).toEqual([30000]);
      createAbsReadbackVerifier(input.verify!.state)(result.state as any);
      const expected = indexAbsAbi(input.verify!.state), actual = indexAbsAbi(result.state as any);
      expect(actual.size).toBe(size);
      expect(result.state['variables']).toEqual(input.verify!.state['variables']);
      let metadataPreserved = true;
      for (const [id, source] of expected) {
        const loaded = actual.get(id)!;
        expect(loaded.fields).toEqual(source.fields); expect(loaded['data']).toBe(source['data']);
        expect(loaded['deletable'] ?? true).toBe(source['deletable']);
        expect(loaded['movable'] ?? true).toBe(source['movable']); expect(loaded['editable'] ?? true).toBe(source['editable']);
        metadataPreserved &&= loaded['data'] === source['data'] && (loaded['deletable'] ?? true) === source['deletable']
          && (loaded['movable'] ?? true) === source['movable'] && (loaded['editable'] ?? true) === source['editable'];
      }
      expect(actual.get('scale-0')!['icons']).toEqual(expected.get('scale-0')!['icons']);
      expect(JSON.stringify(input)).toBe(original);
      const completed = observed.records.slice(recordStart).filter(value => value.callbacks >= callbacks && value.pending === 0);
      expect(completed.length).toBeGreaterThan(0);
      expect(completed.every(value => value.snapshots >= value.callbacks + 1)).toBeTrue();
      report({ run, elapsedMs, executions: execute.calls.count(), budgets, realms: observed.realms - realmStart,
        fullReadback: true, nativeBlockMetadataPreserved: metadataPreserved, callbackGuardMinimumSnapshots: callbacks + 1,
        observedMaximumSnapshots: Math.max(...completed.map(value => value.snapshots)) });
    }
  }, 90000);

  for (const mode of ['scope', 'signal'] as const) it(`cancels real preparation through ${mode} without a new allowance or leaked realm`, async () => {
    const controller = new AbortController(), cancelled = Object.assign(new Error('scale preparation cancelled'), { code: 'AbortError' });
    let current = true, cancelledAt = 0;
    const observed = observe(() => {
      cancelledAt = performance.now(); current = false;
      if (mode === 'signal') controller.abort(cancelled);
    });
    const execute = jasmine.createSpy().and.callFake((value, options: NativeCandidateOptions) =>
      evaluateNativeCandidate(value, { ...options, ...(mode === 'signal' ? { signal: controller.signal } : {}) }));
    const check = () => { if (!current) throw cancelled; };
    const start = performance.now();
    let failure: unknown;
    try { await createNativeCandidateRecovery(execute, check)(request()); } catch (error) { failure = error; }
    expect(failure).toBe(cancelled);
    expect(observed.partial).toBeTrue(); expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.calls.first().args[1].timeoutMs).toBe(30000);
    report({ run: `cancel-${mode}`, elapsedMs: performance.now() - start,
      cancellationResponseMs: cancelledAt ? performance.now() - cancelledAt : null, cancelled: failure === cancelled,
      executions: execute.calls.count(), realms: observed.realms,
      note: mode === 'scope' ? 'Production recovery uses assertCurrent; this measures its actual result boundary.'
        : 'AbortSignal is explicitly supplied to the evaluator adapter; this is not an Agent Stop latency claim.' });
  }, 40000);

  it('still rejects one callback mutation before a later callback can restore the same 1243-node graph', async () => {
    const observed = observe(), execute = jasmine.createSpy().and.callFake(evaluateNativeCandidate);
    let failure: any;
    try { await createNativeCandidateRecovery(execute, () => {})(request(true)); } catch (error) { failure = error; }
    expect(failure?.message).toMatch(/changed persisted state/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(failure?.code).toBe('ABS_NATIVE_UI_CONTRACT_CHANGED');
    expect(failure?.diagnostic?.blockId).toBe('scale-0'); expect(failure?.diagnostic?.field).toBe('TEXT');
    expect(failure?.diagnostic?.expected).toBe('value-0'); expect(failure?.diagnostic?.received).toBe('changed');
    report({ run: 'callback-mutation', executions: execute.calls.count(), individualCallbackRejected: /changed persisted state/.test(failure?.message ?? ''),
      actualErrorCode: failure?.code, realms: observed.realms });
  }, 40000);
});
