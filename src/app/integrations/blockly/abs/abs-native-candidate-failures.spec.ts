import { AbsNativeCandidateFailures, type AbsNativeCandidateFailureInput } from './abs-native-candidate-failures';
import type { AbsGenerationCandidateRequest } from './abs-generation-protocol';
import { AbsSyncError } from './abs-state';

const hash = `sha256:${'a'.repeat(64)}`;
function fixture(key = 'precise-host-context'): AbsNativeCandidateFailureInput {
  const base = { generation: 'generation1', scope: { projectKey: 'project1', pageId: 'main' }, abiHash: hash, absHash: hash, mapHash: hash };
  const request: AbsGenerationCandidateRequest = { version: 2, requestId: 'original-client-request-id', base, candidate: { hash, bytes: 24 } };
  return { key, base, candidate: request.candidate, request, source: 'arduino_setup() {}',
    error: new AbsSyncError('ABS_NATIVE_TIMEOUT', 'Original native timeout', undefined, [], {
      phase: 'ui', reason: 'deadline', nativeTiming: { elapsedMs: 1000, lastObservationAgeMs: 20,
        completedPhases: [{ phase: 'load', elapsedMs: 200 }],
        ui: { callbacks: 53, pending: 0, snapshots: 54, callbackMs: 2, snapshotMs: 9 } },
    }) };
}

describe('native candidate failure recovery admission', () => {
  it('retains a bounded original diagnostic, not arbitrary error/source/request properties', async () => {
    const store = new AbsNativeCandidateFailures(), input = fixture();
    (input.error as any).privateState = { credential: 'do-not-serialize' };
    (input.error as any).diagnostic.secret = 'do-not-serialize';
    const description = (await store.remember(input))!;
    expect(description.version).toBe(1); expect(description.code).toBe('ABS_NATIVE_TIMEOUT');
    expect(description.message).toBe('Original native timeout');
    expect(description.diagnostic!.nativeTiming!.ui!.callbacks).toBe(53);
    expect(JSON.stringify(description)).not.toContain('do-not-serialize');
    expect(JSON.stringify(description)).not.toContain('arduino_setup');
    expect(description.recovery!.action).toBe('prepare_native');
    expect(description.recovery!.strategy).toBe('rebuild-library-runtime');
    expect(description.recovery!.requestId).not.toBe(input.request.requestId);
    expect(description.recovery!.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(description.recovery!.token).toMatch(/^sha256:[a-f0-9]{64}$/);
    description.base.scope.projectKey = 'caller-mutation';
    expect(store.describe()!.base.scope.projectKey).toBe('project1');
  });

  it('returns the original error and admission for a repeated exact failure', async () => {
    const store = new AbsNativeCandidateFailures(), input = fixture();
    const first = (await store.remember(input))!;
    const second = (await store.remember({ ...input, error: new AbsSyncError('ABS_NATIVE_TIMEOUT', 'later timeout') }))!;
    expect(store.matching(input.key)).toBe(input.error);
    expect(second.message).toBe('Original native timeout'); expect(second.recovery).toEqual(first.recovery);
    input.request.candidate.bytes = 999;
    const captured = store.capture(first.recovery!.token, first.recovery!.requestId);
    expect(captured.request.candidate.bytes).toBe(24);
    (captured.request as any).candidate.bytes = 444;
    expect(store.capture(first.recovery!.token, first.recovery!.requestId).request.candidate.bytes).toBe(24);
  });

  it('does not record syntax, wire validation or unclassified ordinary errors', async () => {
    const store = new AbsNativeCandidateFailures();
    for (const error of [new AbsSyncError('ABS_SYNTAX_INVALID', 'syntax'), new AbsSyncError('ABS_REQUEST_INVALID', 'wire'), Error('ordinary'), 'text']) {
      expect(await store.remember({ ...fixture(), error })).toBeUndefined();
      expect(store.describe()).toBeUndefined();
    }
  });

  for (const code of ['ABS_NATIVE_EFFECT_UNSUPPORTED', 'ABS_LIMIT', 'ABS_NATIVE_UI_CONTRACT_CHANGED', 'ABS_NATIVE_ASSET_UNAVAILABLE', 'ABS_RUNTIME_CONTRACT_STALE']) {
    it(`retains ${code} without offering an unsafe runtime retry`, async () => {
      const store = new AbsNativeCandidateFailures();
      const description = (await store.remember({ ...fixture(), error: new AbsSyncError(code, 'original failure') }))!;
      expect(description.code).toBe(code); expect(description.recovery).toBeUndefined();
    });
  }

  it('can remember a failed recovery without minting another timeout offer', async () => {
    const store = new AbsNativeCandidateFailures();
    const description = (await store.remember({ ...fixture(), allowRecovery: false }))!;
    expect(description.code).toBe('ABS_NATIVE_TIMEOUT'); expect(description.recovery).toBeUndefined();
    expect((await store.remember(fixture()))!.recovery).toBeUndefined();
  });

  it('makes observation read-only even when an offer has not started', async () => {
    const store = new AbsNativeCandidateFailures();
    const offer = (await store.remember(fixture()))!.recovery!;
    const operation = jasmine.createSpy().and.resolveTo('must-not-run');
    expect(await store.run(offer.token, offer.requestId, true, operation)).toEqual({ status: 'unavailable' });
    expect(operation).not.toHaveBeenCalled(); expect(store.describe()!.recovery!.status).toBe('available');
  });

  it('rejects a mismatched token or request ID without consuming the valid admission', async () => {
    const store = new AbsNativeCandidateFailures();
    const offer = (await store.remember(fixture()))!.recovery!;
    const operation = jasmine.createSpy().and.resolveTo('ok');
    for (const [token, requestId] of [['different-token', offer.requestId], [offer.token, 'different-id']]) {
      await expectAsync(store.run(token, requestId, false, operation)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_RECOVERY_STALE' }));
      expect(() => store.capture(token, requestId)).toThrowError(/exact native candidate/);
    }
    expect(operation).not.toHaveBeenCalled(); expect(store.describe()!.recovery!.status).toBe('available');
  });

  it('runs once and returns independent copies of the terminal result after a lost acknowledgement', async () => {
    const store = new AbsNativeCandidateFailures();
    const offer = (await store.remember(fixture()))!.recovery!;
    const operation = jasmine.createSpy().and.resolveTo({ prepared: { id: 'original' } });
    const first = await store.run<{ prepared: { id: string } }>(offer.token, offer.requestId, false, operation);
    first.value.prepared.id = 'caller-change';
    const second = await store.run<{ prepared: { id: string } }>(offer.token, offer.requestId, true, operation);
    expect(second.value.prepared.id).toBe('original'); expect(second.status).toBe('completed');
    expect((await store.run(offer.token, offer.requestId, false, operation)).status).toBe('completed');
    expect(operation).toHaveBeenCalledTimes(1); expect(store.describe()!.recovery).toBeUndefined();
  });

  it('observes the same running execution without starting a concurrent duplicate', async () => {
    const store = new AbsNativeCandidateFailures();
    const offer = (await store.remember(fixture()))!.recovery!;
    let finish!: (value: string) => void;
    const operation = jasmine.createSpy().and.callFake(() => new Promise<string>(resolve => { finish = resolve; }));
    const first = store.run(offer.token, offer.requestId, false, operation);
    expect(await store.run(offer.token, offer.requestId, true, operation)).toEqual({ status: 'running' });
    expect(await store.run(offer.token, offer.requestId, false, operation)).toEqual({ status: 'running' });
    expect(store.describe()!.recovery!.status).toBe('running');
    finish('done'); expect((await first).status).toBe('completed'); expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retains a terminal failed receipt without offering or performing another attempt', async () => {
    const store = new AbsNativeCandidateFailures();
    const offer = (await store.remember(fixture()))!.recovery!;
    const operation = jasmine.createSpy().and.rejectWith(new AbsSyncError('ABS_NATIVE_TIMEOUT', 'rebuild still timed out'));
    const first = await store.run(offer.token, offer.requestId, false, operation);
    expect(first.status).toBe('failed'); expect(first.failure!.code).toBe('ABS_NATIVE_TIMEOUT');
    expect(store.describe()!.recovery).toBeUndefined();
    expect(await store.run(offer.token, offer.requestId, false, operation)).toEqual(first);
    expect(await store.run(offer.token, offer.requestId, true, operation)).toEqual(first);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('checks the captured host revision before executing a recovery', async () => {
    const store = new AbsNativeCandidateFailures(), input = fixture();
    input.assertCurrent = () => { throw new AbsSyncError('ABS_BASELINE_STALE', 'canvas changed'); };
    const offer = (await store.remember(input))!.recovery!;
    const operation = jasmine.createSpy();
    const result = await store.run(offer.token, offer.requestId, false, operation);
    expect(result.status).toBe('failed'); expect(result.failure!.code).toBe('ABS_BASELINE_STALE');
    expect(operation).not.toHaveBeenCalled(); expect(store.describe()!.recovery).toBeUndefined();
  });

  it('invalidates an unconsumed offer when any precise host identity changes', async () => {
    const store = new AbsNativeCandidateFailures();
    const offer = (await store.remember(fixture('old-runtime-canvas-disk')))!.recovery!;
    expect(store.matching('new-runtime-canvas-disk')).toBeUndefined();
    const operation = jasmine.createSpy();
    await expectAsync(store.run(offer.token, offer.requestId, false, operation)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_RECOVERY_STALE' }));
    expect(operation).not.toHaveBeenCalled();
  });

  it('preserves the consumed receipt across runtime-key changes and a new failed candidate', async () => {
    const store = new AbsNativeCandidateFailures();
    const offer = (await store.remember(fixture('before-rebuild')))!.recovery!;
    let finish!: () => void;
    const operation = jasmine.createSpy().and.callFake(async () => {
      expect(store.matching('after-rebuild')).toBeUndefined();
      await store.remember({ ...fixture('after-rebuild'), allowRecovery: false });
      await new Promise<void>(resolve => { finish = resolve; });
      return { prepared: true };
    });
    const original = store.run(offer.token, offer.requestId, false, operation);
    await Promise.resolve(); await Promise.resolve();
    expect(await store.run(offer.token, offer.requestId, true, operation)).toEqual({ status: 'running' });
    finish(); expect((await original).status).toBe('completed');
    expect((await store.run(offer.token, offer.requestId, true, operation)).value).toEqual({ prepared: true });
    expect((await store.run(offer.token, offer.requestId, false, operation)).status).toBe('completed');
    expect(operation).toHaveBeenCalledTimes(1); expect(store.describe('after-rebuild')!.recovery).toBeUndefined();
  });

  it('does not let delayed token hashing erase a newer precise candidate', async () => {
    const store = new AbsNativeCandidateFailures();
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void, first = true;
    spyOn(crypto.subtle, 'digest').and.callFake((algorithm, data) => {
      if (!first) return original(algorithm, data);
      first = false;
      return new Promise<ArrayBuffer>(resolve => { release = () => { void original(algorithm, data).then(resolve); }; });
    });
    const old = store.remember(fixture('old-key'));
    const newer = await store.remember(fixture('new-key'));
    release(); expect(await old).toBeUndefined();
    expect(store.describe('new-key')!.recovery).toEqual(newer!.recovery);
  });

  it('retains a failed consumed receipt even when normal preparation remembers another failure', async () => {
    const store = new AbsNativeCandidateFailures();
    const offer = (await store.remember(fixture('before-runtime-rebuild')))!.recovery!;
    const operation = jasmine.createSpy().and.callFake(async () => {
      store.matching('rebuilt-runtime');
      await store.remember({ ...fixture('rebuilt-runtime'), allowRecovery: false });
      throw new AbsSyncError('ABS_NATIVE_EFFECT_UNSUPPORTED', 'new native failure');
    });
    expect((await store.run(offer.token, offer.requestId, false, operation)).status).toBe('failed');
    const observed = await store.run(offer.token, offer.requestId, true, operation);
    expect(observed.failure!.code).toBe('ABS_NATIVE_EFFECT_UNSUPPORTED');
    expect(store.describe('rebuilt-runtime')!.recovery).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not start another runtime rebuild while a different consumed recovery is running', async () => {
    const store = new AbsNativeCandidateFailures();
    const old = (await store.remember(fixture('old')))!.recovery!;
    let finish!: (value: string) => void;
    const first = store.run(old.token, old.requestId, false, () => new Promise<string>(resolve => { finish = resolve; }));
    const newer = (await store.remember(fixture('new')))!.recovery!;
    const operation = jasmine.createSpy().and.resolveTo('new result');
    expect(await store.run(newer.token, newer.requestId, false, operation)).toEqual({ status: 'unavailable' });
    expect(operation).not.toHaveBeenCalled();
    expect(await store.run(old.token, old.requestId, true, operation)).toEqual({ status: 'running' });
    finish('first done'); await first;
    expect((await store.run(newer.token, newer.requestId, false, operation)).status).toBe('completed');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
