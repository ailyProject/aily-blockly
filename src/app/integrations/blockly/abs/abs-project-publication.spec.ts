import { ProjectFilePublicationError, publishProjectText } from '@core/platform/public-api';
import { hashAbsText } from './abs-identity-map';

describe('project publication host acknowledgement', () => {
  it('sends exact byte hashes and the final context guard to the host', async () => {
    const guard = jasmine.createSpy('guard');
    const port = { replaceProjectText: jasmine.createSpy('replace').and.resolveTo({ status: 'COMMITTED', hash: await hashAbsText('中文\r\n') }) };
    await publishProjectText('D:/project', 'project.abs', '中文\r\n', 'before', guard, port);
    expect(port.replaceProjectText).toHaveBeenCalledOnceWith({ projectPath: 'D:/project', fileName: 'project.abs', content: '中文\r\n', expectedHash: await hashAbsText('before') }, jasmine.any(Function));
  });
  it('does not fall back to unchecked writes when the host is missing', async () => {
    await expectAsync(publishProjectText('D:/project', 'project.abi', 'after', null, () => undefined, {} as any))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_FILE_HOST_UNAVAILABLE', uncertain: false }));
  });
  for (const result of [undefined, { status: 'COMMITTED', hash: 'wrong' }, { status: 'UNKNOWN' }, { status: 'unexpected' }]) {
    it(`treats invalid/uncertain acknowledgements as potentially committed: ${JSON.stringify(result)}`, async () => {
      await expectAsync(publishProjectText('D:/project', 'project.abi', 'after', null, () => undefined,
        { replaceProjectText: async () => result } as any)).toBeRejectedWith(jasmine.objectContaining({ uncertain: true }));
    });
  }
  it('treats a lost host response as uncertain, not proof of rollback', async () => {
    await expectAsync(publishProjectText('D:/project', 'project.abi', 'after', null, () => undefined,
      { replaceProjectText: async () => { throw new Error('transport lost'); } })).toBeRejectedWith(jasmine.any(ProjectFilePublicationError));
  });
  for (const lostResponse of [false, true]) {
    it(`does not retry a guard failure without proof of non-commit (lost response: ${lostResponse})`, async () => {
      let current = true;
      const guard = () => { if (!current) throw new Error('stale'); };
      await expectAsync(publishProjectText('D:/project', 'package.json', 'after', 'before', guard, {
        replaceProjectText: async (_request, hostGuard) => {
          current = false;
          try { hostGuard(); } catch {}
          if (lostResponse) throw new Error('transport lost');
          return { status: 'UNKNOWN' };
        },
      })).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_FILE_COMMIT_UNCERTAIN', uncertain: true }));
    });
  }
  it('preserves genuine host write failures when the context guard did not fail', async () => {
    await expectAsync(publishProjectText('D:/project', 'package.json', 'after', 'before', () => {}, {
      replaceProjectText: async () => ({ status: 'NOT_COMMITTED', code: 'ENOSPC', error: 'disk full' }),
    })).toBeRejectedWith(jasmine.objectContaining({ code: 'ENOSPC', message: 'disk full', uncertain: false }));
  });
  it('stops a context change during hashing before dispatching to the host', async () => {
    let current = true;
    const port = { replaceProjectText: jasmine.createSpy('replace') };
    const pending = publishProjectText('D:/project', 'project.abs', 'after', null, () => { if (!current) throw new Error('stale'); }, port);
    current = false;
    await expectAsync(pending).toBeRejectedWithError('stale');
    expect(port.replaceProjectText).not.toHaveBeenCalled();
  });
  it('requires negotiated backup capability before an older host can modify ABI', async () => {
    const port = { replaceProjectText: jasmine.createSpy('old host') };
    await expectAsync(publishProjectText('D:/project', 'project.abi', 'after', 'before', () => {}, port, { backup: 'project-data' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_FILE_HOST_UNAVAILABLE', uncertain: false }));
    expect(port.replaceProjectText).not.toHaveBeenCalled();
  });
  it('requires the original backup acknowledgement as well as the output hash', async () => {
    const port = { projectFilePublicationVersion: 2,
      replaceProjectText: jasmine.createSpy('host').and.resolveTo({ status: 'COMMITTED', hash: await hashAbsText('after') }) };
    await expectAsync(publishProjectText('D:/project', 'project.abi', 'after', 'before', () => {}, port, { backup: 'project-data' }))
      .toBeRejectedWith(jasmine.objectContaining({ uncertain: true }));
    port.replaceProjectText.and.resolveTo({ status: 'COMMITTED', hash: await hashAbsText('after'), backupHash: await hashAbsText('before') });
    await expectAsync(publishProjectText('D:/project', 'project.abi', 'after', 'before', () => {}, port, { backup: 'project-data' })).toBeResolved();
  });
});
