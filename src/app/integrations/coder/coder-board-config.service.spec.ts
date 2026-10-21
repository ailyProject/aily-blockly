import { CoderBoardConfigService } from './coder-board-config.service';

describe('Coder board menu transaction', () => {
  let service: CoderBoardConfigService, project: any, projects: any, persistence: any, runtime: any;
  let manifest: any, files: Map<string, string>, originalFs: any, originalPath: any;
  const selection = { key: 'CDCOnBoot', data: 'default', extra: { refreshRuntimeBoardConfig: true } };
  const boardPath = '/a/node_modules/board/board.json';
  const sourcePath = '/a/sketch/main.cpp';
  beforeEach(() => {
    originalFs = window['fs']; originalPath = window['path'];
    manifest = { type: 'coder', projectConfig: { CDCOnBoot: 'cdc' } };
    files = new Map([[sourcePath, 'Serial0.begin(9600);'], [boardPath, '{}']]);
    window['path'] = { join: (...parts: string[]) => parts.join('/') };
    window['fs'] = {
      readFileSync: (path: string) => files.get(path), writeFileSync: (path: string, content: string) => files.set(path, content),
      existsSync: (path: string) => path === '/a/sketch', lstatSync: () => ({ _isSymbolicLink: false }),
      readDirSync: () => [{ name: 'main.cpp', _isFile: true }],
    };
    const board = () => ({ _cdcEnabled: manifest.projectConfig.CDCOnBoot === 'cdc', cdcSerialPort: [['USB', 'Serial']] });
    project = {
      currentBoardPinConfig: {},
      getBoardConfigMenu: async () => [{ children: [selection] }], getPackageJson: async () => structuredClone(manifest),
      setPackageJson: jasmine.createSpy('persist config').and.callFake(async (data: any) => { manifest = data; }),
      resolveBoardConfigForRuntime: async () => board(), refreshRuntimeBoardConfig: async () => board(),
      syncCurrentBoardConfig: jasmine.createSpy('sync').and.resolveTo(true), getBoardPackagePath: async () => '/a/node_modules/board',
    };
    projects = { currentProjectPath: '/a', getCoderOperation: () => null, getCoderProjectContext: () => project,
      withCoderBoardConfigMutation: async (_path: string, apply: () => Promise<any>) => apply() };
    persistence = { saveAll: jasmine.createSpy('save editor').and.resolveTo({ ok: true }), hasSavedProject: jasmine.createSpy('clean editor').and.resolveTo(true) };
    runtime = { build: jasmine.createSpy('preprocess').and.resolveTo({ state: 'done' }) };
    service = new CoderBoardConfigService(projects, persistence, runtime);
  });
  afterEach(() => { window['fs'] = originalFs; window['path'] = originalPath; });

  it('saves the editor, migrates persistent source and runs Coder preprocessing', async () => {
    await service.select('/a', selection);
    expect(persistence.saveAll).toHaveBeenCalledOnceWith('/a');
    expect(manifest.projectConfig.CDCOnBoot).toBe('default');
    expect(files.get(sourcePath)).toBe('Serial.begin(9600);');
    expect(runtime.build).toHaveBeenCalledOnceWith('/a', { preprocessOnly: true });
    expect(await service.select('/a', selection)).toBeFalse();
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });
  it('migrates source after an STM32 variant changes its available pins', async () => {
    const pinOption = { key: 'pnum', data: 'new', extra: { syncPinConfig: true } };
    manifest = { type: 'coder', projectConfig: { pnum: 'old' } };
    files.set(sourcePath, 'pinMode(PC13, OUTPUT); digitalWrite(PC13, 1);');
    project.getBoardConfigMenu = async () => [{ children: [pinOption] }];
    project.resolveBoardConfigForRuntime = async () => ({ digitalPins: [['LED', 'PC13']] });
    project.syncBoardPinConfig = jasmine.createSpy('pins').and.resolveTo(true);
    project.refreshRuntimeBoardConfig = async () => ({ digitalPins: [['LED', 'PA0']] });
    await service.select('/a', pinOption);
    expect(project.syncBoardPinConfig).toHaveBeenCalledOnceWith(pinOption);
    expect(files.get(sourcePath)).toBe('pinMode(PA0, OUTPUT); digitalWrite(PA0, 1);');
    expect(manifest.projectConfig.pnum).toBe('new');
  });
  it('leaves explicit device actions to the header before starting preprocessing', async () => {
    const action = { key: 'softdevice', data: 's110', extra: { selectAction: 'flash-softdevice' } };
    project.getBoardConfigMenu = async () => [{ children: [action] }];
    await service.select('/a', action);
    expect(manifest.projectConfig.softdevice).toBe('s110');
    expect(runtime.build).not.toHaveBeenCalled();
  });
  it('does not persist configuration when saving fails', async () => {
    persistence.saveAll.and.rejectWith(new Error('save failed'));
    await expectAsync(service.select('/a', selection)).toBeRejectedWithError('save failed');
    expect(project.setPackageJson).not.toHaveBeenCalled();
    expect(runtime.build).not.toHaveBeenCalled();
  });
  it('rolls back config when new editor input arrives before source writing', async () => {
    persistence.hasSavedProject.and.resolveTo(false);
    await expectAsync(service.select('/a', selection)).toBeRejectedWithError(/未保存/);
    expect(manifest.projectConfig.CDCOnBoot).toBe('cdc');
    expect(files.get(sourcePath)).toBe('Serial0.begin(9600);');
    expect(runtime.build).not.toHaveBeenCalled();
  });
  it('does not write either project if the active tab changes during save', async () => {
    persistence.saveAll.and.callFake(async () => { projects.currentProjectPath = '/b'; });
    await expectAsync(service.select('/a', selection)).toBeRejectedWithError(/状态已改变/);
    expect(project.setPackageJson).not.toHaveBeenCalled();
  });
  it('rejects stale or disabled options and respects active build operations', async () => {
    await expectAsync(service.select('/a', { key: 'missing', data: 'x' })).toBeRejectedWithError(/选项已改变/);
    expect(await service.select('/a', { ...selection, disabled: true })).toBeFalse();
    projects.getCoderOperation = () => ({ kind: 'build' });
    await expectAsync(service.select('/a', selection)).toBeRejectedWithError(/正在/);
    expect(project.setPackageJson).not.toHaveBeenCalled();
  });
  it('keeps committed config/source and reports a preprocess failure', async () => {
    runtime.build.and.rejectWith(new Error('SDK unavailable'));
    await expectAsync(service.select('/a', selection)).toBeRejectedWithError('SDK unavailable');
    expect(manifest.projectConfig.CDCOnBoot).toBe('default');
    expect(files.get(sourcePath)).toBe('Serial.begin(9600);');
  });
});
