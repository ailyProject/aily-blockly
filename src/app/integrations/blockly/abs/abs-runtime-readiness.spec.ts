import { ProjectService } from '@domain/project/public-api';

describe('runtime readiness is not inferred from restored file signatures', () => {
  function fixture() {
    let ready = true;
    const runtime = jasmine.createSpy('rebuildRuntime').and.resolveTo(true);
    const service: any = Object.assign(Object.create(ProjectService.prototype), {
      blocklyLibraryRuntimeSignatures: new Map([['/source', 'original-input']]), blocklyLibraryRuntimeRebuildTask: null,
      getPackageJson: async () => ({}), getEffectivePackageText: () => '{}',
      getBlocklyLibraryRuntimeSignature: () => 'original-input',
      captureCurrentProjectGuard: () => () => true,
    });
    Object.defineProperty(service, 'application', { value: { isBlocklyLibraryRuntimeReady: () => ready, rebuildActiveBlocklyLibraryRuntime: runtime } });
    Object.defineProperty(service, 'currentProjectPath', { value: '/source', writable: true });
    return { service, runtime, setReady: (value: boolean) => { ready = value; } };
  }

  it('rejects an old matching fingerprint after a failed editor epoch', async () => {
    const f = fixture(); f.setReady(false);
    expect(await f.service.getBlocklyLibraryRuntimeFingerprint()).toBeNull();
    expect(f.runtime).not.toHaveBeenCalled();
  });

  it('does not skip synchronization when bytes match but the actual runtime is unready', async () => {
    const f = fixture(); f.setReady(false);
    await f.service.ensureBlocklyLibraryRuntimeReady(); expect(f.runtime).toHaveBeenCalledTimes(1);
    expect(await f.service.getBlocklyLibraryRuntimeFingerprint()).toBeNull();
  });

  it('invalidates the earlier signature when rebuilding fails', async () => {
    const f = fixture(); f.setReady(false); f.runtime.and.rejectWith(new Error('load failed'));
    await expectAsync(f.service.rebuildBlocklyRuntimeAfterLibraryChange()).toBeRejectedWithError('load failed');
    expect(f.service.blocklyLibraryRuntimeSignatures.has('/source')).toBeFalse();
    f.setReady(true); expect(await f.service.getBlocklyLibraryRuntimeFingerprint()).toBeNull();
    expect(f.service.blocklyLibraryRuntimeRebuildTask).toBeNull();
  });

  it('retains the normal fast path for matching bytes and an actually ready runtime', async () => {
    const f = fixture(); await f.service.ensureBlocklyLibraryRuntimeReady();
    expect(f.runtime).not.toHaveBeenCalled();
    expect(await f.service.getBlocklyLibraryRuntimeFingerprint()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('a concurrent rebuilding task is not a valid fingerprint', async () => {
    const f = fixture(); f.service.blocklyLibraryRuntimeRebuildTask = { path: '/source' };
    expect(await f.service.getBlocklyLibraryRuntimeFingerprint()).toBeNull();
  });

  it('rechecks actual readiness after asynchronous package discovery', async () => {
    const f = fixture(); f.service.getPackageJson = async () => f.setReady(false);
    expect(await f.service.getBlocklyLibraryRuntimeFingerprint()).toBeNull();
  });

  it('acknowledges only its captured input once, not a later file signature', async () => {
    const f = fixture(); f.service.blocklyLibraryRuntimeSignatures.clear();
    const acknowledge = await f.service.captureBlocklyRuntimeRecoveryAcknowledgement();
    expect(acknowledge()).toBeTrue(); expect(acknowledge()).toBeFalse();
    const stale = await f.service.captureBlocklyRuntimeRecoveryAcknowledgement();
    f.service.getBlocklyLibraryRuntimeSignature = () => 'new-generator-input';
    expect(stale()).toBeFalse(); expect(await f.service.getBlocklyLibraryRuntimeFingerprint()).toBeNull();
  });

  it('does not certify a replacement activation or an unready native epoch', async () => {
    const f = fixture(); const acknowledge = await f.service.captureBlocklyRuntimeRecoveryAcknowledgement();
    f.setReady(false); expect(acknowledge()).toBeFalse();
    f.setReady(true); const oldProject = await f.service.captureBlocklyRuntimeRecoveryAcknowledgement();
    f.service.currentProjectPath = '/replacement'; expect(oldProject()).toBeFalse();
  });
});
