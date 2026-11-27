import { BehaviorSubject, of, Subject } from 'rxjs';
import { sha256Hex } from '../../../utils/crypto.utils';
import { CloudProjectOpenService } from './cloud-project-open.service';

describe('Cloud project continue editing', () => {
  const uuid = 'b27dffb8-6d46-4c39-864c-d16f8b9d483a';
  const archive = { path: '/temp/extracted', archiveSha256: 'a'.repeat(64) };
  let service: CloudProjectOpenService, cloud: any, auth: any, projects: any, config: any;
  let previous: any, files: Map<string, string>, user: BehaviorSubject<any>, state: BehaviorSubject<any>;

  beforeEach(() => {
    previous = { fs: window['fs'], path: window['path'] };
    files = new Map();
    const directories = new Set<string>();
    window['path'] = { join: (...parts: string[]) => parts.join('/') };
    window['fs'] = {
      captureProjectAttachment: path => ({ path }),
      mkdirSync: path => directories.add(path),
      existsSync: path => directories.has(path) || files.has(path),
      lstatSync: path => ({ _isDirectory: directories.has(path), _isFile: files.has(path) }),
      readFileSync: path => { if (!files.has(path)) throw new Error('missing'); return files.get(path); },
      writeFileSync: (path, value) => files.set(path, value),
      renameSync: (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
      replaceProjectText: async ({ projectPath, fileName, expectedHash, content }, guard) => {
        const file = `${projectPath}/${fileName}`;
        if (expectedHash !== 'sha256:' + await sha256Hex(files.get(file)!)) return { status: 'CONFLICT' };
        guard();
        files.set(file, content);
        return { status: 'COMMITTED', hash: 'sha256:' + await sha256Hex(content) };
      },
    };
    user = new BehaviorSubject({ id: 'author' });
    state = new BehaviorSubject('authenticated');
    auth = { userInfo$: user, authInitializationState$: state, isLoggedIn: true,
      get userInfo() { return user.value; }, getAuthInitializationState: () => state.value,
      requestLogin: jasmine.createSpy('login') };
    config = { isCoderProduct: jasmine.createSpy('coder').and.returnValue(true) };
    cloud = { baseUrl: '/api/v1/cloud',
      getProject: jasmine.createSpy('details').and.returnValue(of({ status: 200,
        data: { id: 42, uuid, owner_id: 'author', category: 'coder', nickname: 'Demo' } })),
      openVerifiedProjectArchive: jasmine.createSpy('archive').and.returnValue(of(archive)),
      cleanupExtractedFiles: jasmine.createSpy('cleanup'),
    };
    projects = { projectRootPath: '/projects', ensureProjectRootPath: jasmine.createSpy('root').and.resolveTo(),
      importProjectDirectory: jasmine.createSpy('import').and.callFake((_source, target) => {
        const imported = target + '/nested';
        directories.add(imported);
        files.set(`${imported}/package.json`, '{"name":"demo"}');
        return imported;
      }),
      getProjectMode: () => config.isCoderProduct() ? 'coder' : 'blockly',
      projectOpen: jasmine.createSpy('open').and.resolveTo(true) };
    service = new CloudProjectOpenService(cloud, auth, config, projects);
  });

  afterEach(() => Object.assign(window, previous));

  it('opens each product at the imported root with its numeric cloud ID and verified sync baseline', async () => {
    for (const category of ['coder', 'blockly']) {
      config.isCoderProduct.and.returnValue(category === 'coder');
      cloud.getProject.and.returnValue(of({ status: 200, data: { id: 42, uuid, owner_id: 'author', category } }));
      const first = service.open(uuid, true);
      expect(service.open(uuid, true)).toBe(first);
      await first;
      const target = projects.projectOpen.calls.mostRecent().args[0];
      const [source, destination, unwrap] = projects.importProjectDirectory.calls.mostRecent().args;
      expect([source, unwrap]).toEqual([archive.path, true]);
      expect(destination).toMatch(/^\/projects\/Cloud_[a-f0-9-]+$/);
      expect(target).toBe(destination + '/nested');
      expect(JSON.parse(files.get(`${target}/package.json`)!).cloudId).toBe(42);
      expect(JSON.parse(files.get(`${target}/.aily/cloud-sync-state.json`)!)).toEqual({
        version: 1, identity: JSON.stringify({ path: target }), scope: JSON.stringify([cloud.baseUrl, 'author']),
        binding: { cloudId: '42', archiveSha256: archive.archiveSha256 },
      });
    }
    expect(projects.importProjectDirectory).toHaveBeenCalledTimes(2);
    expect(cloud.cleanupExtractedFiles.calls.allArgs()).toEqual([[archive.path], [archive.path]]);
    expect(projects.projectOpen.calls.first().args[0]).not.toBe(projects.projectOpen.calls.mostRecent().args[0]);
    expect(cloud.openVerifiedProjectArchive.calls.allArgs().every(args => args[1] === true)).toBeTrue();
  });

  it('waits for auth initialization and requests sign-in without downloading when signed out', async () => {
    state.next('checking');
    const opening = service.open(uuid, true);
    expect(cloud.getProject).not.toHaveBeenCalled();
    user.next(null); auth.isLoggedIn = false; state.next('signed_out');
    await expectAsync(opening).toBeRejectedWithError(/请先登录/);
    expect(auth.requestLogin).toHaveBeenCalledOnceWith('cloud-project-open');
    expect(cloud.openVerifiedProjectArchive).not.toHaveBeenCalled();
  });

  it('rejects the wrong owner, product or colliding legacy identifier before downloading', async () => {
    for (const data of [
      { id: 42, uuid, owner_id: 'other', category: 'coder' },
      { id: 42, uuid, owner_id: 'author', category: 'blockly' },
      { id: 42, uuid: 'another-uuid', owner_id: 'author', category: 'coder' },
    ]) {
      cloud.getProject.and.returnValue(of({ status: 200, data }));
      await expectAsync(service.open(uuid, true)).toBeRejected();
    }
    expect(cloud.openVerifiedProjectArchive).not.toHaveBeenCalled();
  });

  it('rejects a different source API origin before looking up even the same owner and UUID', async () => {
    cloud.baseUrl = 'https://region-b.example/api/v1/cloud';
    await expectAsync(service.open(uuid, true, 'https://region-a.example')).toBeRejectedWithError(/服务区域与网页不一致/);
    expect(cloud.getProject).not.toHaveBeenCalled();
    expect(cloud.openVerifiedProjectArchive).not.toHaveBeenCalled();
    await service.open(uuid, true, 'https://region-b.example');
    expect(cloud.getProject).toHaveBeenCalledOnceWith(uuid, true);
  });

  it('cancels late downloaded contents after an account change and preserves existing local projects', async () => {
    const download = new Subject<any>();
    cloud.openVerifiedProjectArchive.and.returnValue(download);
    const opening = service.open(uuid, true);
    await Promise.resolve();
    user.next({ id: 'other' }); user.next({ id: 'author' });
    download.next(archive);
    await expectAsync(opening).toBeRejectedWithError(/已切换/);
    expect(cloud.cleanupExtractedFiles).toHaveBeenCalledOnceWith(archive.path);
    expect(projects.importProjectDirectory).not.toHaveBeenCalled();
    expect(projects.projectOpen).not.toHaveBeenCalled();
  });

  it('discards the downloaded archive if its list entry is no longer current', async () => {
    let current = true;
    const download = new Subject<typeof archive>();
    cloud.openVerifiedProjectArchive.and.returnValue(download);
    const opening = service.open('42', false, undefined, () => current);
    await Promise.resolve();
    current = false;
    download.next(archive);
    await expectAsync(opening).toBeRejectedWithError(/目标已切换/);
    expect(cloud.cleanupExtractedFiles).toHaveBeenCalledOnceWith(archive.path);
    expect(projects.importProjectDirectory).not.toHaveBeenCalled();
    expect(projects.projectOpen).not.toHaveBeenCalled();
  });

  it('reuses a finished import when opening it failed and drops the retry path after success', async () => {
    projects.projectOpen.and.resolveTo(false);
    await expectAsync(service.open(uuid, true)).toBeRejectedWithError(/\/projects\/Cloud_[a-f0-9-]+\/nested/);
    const imported = projects.projectOpen.calls.first().args[0];
    expect(cloud.cleanupExtractedFiles).toHaveBeenCalledOnceWith(archive.path);

    projects.projectOpen.and.resolveTo(true);
    await service.open(uuid, true);
    expect(projects.projectOpen.calls.allArgs()).toEqual([[imported], [imported]]);
    expect(cloud.openVerifiedProjectArchive).toHaveBeenCalledTimes(1);
    expect(projects.importProjectDirectory).toHaveBeenCalledTimes(1);
    await service.open(uuid, true);
    expect(projects.projectOpen.calls.mostRecent().args[0]).not.toBe(imported);
  });

  it('retains the existing education download path for an authorized teacher', async () => {
    cloud.getProject.and.returnValue(of({ status: 200,
      data: { id: 42, uuid, owner_id: 'student', category: 'coder', student: { active: true } } }));
    await service.open('42');
    expect(cloud.openVerifiedProjectArchive.calls.mostRecent().args[1]).toBeFalse();
    expect(projects.projectOpen).toHaveBeenCalledTimes(1);
  });
});
