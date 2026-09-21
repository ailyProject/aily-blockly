import { ProjectService } from './project.service';

describe('board configuration menu SDK readiness', () => {
  const sdkPath = '/app/sdk/esp32_3.3.10';
  const boardsPath = `${sdkPath}/boards.txt`;
  let oldPath: any, oldFs: any, oldEnv: any;
  let existingPaths: Set<string>;
  let errorLog: jasmine.Spy, warningLog: jasmine.Spy;

  beforeEach(() => {
    oldPath = window['path']; oldFs = window['fs']; oldEnv = window['env'];
    existingPaths = new Set([sdkPath, boardsPath]);
    window['path'] = { getAppDataPath: () => '/app' };
    window['env'] = { get: async () => '/app/sdk' };
    window['fs'] = {
      existsSync: (path: string) => existingPaths.has(path),
      readFileSync: jasmine.createSpy('read boards.txt').and.returnValue([
        'esp32s3.name=ESP32S3 Dev Module',
        'esp32s3.menu.CDCOnBoot.default=Disabled',
        'esp32s3.menu.CDCOnBoot.default.build.cdc_on_boot=0',
        'esp32s3.menu.CDCOnBoot.cdc=Enabled',
        'esp32s3.menu.CDCOnBoot.cdc.build.cdc_on_boot=1',
      ].join('\n')),
    };
    errorLog = spyOn(console, 'error');
    warningLog = spyOn(console, 'warn');
  });

  afterEach(() => {
    window['path'] = oldPath; window['fs'] = oldFs; window['env'] = oldEnv;
  });

  function fixture() {
    const service: any = Object.create(ProjectService.prototype);
    const manifest: any = { projectConfig: { CDCOnBoot: 'cdc' } };
    service.currentBoardConfig = { type: 'esp32:esp32:esp32s3' };
    service.currentBoardMenuConfig = [
      { name: 'USB CDC On Boot', key: 'CDCOnBoot', children: [], extra: { selectFirstByDefault: true } },
      {
        name: 'Board variant', key: 'Variant', extra: { selectFirstByDefault: true, syncPinConfig: true },
        children: [{ name: 'Default variant', data: 'default', extra: { build: { variant: 'esp32s3' } } }],
      },
    ];
    service.currentBoardPinConfig = { board: 'saved-board', variant: 'saved-variant', variant_h: null };
    service.electronService = { pathJoin: (...parts: string[]) => parts.join('/') };
    service.translate = { instant: () => 'SDK is not ready' };
    service.getPackageJson = jasmine.createSpy('get package').and.resolveTo(manifest);
    service.getEffectiveBoardDependencies = jasmine.createSpy('get dependencies').and.resolveTo({
      '@aily-project/sdk-esp32': '3.3.10',
    });
    service.setPackageJson = jasmine.createSpy('set package').and.resolveTo();
    service.syncBoardPinConfig = jasmine.createSpy('sync pins').and.resolveTo();
    return { service, manifest };
  }

  function expectUnavailableMenu(menu: any[], service: any, manifest: any) {
    expect(menu).toContain(jasmine.objectContaining({
      name: 'PROJECT.SDK_CONFIG_NOT_READY', tooltip: 'SDK is not ready', disabled: true,
    }));
    expect(menu.find(item => item.name === 'PROJECT.SDK_CONFIG_NOT_READY').key).toBeFalsy();
    expect(menu.find(item => item.key === 'CDCOnBoot')).toEqual(jasmine.objectContaining({
      disabled: true, tooltip: 'SDK is not ready', children: [],
    }));
    const staticMenu = menu.find(item => item.key === 'Variant');
    expect(staticMenu.disabled).toBeFalsy();
    expect(staticMenu.children[0].data).toBe('default');
    expect(manifest).toEqual({ projectConfig: { CDCOnBoot: 'cdc' } });
    expect(service.currentBoardPinConfig).toEqual({ board: 'saved-board', variant: 'saved-variant', variant_h: null });
    expect(service.setPackageJson).not.toHaveBeenCalled();
    expect(service.syncBoardPinConfig).not.toHaveBeenCalled();
  }

  it('keeps available static options and saved CDC selection until the SDK is ready on a later open', async () => {
    const { service, manifest } = fixture();
    existingPaths.clear();

    expectUnavailableMenu(await service.getBoardConfigMenu(), service, manifest);
    expectUnavailableMenu(await service.getBoardConfigMenu(), service, manifest);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warningLog).toHaveBeenCalled();
    expect(window['fs'].readFileSync).not.toHaveBeenCalled();

    existingPaths.add(sdkPath); existingPaths.add(boardsPath);
    const readyMenu = await service.getBoardConfigMenu();
    expect(readyMenu.some((item: any) => item.name === 'PROJECT.SDK_CONFIG_NOT_READY')).toBeFalse();
    const cdc = readyMenu.find((item: any) => item.key === 'CDCOnBoot');
    expect(cdc.disabled).toBeFalsy();
    expect(cdc.children.map((child: any) => [child.data, child.check])).toEqual([
      ['default', false], ['cdc', true],
    ]);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('does not persist menu defaults when the SDK directory exists but boards.txt is missing', async () => {
    const { service, manifest } = fixture();
    existingPaths.delete(boardsPath);

    expectUnavailableMenu(await service.getBoardConfigMenu(), service, manifest);
    expect(errorLog).not.toHaveBeenCalled();
    expect(window['fs'].readFileSync).not.toHaveBeenCalled();
  });

  it('reads ready SDK options and keeps normal default persistence and pin synchronization', async () => {
    const { service, manifest } = fixture();

    const menu = await service.getBoardConfigMenu();

    expect(window['fs'].readFileSync).toHaveBeenCalledOnceWith(boardsPath, 'utf8');
    expect(menu.find((item: any) => item.key === 'CDCOnBoot').children).toContain(jasmine.objectContaining({
      name: 'Enabled', data: 'cdc', check: true,
    }));
    expect(manifest.projectConfig).toEqual({ CDCOnBoot: 'cdc', Variant: 'default' });
    expect(service.setPackageJson).toHaveBeenCalledOnceWith(manifest);
    expect(service.syncBoardPinConfig).toHaveBeenCalledOnceWith(jasmine.objectContaining({
      key: 'Variant', data: 'default',
    }));
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('preserves static-board defaults without showing an SDK warning when no SDK is declared', async () => {
    const { service, manifest } = fixture();
    service.getEffectiveBoardDependencies.and.resolveTo({});
    service.currentBoardMenuConfig = service.currentBoardMenuConfig.filter((item: any) => item.key === 'Variant');

    const menu = await service.getBoardConfigMenu();

    expect(menu.length).toBe(1);
    expect(menu[0].disabled).toBeFalsy();
    expect(manifest.projectConfig).toEqual({ CDCOnBoot: 'cdc', Variant: 'default' });
    expect(service.setPackageJson).toHaveBeenCalledOnceWith(manifest);
    expect(service.syncBoardPinConfig).toHaveBeenCalledTimes(1);
    expect(window['fs'].readFileSync).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    expect(warningLog).not.toHaveBeenCalled();
  });

  it('retains the original read error for diagnosis without writing fallback configuration', async () => {
    const { service, manifest } = fixture();
    const readError = new Error('EACCES: permission denied reading boards.txt');
    window['fs'].readFileSync.and.throwError(readError);

    expectUnavailableMenu(await service.getBoardConfigMenu(), service, manifest);

    const diagnostics = [...warningLog.calls.allArgs(), ...errorLog.calls.allArgs()];
    expect(diagnostics.some(args => args.includes(readError))).toBeTrue();
  });
});
