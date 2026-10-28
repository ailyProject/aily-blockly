import { withProjectCopySourceLock } from './project-copy-source-lock';

describe('closed recovery copy source exclusion', () => {
  let held: boolean, host: any, publish: jasmine.Spy, guard: jasmine.Spy;
  beforeEach(() => {
    held = false; guard = jasmine.createSpy('guard');
    publish = jasmine.createSpy('publish').and.callFake(async assertOwned => { expect(held).toBeTrue(); assertOwned(); });
    host = { projectCopySourceVersion: 1,
      withProjectCopySource: jasmine.createSpy('source').and.callFake(async (_project, context, action) =>
        new Promise(resolve => {
          context(); held = true;
          expect(action(() => { expect(held).toBeTrue(); }, result => {
            held = false;
            resolve(result.ok ? { ok: true, source: { mode: 'exclusive' } } : { ok: false, error: result.error });
          })).toBeUndefined();
        })) };
  });
  it('holds native source exclusion through publication and releases before navigation', async () => {
    await withProjectCopySourceLock('/source', guard, publish, host);
    expect(publish).toHaveBeenCalledTimes(1); expect(held).toBeFalse();
  });
  for (const code of ['PROJECT_FILE_BUSY', 'PROJECT_RECOVERY_SOURCE_BUSY', 'PROJECT_RECOVERY_SOURCE_UNVERIFIED']) {
    it(`does not bypass the native ${code} source-admission result`, async () => {
      host.withProjectCopySource.and.resolveTo({ ok: false, error: { code, message: 'owner retained' } });
      await expectAsync(withProjectCopySourceLock('/source', guard, publish, host))
        .toBeRejectedWith(jasmine.objectContaining({ code }));
      expect(publish).not.toHaveBeenCalled();
    });
  }
  it('retains local partial/unknown facts across the narrow Realm error settlement', async () => {
    const failure = Object.assign(new Error('target outcome unknown'), { projectSaved: true, uncertain: true,
      publication: { abiSaved: true }, code: 'ABS_COMMIT_UNCERTAIN' });
    publish.and.rejectWith(failure);
    await expectAsync(withProjectCopySourceLock('/source', guard, publish, host)).toBeRejectedWith(failure);
    expect(held).toBeFalse();
  });
  it('merges native tail uncertainty without losing a frozen local publication receipt', async () => {
    const failure = Object.freeze(Object.assign(new Error('target saved, derived failed'), { projectSaved: true }));
    publish.and.rejectWith(failure);
    host.withProjectCopySource.and.callFake(async (_project, _context, action) => new Promise(resolve => {
      action(() => {}, () => resolve({ ok: false, error: { code: 'ABS_COMMIT_UNCERTAIN',
        message: 'source scope changed', uncertain: true } }));
    }));
    await expectAsync(withProjectCopySourceLock('/source', guard, publish, host))
      .toBeRejectedWith(jasmine.objectContaining({ projectSaved: true, uncertain: true }));
  });
  it('rejects a host that never runs the scoped publication callback', async () => {
    host.withProjectCopySource.and.resolveTo({ ok: true, source: { mode: 'exclusive' } });
    await expectAsync(withProjectCopySourceLock('/source', guard, publish, host))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_RECOVERY_COPY_UNCONFIRMED' }));
    expect(publish).not.toHaveBeenCalled();
  });
  it('requires the native copy coordination API instead of silently using an unguarded copy', async () => {
    delete host.withProjectCopySource;
    await expectAsync(withProjectCopySourceLock('/source', guard, publish, host))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_RECOVERY_LOCK_UNAVAILABLE' }));
    expect(publish).not.toHaveBeenCalled();
  });
});
