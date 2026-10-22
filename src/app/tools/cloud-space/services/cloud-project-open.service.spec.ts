import { BehaviorSubject, of, Subject } from 'rxjs';
import { CloudProjectOpenService } from './cloud-project-open.service';
import { readCloudSyncBaseline } from './cloud-sync-baseline';

describe('Cloud project continue editing', () => {
  const uuid = 'b27dffb8-6d46-4c39-864c-d16f8b9d483a';
  let service: CloudProjectOpenService, cloud: any, auth: any, projects: any, config: any;
  let previous: any, files: Map<string, string>, user: BehaviorSubject<any>, state: BehaviorSubject<any>;

  beforeEach(() => {
    previous = { fs: window['fs'], path: window['path'] };
    files = new Map();
    window['path'] = { join: (...parts: string[]) => parts.join('/') };
    window['fs'] = {
      importProjectDirectory: jasmine.createSpy('import').and.callFake((_source, target) => {
        files.set(`${target}/package.json`, '{"name":"demo","type":"coder"}');
      }),
      readFileSync: path => { if (!files.has(path)) throw new Error('missing'); return files.get(path); },
      writeFileSync: (path, value) => files.set(path, value), mkdirSync: () => {},
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
      openVerifiedProjectArchive: jasmine.createSpy('archive').and.returnValue(of({ path: '/temp/extracted', sha256: 'a'.repeat(64) })),
    };
    projects = { projectRootPath: '/projects', ensureProjectRootPath: jasmine.createSpy('root').and.resolveTo(),
      getProjectMode: () => config.isCoderProduct() ? 'coder' : 'blockly',
      projectOpen: jasmine.createSpy('open').and.resolveTo() };
    service = new CloudProjectOpenService(cloud, auth, config, projects);
  });

  afterEach(() => Object.assign(window, previous));

  it('opens each product in a unique directory, retaining the numeric cloud ID and actual baseline', async () => {
    for (const category of ['coder', 'blockly']) {
      config.isCoderProduct.and.returnValue(category === 'coder');
      cloud.getProject.and.returnValue(of({ status: 200, data: { id: 42, uuid, owner_id: 'author', category } }));
      const first = service.open(uuid, true);
      expect(service.open(uuid, true)).toBe(first);
      await first;
      const target = projects.projectOpen.calls.mostRecent().args[0];
      expect(target).toMatch(/^\/projects\/Cloud_[a-f0-9-]+$/);
      expect(JSON.parse(files.get(`${target}/package.json`)!).cloudId).toBe(42);
      expect(readCloudSyncBaseline(target, '42', 'author', '/api/v1/cloud')).toBe('a'.repeat(64));
      expect(readCloudSyncBaseline(target, '42', 'other', '/api/v1/cloud')).toBeNull();
      expect(readCloudSyncBaseline(target, '99', 'author', '/api/v1/cloud')).toBeNull();
    }
    expect(window['fs'].importProjectDirectory).toHaveBeenCalledTimes(2);
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
    download.next({ path: '/temp/extracted', sha256: 'a'.repeat(64) });
    await expectAsync(opening).toBeRejectedWithError(/已切换/);
    expect(window['fs'].importProjectDirectory).not.toHaveBeenCalled();
    expect(projects.projectOpen).not.toHaveBeenCalled();
  });

  it('retains the existing education download path for an authorized teacher', async () => {
    cloud.getProject.and.returnValue(of({ status: 200,
      data: { id: 42, uuid, owner_id: 'student', category: 'coder', student: { active: true } } }));
    await service.open('42');
    expect(cloud.openVerifiedProjectArchive.calls.mostRecent().args[1]).toBeFalse();
    expect(projects.projectOpen).toHaveBeenCalledTimes(1);
  });
});
