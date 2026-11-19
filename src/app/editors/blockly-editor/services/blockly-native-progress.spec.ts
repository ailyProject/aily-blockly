import { serializeAbsFailure } from '../../../integrations/blockly/abs/abs-diagnostics';
import { nativeCandidateBudget, nativeCandidateTimeout } from './blockly-native-progress';

describe('Native candidate timeout recovery guidance', () => {
  it('offers preserving tool inspection rather than delegating internal recovery to the user', () => {
    const failure = serializeAbsFailure(nativeCandidateTimeout('binding', 10000));
    expect(failure.code).toBe('ABS_NATIVE_TIMEOUT');
    expect(failure.diagnostic?.hint).toContain('project_recover(action="inspect")');
    expect(failure.diagnostic?.hint).not.toMatch(/ask the user|restart|reducing load/i);
    expect(failure.diagnostic?.hint).toMatch(/offered|offers/);
    expect(failure.diagnostic?.hint?.length).toBeLessThanOrEqual(256);
  });

  it('preserves the original phase, budget and bounded timing instead of increasing execution limits', () => {
    const timing = { elapsedMs: 10000, lastObservationAgeMs: 250, realmElapsedMs: 9750,
      completedPhases: [{ phase: 'realm', elapsedMs: 400 }, { phase: 'binding', elapsedMs: 9350 }] };
    const failure = serializeAbsFailure(nativeCandidateTimeout('binding', 10000, timing));
    expect(failure.message).toBe('Native candidate timed out during binding (10000ms budget).');
    expect(failure.diagnostic?.reason).toBe('native-timeout-binding');
    expect(failure.diagnostic?.nativeTiming).toEqual(timing);
    expect(nativeCandidateBudget(10000, 2)).toEqual({ perPassMs: 10000, totalMs: 10000 });
    expect(() => nativeCandidateBudget(60001, 1)).toThrowError(/Invalid native candidate timeout/);
  });
});
