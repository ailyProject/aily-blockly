import * as Blockly from 'blockly';
import { NativeUiTasks, nativeUiSemanticSnapshot } from '../../../editors/blockly-editor/services/blockly-native-ui-tasks';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { assertNativeGenerationStable } from '../../../editors/blockly-editor/services/blockly-native-generation-evidence';
import type { AbsNativeUiTiming } from './abs-diagnostics';
import { beginNativeFieldDependencies } from '../../../editors/blockly-editor/services/blockly-native-field-dependencies';

describe('native deferred UI effect boundary', () => {
  it('does not treat layout-different generation inputs as identical program output evidence', () => {
    const workspace = new Blockly.Workspace(), generator = new Blockly.CodeGenerator('layout-proof');
    Blockly.Blocks['layout_order_probe'] = { init() { this.appendDummyInput(); } };
    generator.forBlock['layout_order_probe'] = block => block.id + ';\n';
    try {
      Blockly.serialization.workspaces.load({ blocks: { blocks: [
        { type: 'layout_order_probe', id: 'existing', x: 30, y: 500 },
        { type: 'layout_order_probe', id: 'new', x: 30, y: 130 },
      ] } }, workspace);
      const before = generator.workspaceToCode(workspace);
      workspace.getBlockById('new')!.moveBy(0, 600);
      const after = generator.workspaceToCode(workspace);
      expect(before).toBe('new;\n\nexisting;\n'); expect(after).toBe('existing;\n\nnew;\n');
      // No fields, models, connections or IDs changed. Comparing raw code across
      // these layouts would reject an ordinary host placement of a new root.
      expect(before).not.toBe(after);
    } finally { workspace.dispose(); delete Blockly.Blocks['layout_order_probe']; }
  });
  it('accepts restored intermediate state at the complete synchronous phase boundary', () => {
    const tasks = new NativeUiTasks(); let state = 'before', calls = 0;
    tasks.set(() => { state = 'changed'; calls++; });
    tasks.set(() => { state = 'before'; calls++; });
    expect(() => tasks.drain(() => state)).not.toThrow();
    expect(calls).toBe(2);
  });
  it('uses virtual elapsed time, rather than adding parallel block UI delays', () => {
    const tasks = new NativeUiTasks(); let calls = 0, snapshots = 0;
    for (let i = 0; i < 80; i++) tasks.set(() => { calls++; }, 100);
    tasks.drain(() => { snapshots++; return 'same'; });
    expect(calls).toBe(80);
    expect(snapshots).toBe(2);
  });
  it('cooperatively yields a real host macrotask while retaining every callback and complete readback', async () => {
    const tasks = new NativeUiTasks(undefined, () => 0), order: number[] = [];
    let snapshots = 0, yields = 0, hostObservedAfter = -1;
    for (let i = 0; i < 20; i++) tasks.set(() => { order.push(i); });
    const schedule = window.setTimeout.bind(window);
    schedule(() => { hostObservedAfter = order.length; }, 0);
    await tasks.drainCooperatively(() => { snapshots++; return 'same'; }, () => {
      yields++; return new Promise(resolve => { schedule(resolve, 0); });
    }, () => {});
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(hostObservedAfter).toBe(8); expect(yields).toBe(2);
    expect(snapshots).toBe(2);
  });
  it('uses elapsed slice work as well as callback count to offer the host a turn', async () => {
    let now = 0, callbacks = 0, yields = 0, snapshots = 0;
    const tasks = new NativeUiTasks(undefined, () => now);
    for (let i = 0; i < 4; i++) tasks.set(() => { now += 9; callbacks++; });
    await tasks.drainCooperatively(() => { snapshots++; return 'same'; }, async () => { yields++; }, () => {});
    expect(callbacks).toBe(4); expect(yields).toBe(3); expect(snapshots).toBe(2);
  });
  it('preserves virtual due time, cancellation and insertion order across cooperative slices', async () => {
    const expected: string[] = [], actual: string[] = [];
    const configure = (tasks: NativeUiTasks, order: string[]) => {
      for (let i = 0; i < 9; i++) tasks.set(() => { order.push('parallel-' + i); }, 0);
      tasks.set(() => { order.push('first'); tasks.set(() => order.push('nested'), 0); }, 10);
      tasks.set(() => { order.push('same-due'); }, 10);
      const cancelled = tasks.set(() => { order.push('cancelled'); }, 5); tasks.clear(cancelled);
      tasks.set(() => { order.push('late'); }, 20);
    };
    const sync = new NativeUiTasks(), cooperative = new NativeUiTasks(undefined, () => 0);
    configure(sync, expected); configure(cooperative, actual);
    sync.drain(() => 'same');
    await cooperative.drainCooperatively(() => 'same', async () => {}, () => {});
    expect(actual).toEqual(expected);
  });
  it('accepts restored intermediate state at the complete cooperative phase boundary', async () => {
    const tasks = new NativeUiTasks(), yieldToHost = jasmine.createSpy().and.resolveTo();
    let state = 'before', callbacks = 0;
    tasks.set(() => { state = 'changed'; callbacks++; });
    tasks.set(() => { state = 'before'; callbacks++; });
    await expectAsync(tasks.drainCooperatively(() => state, yieldToHost, () => {})).toBeResolved();
    expect(callbacks).toBe(2); expect(yieldToHost).not.toHaveBeenCalled();
  });
  it('compares complete settled meaning across host turns', async () => {
    const tasks = new NativeUiTasks(undefined, () => 0); let state = 'before', callbacks = 0, snapshots = 0;
    for (let i = 0; i < 8; i++) tasks.set(() => { callbacks++; });
    tasks.set(() => { state = 'before'; callbacks++; });
    await expectAsync(tasks.drainCooperatively(() => { snapshots++; return state; }, async () => {
      state = 'observer changed';
    }, () => {})).toBeResolved();
    expect(callbacks).toBe(9); expect(snapshots).toBe(2); expect(tasks.hasPending).toBeFalse();
  });
  it('rechecks the host-owned guard after a yield and does not consume another callback', async () => {
    const tasks = new NativeUiTasks(undefined, () => 0); let current = true, callbacks = 0;
    for (let i = 0; i < 9; i++) tasks.set(() => { callbacks++; });
    await expectAsync(tasks.drainCooperatively(() => 'same', async () => { current = false; }, () => {
      if (!current) throw Error('candidate scope changed');
    })).toBeRejectedWithError('candidate scope changed');
    expect(callbacks).toBe(8); expect(tasks.hasPending).toBeFalse();
  });
  it('does not resume or report success after disposal during an owned scheduler wait', async () => {
    const tasks = new NativeUiTasks(undefined, () => 0); let finish!: () => void, callbacks = 0;
    for (let i = 0; i < 9; i++) tasks.set(() => { callbacks++; });
    const pending = tasks.drainCooperatively(() => 'same', () => new Promise(resolve => { finish = resolve; }), () => {});
    expect(callbacks).toBe(8); tasks.dispose(); finish();
    await expectAsync(pending).toBeRejectedWithError(/disposed/);
    expect(callbacks).toBe(8); expect(tasks.hasPending).toBeFalse();
  });
  it('keeps rejected host scheduling sticky and never reopens the virtual queue', async () => {
    const tasks = new NativeUiTasks(undefined, () => 0), failure = Error('owned scheduler failed');
    for (let i = 0; i < 9; i++) tasks.set(() => {});
    await expectAsync(tasks.drainCooperatively(() => 'same', async () => { throw failure; }, () => {})).toBeRejectedWith(failure);
    expect(() => tasks.set(() => {})).toThrow(failure); expect(tasks.hasPending).toBeFalse();
  });
  it('does not grant Promise-returning callbacks or bypass the finite callback allowance', async () => {
    const tasks = new NativeUiTasks(undefined, () => 0);
    tasks.set(() => Promise.resolve());
    await expectAsync(tasks.drainCooperatively(() => 'same', async () => {}, () => {})).toBeRejectedWithError(/asynchronous UI callbacks/);
    const bounded = new NativeUiTasks(undefined, () => 0); let callbacks = 0, snapshots = 0, yields = 0;
    for (let i = 0; i < 512; i++) bounded.set(() => { callbacks++; });
    await bounded.drainCooperatively(() => { snapshots++; return 'same'; }, async () => { yields++; }, () => {});
    expect(callbacks).toBe(512); expect(yields).toBe(63); expect(snapshots).toBe(2);
    expect(() => bounded.set(() => {})).toThrowError(/finite callback/);
  });
  it('settles the outer construction queue cooperatively while retaining synchronous preparation', async () => {
    const workspace = new Blockly.Workspace(), tasks = new NativeUiTasks(undefined, () => 0);
    const scope = beginNativeFieldDependencies(Blockly, workspace, tasks, 'settled', false);
    let callbacks = 0, yields = 0;
    try {
      for (let i = 0; i < 20; i++) tasks.set(() => { callbacks++; });
      scope.prepare(); expect(callbacks).toBe(0);
      await scope.finishCooperatively(async () => { yields++; }, () => {});
      expect(callbacks).toBe(20); expect(yields).toBe(2);
    } finally { scope.dispose(); tasks.dispose(); workspace.dispose(); }
  });
  it('delivers real realm initialization progress and lets the host run before the candidate finishes', async () => {
    const Channel = window.MessageChannel, schedule = window.setTimeout.bind(window);
    let partialProgress = false, hostTurnDuringPreparation = false, completed = false;
    spyOn(window, 'MessageChannel').and.callFake(function () {
      const channel = new Channel();
      channel.port1.addEventListener('message', event => {
        const ui = event.data?.ui;
        if (!partialProgress && ui?.callbacks > 0 && ui.pending > 0) {
          partialProgress = true;
          schedule(() => { if (!completed) hostTurnDuringPreparation = true; }, 0);
        }
      });
      return channel;
    });
    const input: NativeCandidateRequest = { blocks: [{ id: 'owner', type: 'cooperative_realm_probe', fields: [] }], steps: [
      { kind: 'context', mode: 'arduino' }, { kind: 'script', label: 'cooperative-ui-probe', source: `
        Blockly.Blocks.cooperative_realm_probe = { init() {
          this.appendDummyInput();
          for (let i = 0; i < 32; i++) setTimeout(() => {
            const end = performance.now() + 2;
            while (performance.now() < end) {}
            this.setTooltip('ready');
          }, 0);
        } };
        Arduino.forBlock.cooperative_realm_probe = () => '';
      ` },
    ] };
    const result = await evaluateNativeCandidate(input, { assertCurrent() {} }); completed = true;
    expect(result.state['blocks'].blocks[0].type).toBe('cooperative_realm_probe');
    expect(partialProgress).toBeTrue(); expect(hostTurnDuringPreparation).toBeTrue();
    expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0);
  });
  it('keeps due-time and insertion order without sorting the whole queue', () => {
    const tasks = new NativeUiTasks(), order: string[] = [];
    tasks.set(() => { order.push('first'); tasks.set(() => order.push('nested'), 0); }, 10);
    const cancelled = tasks.set(() => order.push('cancelled'), 5); tasks.clear(cancelled);
    tasks.set(() => order.push('same-due'), 10);
    tasks.set(() => order.push('early'), 1);
    tasks.set(() => order.push('late'), 20);
    const sort = spyOn(Array.prototype, 'sort').and.callThrough();
    tasks.drain(() => 'same');
    expect(sort).not.toHaveBeenCalled();
    expect(order).toEqual(['early', 'first', 'same-due', 'nested', 'late']);
  });
  it('reports bounded aggregate callback/snapshot costs with complete phase readbacks', () => {
    let now = 0;
    const observations: AbsNativeUiTiming[] = [];
    const tasks = new NativeUiTasks(value => observations.push(value), () => now);
    for (let i = 0; i < 512; i++) tasks.set(() => { now += 2; });
    tasks.drain(() => { now += 3; return 'same'; });
    expect(observations.length).toBeLessThanOrEqual(54);
    expect(observations[0]).toEqual({ callbacks: 0, pending: 512, snapshots: 0, callbackMs: 0, snapshotMs: 0 });
    expect(observations[observations.length - 1]).toEqual({ callbacks: 512, pending: 0, snapshots: 2, callbackMs: 1024, snapshotMs: 6 });
    const count = observations.length;
    tasks.drain(() => { throw Error('must not snapshot an empty queue'); });
    expect(observations.length).toBe(count);
  });
  it('reports elapsed work before a 53-callback queue finishes without changing its readbacks', () => {
    let now = 0;
    const observations: AbsNativeUiTiming[] = [];
    const tasks = new NativeUiTasks(value => observations.push(value), () => now);
    for (let i = 0; i < 53; i++) tasks.set(() => { now += 2; });
    tasks.drain(() => { now += 7; return 'same'; });
    expect(observations.some(value => value.callbacks > 0 && value.callbacks < 53)).toBeTrue();
    expect(observations.length).toBeLessThanOrEqual(12);
    expect(observations[observations.length - 1]).toEqual({ callbacks: 53, pending: 0, snapshots: 2, callbackMs: 106, snapshotMs: 14 });
  });
  it('reports the callback threshold even when elapsed time has not advanced', () => {
    const observations: AbsNativeUiTiming[] = [];
    const tasks = new NativeUiTasks(value => observations.push(value), () => 0);
    for (let i = 0; i < 65; i++) tasks.set(() => {});
    tasks.drain(() => 'same');
    expect(observations.some(value => value.callbacks === 64 && value.pending === 1)).toBeTrue();
    expect(observations.length).toBe(3);
  });
  it('retains cost evidence when a callback changes persisted meaning', () => {
    let now = 0, state = 'before';
    const observations: AbsNativeUiTiming[] = [];
    const tasks = new NativeUiTasks(value => observations.push(value), () => now);
    tasks.set(() => { now += 7; state = 'changed'; });
    expect(() => tasks.drain(() => { now += 3; return state; })).toThrowError(/changed persisted state/);
    expect(observations[observations.length - 1]).toEqual({ callbacks: 1, pending: 0, snapshots: 2, callbackMs: 7, snapshotMs: 6 });
  });
  it('still bounds serial virtual time and individual timers with capacity diagnostics', () => {
    const tasks = new NativeUiTasks(); let calls = 0;
    const repeat = () => { calls++; tasks.set(repeat, 1000); };
    tasks.set(repeat, 1000);
    try { tasks.drain(() => 'same'); fail('accepted unbounded serial work'); }
    catch (error: any) {
      expect(error.code).toBe('ABS_LIMIT');
      expect(error.diagnostic.capacity).toEqual({ phase: 'ui', resource: 'virtualDelay', actual: 6000, limit: 5000 });
    }
    expect(calls).toBe(5);
    try { new NativeUiTasks().set(() => {}, 2001); fail('accepted a long individual timer'); }
    catch (error: any) { expect(error.diagnostic.capacity.resource).toBe('singleDelay'); }
  });
  it('admits parallel UI initialization in the isolated native realm without hiding callback mutations', async () => {
    for (const mutate of [false, true]) {
      const input: NativeCandidateRequest = { blocks: [], steps: [{ kind: 'context', mode: 'arduino' }, {
        kind: 'script', label: 'parallel-ui', source: `
          Blockly.Blocks.parallel_ui = { init() {
            this.appendDummyInput().appendField(new Blockly.FieldNumber(1), 'NUM');
            for (let i = 0; i < 80; i++) setTimeout(() => {
              ${mutate ? "if (i === 79) this.setFieldValue(2, 'NUM');" : "this.setTooltip('ready');"}
            }, 100);
          } };
          Arduino.forBlock.parallel_ui = () => '';
        `,
      }], verify: { state: { blocks: { blocks: [{ id: 'owner', type: 'parallel_ui', fields: { NUM: 1 }, x: 0, y: 0 }] } },
        contracts: { fields: { owner: { NUM: { type: 'field_number' } } } } } };
      if (mutate) await expectAsync(evaluateNativeCandidate(input, { assertCurrent() {} })).toBeRejectedWithError(/changed persisted state/);
      else expect((await evaluateNativeCandidate(input, { assertCurrent() {} })).state['blocks'].blocks[0].fields!['NUM']).toBe(1);
    }
  });
  it('bounds callback work after cancellations and checks complete phase snapshots', () => {
    const tasks = new NativeUiTasks(); let snapshots = 0;
    for (let i = 0; i < 512; i++) tasks.set(() => {});
    tasks.drain(() => { snapshots++; return 'same'; });
    expect(snapshots).toBe(2);
    expect(() => tasks.set(() => {})).toThrowError(/finite callback/);
    const cancelled = new NativeUiTasks();
    for (let i = 0; i < 512; i++) cancelled.clear(cancelled.set(() => {}));
    expect(() => cancelled.set(() => {})).toThrowError(/finite callback/);
  });
  for (const storage of ['generator', 'closure', 'global'])
  it('isolates first-generation state across UI verification passes: ' + storage, async () => {
    const counter = storage === 'generator' ? 'Arduino.callbackCounter' : storage === 'global' ? 'globalThis.callbackCounter' : 'callbackCounter';
    const input: NativeCandidateRequest = { blocks: [], steps: [{ kind: 'context', mode: 'arduino' }, {
      kind: 'script', label: 'stateful-callback-library', source: `
        let callbackCounter = 0;
        Blockly.Blocks.callback_owner = { init() { this.appendDummyInput(); setTimeout(() => this.setTooltip('ready'), 0); } };
        Arduino.forBlock.callback_owner = () => {
          ${counter} = (${counter} || 0) + 1;
          Arduino.addFunction('callback', 'void callback_' + ${counter} + '() {}'); return '';
        };
      `,
    }], verify: { state: { blocks: { blocks: [{ id: 'owner', type: 'callback_owner', x: 0, y: 0 }] } }, contracts: { fields: { owner: {} } } } };
    const first = await evaluateNativeCandidate(input, { assertCurrent() {} });
    const second = await evaluateNativeCandidate(input, { assertCurrent() {} });
    expect(first.state).toEqual(second.state);
    expect(first.generationEvidence).toBeUndefined();
    expect(input.verify!.uiPhase).toBeUndefined();
    expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0);
  });

  it('reports the first differing output without claiming an ABS model or identity failure', () => {
    try {
      assertNativeGenerationStable({ code: 'same\nfirst', artifacts: [], deferredUi: true },
        { code: 'same\nsecond', artifacts: [], deferredUi: true });
      fail('accepted changed code');
    } catch (error: any) {
      expect(error.code).toBe('ABS_GENERATION_UNSTABLE');
      expect(error.message).toContain('line 2');
      expect(error.diagnostic.received).toBe('before: first; after: second');
    }
  });
  it('allows dropdown labels but rejects changed option keys and number constraints', () => {
    const workspace = new Blockly.Workspace();
    Blockly.Blocks['ui_task_test'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([['label', 'A'], ['second', 'B']]), 'MODE')
        .appendField(new Blockly.FieldNumber(1, 0, 10), 'COUNT');
    } };
    try {
      const block = workspace.newBlock('ui_task_test');
      const snapshot = () => nativeUiSemanticSnapshot(Blockly, workspace);
      const tasks = new NativeUiTasks();
      tasks.set(() => { (block.getField('MODE') as any).menuGenerator_ = [['new label', 'A'], ['second', 'B']]; });
      tasks.drain(snapshot);
      for (const effect of [() => (block.getField('COUNT') as Blockly.FieldNumber).setMax(9),
        () => { (block.getField('MODE') as any).menuGenerator_ = [['new label', 'A']]; }]) {
        const rejected = new NativeUiTasks(); rejected.set(effect);
        expect(() => rejected.drain(snapshot)).toThrowError(/field constraints/);
      }
    } finally { workspace.dispose(); delete Blockly.Blocks['ui_task_test']; }
  });

  it('rejects timers scheduled by inspection, including caught errors', () => {
    const tasks = new NativeUiTasks(); tasks.set(() => {});
    expect(() => tasks.drain(() => { try { tasks.set(() => {}); } catch {} return 'state'; })).toThrow();
  });

  for (const scenario of ['code', 'artifact', 'generation-timer'])
  it('checks generated code and artifacts as well as serialized state: ' + scenario, async () => {
    const effect = scenario === 'generation-timer' ? 'try { setTimeout(() => {}, 0); } catch {}' : 'marker = 2';
    const duringGenerator = effect.includes('setTimeout');
    const input: NativeCandidateRequest = { blocks: [], steps: [{ kind: 'context', mode: 'arduino' }, {
      kind: 'script', label: 'ui-code-effect', source: `
        let marker = 1;
        Blockly.Blocks.ui_code_effect = { init() { this.appendDummyInput(); ${duringGenerator ? '' : `setTimeout(() => { ${effect}; }, 0);`} } };
        Arduino.forBlock.ui_code_effect = () => { ${duringGenerator ? effect : ''}; Arduino.addSetup('marker', ${scenario === 'artifact' ? '"constant"' : 'String(marker)'} + ';'); return ''; };
        ${scenario === 'artifact' ? `Arduino.getGeneratedArtifacts = () => [{fileName:'variables_marker-12345678.h',content:String(marker),sourceTag:'marker'}];` : ''}
      `,
    }], verify: { state: { blocks: { blocks: [{ id: 'owner', type: 'ui_code_effect', x: 0, y: 0 }] } }, contracts: { fields: { owner: {} } } } };
    await expectAsync(evaluateNativeCandidate(input, { assertCurrent() {} })).toBeRejectedWithError(duringGenerator ? /timers during generation/ : /changed generated code/);
  });
});
