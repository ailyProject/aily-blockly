import { createNativeCandidateRecovery } from '../../../editors/blockly-editor/services/blockly-native-candidate-recovery';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import { nativeCandidateTimeout } from '../../../editors/blockly-editor/services/blockly-native-progress';

describe('bounded disposable candidate recovery', () => {
  const request = () => ({ blocks: [], steps: [] });
  const result = { state: {}, structures: [] };

  it('adds no execution or explicit budget on success', async () => {
    const execute = jasmine.createSpy().and.resolveTo(result);
    expect(await createNativeCandidateRecovery(execute, () => {})(request())).toBe(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.calls.first().args[1].timeoutMs).toBeUndefined();
  });

  it('recovers exact input once after cleanup, with a complete 30s retry budget', async () => {
    let active = false;
    const input = request(), budgets: Array<number | undefined> = [];
    const execute = jasmine.createSpy().and.callFake(async (snapshot, options) => {
      expect(active).toBeFalse(); active = true; budgets.push(options.timeoutMs);
      try {
        expect(snapshot).toEqual(request());
        if (budgets.length === 1) {
          snapshot.blocks.push({ type: 'ignored' }); input.blocks.push({ type: 'external' } as never);
          throw nativeCandidateTimeout('replay', 10000);
        }
        return result;
      } finally { active = false; }
    });
    expect(await createNativeCandidateRecovery(execute, () => { expect(active).toBeFalse(); })(input)).toBe(result);
    expect(budgets).toEqual([undefined, 30000]);
  });

  it('shares the single allowance across binding and verification; never loops', async () => {
    let calls = 0;
    const error = nativeCandidateTimeout('ui', 10000);
    const execute = jasmine.createSpy().and.callFake(async () => { if (++calls !== 2) throw error; return result; });
    const run = createNativeCandidateRecovery(execute, () => {});
    expect(await run(request())).toBe(result);
    await expectAsync(run(request())).toBeRejectedWith(error);
    expect(calls).toBe(3);
    const fail = jasmine.createSpy().and.rejectWith(error);
    await expectAsync(createNativeCandidateRecovery(fail, () => {})(request())).toBeRejectedWith(error);
    expect(fail).toHaveBeenCalledTimes(2);
  });

  for (const code of ['ABS_SYNTAX_INVALID', 'ABS_NATIVE_EFFECT_UNSUPPORTED', 'ABS_RUNTIME_CONTRACT_STALE', 'AbortError'])
    it('never retries ' + code, async () => {
      const error = Object.assign(new Error(code), { code });
      const execute = jasmine.createSpy().and.rejectWith(error);
      await expectAsync(createNativeCandidateRecovery(execute, () => {})(request())).toBeRejectedWith(error);
      expect(execute).toHaveBeenCalledTimes(1);
    });

  it('rechecks the full host scope after timeout and refuses recovery when it changed', async () => {
    let valid = true;
    const execute = jasmine.createSpy().and.callFake(async () => { valid = false; throw nativeCandidateTimeout('load', 10000); });
    await expectAsync(createNativeCandidateRecovery(execute, () => { if (!valid) throw Error('scope changed'); })(request()))
      .toBeRejectedWithError('scope changed');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('cleans up the timed-out real realm before recovering in a fresh realm', async () => {
    const Channel = window.MessageChannel, schedule = window.setTimeout.bind(window);
    const timers = spyOn(window, 'setTimeout').and.callThrough();
    let realms = 0, fired = false;
    spyOn(window, 'MessageChannel').and.callFake(function () {
      expect(document.querySelector('[data-blockly-native-candidate]')).toBeNull();
      const channel = new Channel(), first = ++realms === 1;
      channel.port1.addEventListener('message', event => {
        if (!first || fired || event.data.replay?.event !== 'drain-start') return;
        fired = true;
        const watchdog = timers.calls.allArgs().find(args => args[1] === 10000)?.[0];
        if (typeof watchdog !== 'function') throw Error('missing watchdog');
        schedule(() => watchdog(), 0);
      });
      return channel;
    });
    const run = createNativeCandidateRecovery(evaluateNativeCandidate, () => {});
    const recovered = await run({ blocks: [{ type: 'recovery_probe', id: 'probe', fields: [] }], steps: [{ kind: 'script', label: 'recovery/generator.js',
      source: 'setTimeout(() => { Blockly.Blocks.recovery_probe = { init() { this.appendDummyInput(); } }; }, 50);' }] });
    expect(recovered.state['blocks'].blocks[0].type).toBe('recovery_probe');
    expect(realms).toBe(2); expect(fired).toBeTrue();
    expect(document.querySelector('[data-blockly-native-candidate]')).toBeNull();
  });
});
