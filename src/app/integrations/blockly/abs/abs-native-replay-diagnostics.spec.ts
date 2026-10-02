import { nativeReplayEvent, describeNativeReplayEvent } from '../../../editors/blockly-editor/services/blockly-native-replay-diagnostics';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeReplayStep } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';

describe('native replay observations', () => {
  it('keeps only bounded scalar observations and never transports arbitrary realm properties', () => {
    expect(nativeReplayEvent({ event: 'step-start', step: 1, source: 'private source' })).toEqual({ event: 'step-start', step: 1 });
    for (const value of [null, {}, { event: 'other', step: 0 }, { event: 'step-start', step: -1 },
      { event: 'step-start', step: 1.5 }, { event: 'timer-start', step: 0, id: 1, pending: 0, delayMs: Infinity, elapsedMs: 1 }]) {
      expect(nativeReplayEvent(value)).toBeUndefined();
    }
    const value = { event: 'timer-start', step: 0, id: 1, pending: 0, delayMs: 200, elapsedMs: 250 };
    expect(nativeReplayEvent(value)).toEqual(value as any);
  });

  it('describes the host-owned step using a short package/file suffix, not source or project path', () => {
    const steps: NativeReplayStep[] = [{ kind: 'script', label: 'C:\\private-project\\node_modules\\@aily-project\\lib-example\\generator.js', source: 'secret source' }];
    const description = describeNativeReplayEvent({ event: 'step-start', step: 0 }, steps);
    expect(description).toBe('step-start step=0 script lib-example/generator.js');
    expect(description).not.toContain('secret'); expect(description).not.toContain('private-project');
    expect(describeNativeReplayEvent({ event: 'step-start', step: 100 }, steps)).toBe('');
    expect(describeNativeReplayEvent({ event: 'step-end', step: 0 }, [{ kind: 'script', source: '',
      label: 'https://user:password@example.invalid/lib/generator.js?token=secret#private' }])).toBe('step-end step=0 script lib/generator.js');
  });

  it('observes native step order, registration waits and timer origin without modifying the result', async () => {
    const Channel = window.MessageChannel, events: any[] = [];
    spyOn(window, 'MessageChannel').and.callFake(function () {
      const channel = new Channel();
      channel.port1.addEventListener('message', event => {
        if (event.data.replay) events.push(event.data);
      });
      return channel;
    });
    const result = await evaluateNativeCandidate({ blocks: [{ type: 'replay_trace_probe', id: 'probe', fields: [] }], steps: [{
      kind: 'script', label: 'probe/generator.js', source: `
        setTimeout(() => { setTimeout(() => { Blockly.Blocks.replay_trace_probe = { init() { this.appendDummyInput().appendField('ready'); } }; }, 0); }, 10);
      `,
    }, { kind: 'messages', value: {} }] }, { assertCurrent() {} });
    expect(result.state['blocks'].blocks[0].type).toBe('replay_trace_probe');
    expect(events.map(value => value.replay.event)).toEqual([
      'step-start', 'timer-scheduled', 'step-end', 'step-start', 'step-end', 'drain-start',
      'timer-start', 'timer-scheduled', 'timer-end', 'timer-start', 'timer-end', 'drain-end',
    ]);
    expect(events.every(value => value.phase === 'replay' && value.elapsedMs >= 0)).toBeTrue();
    expect(events.filter(value => value.replay.event.startsWith('timer-')).every(value => value.replay.step === 0)).toBeTrue();
    const scheduled = events.find(value => value.replay.event === 'timer-scheduled').replay;
    const started = events.find(value => value.replay.event === 'timer-start').replay;
    expect(started.id).toBe(scheduled.id); expect(started.delayMs).toBe(10); expect(started.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(result)).not.toContain('replay');
    expect(document.querySelector('[data-blockly-native-candidate]')).toBeNull();
  });

  it('reports the last delivered registration wait when the host watchdog fires, then removes the realm', async () => {
    const Channel = window.MessageChannel, schedule = window.setTimeout.bind(window);
    const timers = spyOn(window, 'setTimeout').and.callThrough();
    spyOn(window, 'MessageChannel').and.callFake(function () {
      const channel = new Channel();
      channel.port1.addEventListener('message', event => {
        if (event.data.replay?.event !== 'drain-start') return;
        // Fire the real host watchdog deterministically after its observation
        // handler runs. No CPU busy-loop, clock sleep or changed library timer.
        const watchdog = timers.calls.allArgs().find(args => args[1] === 10000)?.[0];
        if (typeof watchdog !== 'function') throw Error('missing native watchdog');
        schedule(() => watchdog(), 0);
      });
      return channel;
    });
    try {
      await evaluateNativeCandidate({ blocks: [], steps: [{ kind: 'script',
        label: 'C:/private/lib-probe/generator.js', source: 'setTimeout(() => {}, 2000);' }] }, { assertCurrent() {} });
      fail('accepted timed-out replay');
    } catch (error) {
      expect(error.code).toBe('ABS_NATIVE_TIMEOUT');
      expect(error.message).toContain('during replay (10000ms budget)');
      expect(error.message).toContain('drain-start registration tasks');
      expect(error.message).toContain('Outstanding registration observations: timer-scheduled step=0 script lib-probe/generator.js');
      expect(error.message).toContain('requested=2000ms');
      expect(error.message).toContain('not proof of the current execution point');
      expect(error.message).not.toContain('private');
    }
    expect(document.querySelector('[data-blockly-native-candidate]')).toBeNull();
  });
});
