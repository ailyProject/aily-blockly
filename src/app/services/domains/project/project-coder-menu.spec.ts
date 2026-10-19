import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectService } from './project.service';

describe('Coder board menu context ownership', () => {
  let project: any, originalPath: any, originalBoard: any;
  beforeEach(() => {
    originalPath = window['path']; originalBoard = window['boardConfig'];
    window['path'] = { join: (...parts: string[]) => parts.join('/') };
    project = Object.create(ProjectService.prototype);
    Object.assign(project, {
      configService: { data: { compile: { backend: 'local' } }, getCompileSettingsKey: () => 'local' },
      currentProjectPathSubject: new BehaviorSubject('/a'), stateSubject: new BehaviorSubject('loaded'),
      coderProjectContexts: new Map(), boardConfigUpdatedSubject: new Subject(),
      getProjectMode: () => 'coder', currentBoardMenuConfig: [{ key: 'old-blockly-menu' }], currentBoardMenuI18nDir: '/old',
      electronService: { readFile: () => '{"type":"coder"}', pathJoin: (...parts: string[]) => parts.join('/'),
        exists: (path: string) => path.endsWith('menu.json') },
      translate: { currentLang: 'zh-CN', instant: (key: string) => key },
    });
    project.electronService.readFile = (path: string) => path.endsWith('menu.json')
      ? JSON.stringify([{ key: path.startsWith('/a/') ? 'CDCOnBoot' : 'pnum', children: [{ data: 'default' }] }])
      : '{"type":"coder"}';
    Object.defineProperty(project, 'dependencyLifecycle', { value: {} });
  });
  afterEach(() => { window['path'] = originalPath; window['boardConfig'] = originalBoard; });

  function context(path: string) {
    const service = project.getCoderProjectContext(path);
    service.getBoardPackagePath = async () => `${path}/node_modules/board`;
    service.resolveBoardConfigForRuntime = async () => ({ type: path, _cdcEnabled: path === '/a' });
    service.getPackageJson = async () => ({ projectConfig: {} });
    service.getBoardDependencies = async () => ({});
    return service;
  }
  it('loads each board menu with its resolved runtime config and does not inherit the previous editor menu', async () => {
    const a = context('/a'), b = context('/b');
    expect(a.currentBoardMenuConfig).toEqual([]);
    expect(b.currentBoardMenuConfig).toEqual([]);
    expect(await a.syncCurrentBoardConfig()).toBeTrue();
    expect(project.currentBoardMenuConfig[0].key).toBe('CDCOnBoot');
    expect(project.currentBoardConfig._cdcEnabled).toBeTrue();
    expect(await b.syncCurrentBoardConfig()).toBeTrue();
    expect(project.currentBoardConfig.type).toBe('/a');
    expect(window['boardConfig'].type).toBe('/a');
    project.currentProjectPathSubject.next('/b');
    project.publishCoderProjectContext(b);
    expect(project.currentBoardMenuConfig[0].key).toBe('pnum');
    expect(project.currentBoardMenuI18nDir).toBe('/b/node_modules/board/i18n');
    expect((await b.getBoardConfigMenu())[0].key).toBe('pnum');
  });
  it('keeps menu inspection read-only even for first-option pin defaults', async () => {
    const a = context('/a');
    a.currentBoardMenuConfig = [{ key: 'pnum', extra: { selectFirstByDefault: true, syncPinConfig: true }, children: [{ data: 'first', extra: { build: { variant: 'first' } } }] }];
    a.setPackageJson = jasmine.createSpy('persist');
    a.syncBoardPinConfig = jasmine.createSpy('pins');
    const menu = await a.getBoardConfigMenu();
    expect(menu[0].children[0].check).toBeTrue();
    expect(a.setPackageJson).not.toHaveBeenCalled();
    expect(a.syncBoardPinConfig).not.toHaveBeenCalled();
  });
  it('clears stale options when a board disappears and recovers when dependencies become available', async () => {
    const a = context('/a');
    await a.syncCurrentBoardConfig();
    a.resolveBoardConfigForRuntime = async () => { throw new Error('board not installed'); };
    expect(await a.syncCurrentBoardConfig()).toBeFalse();
    expect(project.currentBoardConfig).toBeNull();
    expect(project.currentBoardMenuConfig).toEqual([]);
    a.resolveBoardConfigForRuntime = async () => ({ type: 'restored' });
    expect(await a.syncCurrentBoardConfig()).toBeTrue();
    expect(project.currentBoardMenuConfig[0].key).toBe('CDCOnBoot');
  });

  it('keeps cloud defaults read-only when inspecting a background Coder menu', async () => {
    const b = context('/b');
    b.configService.data.compile.backend = 'cloud';
    b.currentBoardConfig = { type: 'vendor:arch:board' };
    b.getCloudBoardProfile = async () => ({ fqbn: 'vendor:arch:board', metadata: {
      boardOptions: { pnum: { default: 'registered', values: {
        registered: { label: 'Registered board', properties: { 'build.variant': 'registered' } },
      } } }, defaults: { pnum: 'registered' },
    } });
    b.setPackageJson = jasmine.createSpy('persist');
    b.syncBoardPinConfig = jasmine.createSpy('pins');
    window['boardConfig'] = { type: 'active-a' };

    const menu = await b.getBoardConfigMenu();

    expect(menu[0].children[0]).toEqual(jasmine.objectContaining({ data: 'registered', check: true }));
    expect(b.setPackageJson).not.toHaveBeenCalled();
    expect(b.syncBoardPinConfig).not.toHaveBeenCalled();
    expect(window['boardConfig']).toEqual({ type: 'active-a' });
  });

  it('rejects a cloud menu response after switching compile settings', async () => {
    const a = context('/a');
    a.configService.data.compile.backend = 'cloud';
    let key = 'cloud-1';
    a.configService.getCompileSettingsKey = () => key;
    let resolve!: (value: any) => void;
    a.getCloudBoardProfile = () => new Promise(done => resolve = done);
    const pending = a.getBoardConfigMenu();
    key = 'local-2';
    resolve({ metadata: { boardOptions: {}, defaults: {} } });
    await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_DEPENDENCY_CANCELLED' }));
  });

  it('updates only background Coder runtime pins in cloud mode without changing the installed board', async () => {
    const b = context('/b');
    b.configService.data.compile.backend = 'cloud';
    const installed = { type: 'board', digital: ['old'] };
    b.currentBoardConfig = installed;
    b.runtimeBoardModules = new WeakMap([[installed, '@aily-project/board-test']]);
    b.getBoardJson = async () => installed;
    b.getVariantConfig = async () => ({ digital: ['new'] });
    b.setBoardJson = jasmine.createSpy('write installed board');
    window['boardConfig'] = { type: 'active-a' };

    expect(await b.syncBoardPinConfig({ data: 'new', extra: { build: { variant: 'v', variant_h: 'new.h' } } })).toBeFalse();

    expect(b.currentBoardConfig.digital).toEqual(['new']);
    expect(b.getRuntimeBoardModule()).toBe('@aily-project/board-test');
    expect(installed.digital).toEqual(['old']);
    expect(b.setBoardJson).not.toHaveBeenCalled();
    expect(window['boardConfig']).toEqual({ type: 'active-a' });
  });

  it('reloads local pins when only variant_h changes and rejects missing Coder pins', async () => {
    const b = context('/b');
    b.currentBoardPinConfig = { board: 'old', variant: 'shared', variant_h: 'old.h' };
    b.getVariantConfig = jasmine.createSpy('variant').and.resolveTo({ digital: ['new'] });
    b.getBoardJson = async () => ({ digital: ['old'] });
    b.setBoardJson = jasmine.createSpy('persist board').and.resolveTo();
    const next = { data: 'new', extra: { build: { variant: 'shared', variant_h: 'new.h' } } };
    expect(await b.syncBoardPinConfig(next)).toBeFalse();
    expect(b.getVariantConfig).toHaveBeenCalledOnceWith('shared', 'new.h');
    expect(b.setBoardJson).toHaveBeenCalledOnceWith({ digital: ['new'] });
    b.getVariantConfig.and.resolveTo(null);
    await expectAsync(b.syncBoardPinConfig({ data: 'missing', extra: { build: { variant: 'missing' } } })).toBeRejectedWithError(/无法读取/);
    expect(b.currentBoardPinConfig.board).toBe('new');
  });
});
