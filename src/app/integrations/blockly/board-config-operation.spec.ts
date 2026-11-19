import { getBoardConfig, setBoardConfig } from './board-config-operation';

describe('board config build facts', () => {
  let previousPath: any;
  let previousFs: any;
  beforeEach(() => {
    previousPath = window['path']; previousFs = window['fs'];
    window['path'] = { getAppDataPath: () => '/app', join: (...parts: string[]) => parts.join('/') };
    window['fs'] = { existsSync: () => true };
  });
  afterEach(() => { window['path'] = previousPath; window['fs'] = previousFs; });

  function project() {
    return {
      currentProjectPath: '/project', currentBoardConfig: { core: 'test', compilerParam: '-b test:board' },
      getPackageJson: async () => ({ dependencies: { '@aily-project/board-test': '1' } }),
      getRuntimeBoardModule: () => '@aily-project/board-test',
      getBoardModule: async () => '@aily-project/board-test',
      getBoardDependencies: async () => ({ '@aily-project/sdk-test': '1.0.0' }),
      isAilyCodeProject: () => false,
      getBoardConfigMenu: jasmine.createSpy('menu').and.resolveTo([]),
    };
  }

  it('build-only inspection skips the board menu and uses current effective dependencies', async () => {
    const service = project();
    const result = await getBoardConfig(service as any, 'build');
    expect(result['ok']).toBeTrue();
    expect((result['buildEnvironment'] as any).artifacts[0].root).toBe('/app/sdk/test_1.0.0');
    expect(service.getBoardConfigMenu).not.toHaveBeenCalled();
  });

  for (const coder of [false, true]) it('reports the declared MCU in every section without requiring an SDK; coder=' + coder, async () => {
    const service = project(); service.isAilyCodeProject = () => coder;
    service.currentBoardConfig = { core: 'other-sdk', compilerParam: '', mcu: 'esp32s3' } as any;
    service.getBoardDependencies = async () => ({} as any);
    window['fs'].existsSync = () => false;
    for (const section of ['all', 'build', 'pins']) {
      const result = await getBoardConfig(service as any, section);
      expect(result['ok']).toBeTrue();
      expect(result['mcu']).toBe('esp32s3');
    }
  });

  it('does not invent an MCU for a legacy board package', async () => {
    expect((await getBoardConfig(project() as any))['mcu']).toBeNull();
  });

  it('the existing all response retains configuration and adds facts without persisting defaults', async () => {
    const service = project();
    const result = await getBoardConfig(service as any);
    expect(result['config_items']).toEqual([]);
    expect(result['buildEnvironment']).toBeDefined();
    expect(service.getBoardConfigMenu).toHaveBeenCalledOnceWith({ persistDefaults: false });
  });

  it('reports unavailable facts instead of guessing SDK paths or failing unrelated board configuration', async () => {
    const service = project();
    service.getBoardDependencies = async () => { throw new Error('dependencies unavailable'); };
    const result = await getBoardConfig(service as any);
    expect(result['ok']).toBeTrue();
    expect((result['buildEnvironment'] as any).status).toBe('unavailable');
    expect(result['config_items']).toEqual([]);
  });

  it('does not mix build facts from a project switched during the query', async () => {
    const service = project();
    service.getBoardDependencies = async () => {
      service.currentProjectPath = '/other';
      return { '@aily-project/sdk-test': '2.0.0' };
    };
    const result = await getBoardConfig(service as any, 'build');
    expect(result['ok']).toBeFalse();
    expect(result['reason']).toBe('project_changed');
    expect(result['buildEnvironment']).toBeUndefined();
  });

  it('rejects a new manifest while the old board is still loaded, including pin-only reads', async () => {
    const service = project();
    service.getRuntimeBoardModule = () => '@aily-project/board-old';
    for (const section of ['all', 'build', 'pins']) {
      const result = await getBoardConfig(service as any, section);
      expect(result['ok']).toBeFalse();
      expect(result['reason']).toBe('board_state_mismatch');
      expect(result['buildEnvironment']).toBeUndefined();
    }
    expect(service.getBoardConfigMenu).not.toHaveBeenCalled();
  });

  it('pin-only reads attest identity without computing menus or build facts', async () => {
    const service = project();
    const result = await getBoardConfig(service as any, 'pins');
    expect(result['boardPackage']).toBe('@aily-project/board-test');
    expect(result['buildEnvironment']).toBeUndefined();
    expect(service.getBoardConfigMenu).not.toHaveBeenCalled();
  });

  it('retains Coder boardDependencies and legacy target lookup support', async () => {
    const service = project(); service.isAilyCodeProject = () => true;
    service.getPackageJson = async () => ({ boardDependencies: { '@aily-project/board-test': '1' } }) as any;
    expect((await getBoardConfig(service as any, 'pins'))['ok']).toBeTrue();
    service.getPackageJson = async () => ({}) as any;
    expect((await getBoardConfig(service as any, 'pins'))['ok']).toBeTrue();
  });

  function failedPinSynchronization(error: Error) {
    const service: any = project();
    const manifest = { dependencies: { '@aily-project/board-test': '1' }, projectConfig: { pnum: 'old' } };
    service.getPackageJson = async () => manifest;
    service.setPackageJson = jasmine.createSpy('persist selected config').and.resolveTo();
    service.getBoardConfigMenu.and.resolveTo([{ key: 'pnum', children: [
      { key: 'pnum', data: 'next', extra: { syncPinConfig: true } },
    ] }]);
    service.syncBoardPinConfig = jasmine.createSpy('sync pins').and.rejectWith(error);
    const builder: any = { triggerPreprocess: jasmine.createSpy('preprocess') };
    return { service, builder };
  }

  it('returns the original unknown save receipt and safe failure facts without replaying pin synchronization', async () => {
    const receipt = { version: 1, requestId: 'ui-save-original', project: '/project',
      operation: 'project_save', state: 'unknown' };
    const error = Object.assign(new Error('Observe the original save request'), {
      code: 'PROJECT_SAVE_RECEIPT_UNKNOWN', partial: true,
      saveReceipt: { ...receipt, capability: 'private-retry-token' },
      capability: 'do-not-forward', requestId: 'must-not-replace-original',
    });
    const { service, builder } = failedPinSynchronization(error);
    const result = await setBoardConfig(service, builder, {} as any, { config_key: 'pnum', config_value: 'next' });
    expect(result['ok']).toBeFalse();
    expect(result['persisted']).toBeTrue();
    expect(result['reason']).toBe('board_config_sync_failed');
    expect(result['code']).toBe('PROJECT_SAVE_RECEIPT_UNKNOWN');
    expect(result['saveReceipt']).toEqual(receipt);
    expect(result['partial']).toBeTrue();
    expect(result['capability']).toBeUndefined();
    expect(result['requestId']).toBeUndefined();
    expect(service.setPackageJson).toHaveBeenCalledTimes(1);
    expect(service.syncBoardPinConfig).toHaveBeenCalledTimes(1);
    expect(builder.triggerPreprocess).not.toHaveBeenCalled();
  });

  it('does not forward a foreign save receipt or malformed failure facts', async () => {
    const error = Object.assign(new Error('Invalid foreign save failure'), {
      code: 123, partial: 'true', saveReceipt: { version: 1, requestId: 'other-request', project: '/other',
        operation: 'project_save', state: 'unknown', capability: 'private-token' },
    });
    const { service, builder } = failedPinSynchronization(error);
    const result = await setBoardConfig(service, builder, {} as any, { config_key: 'pnum', config_value: 'next' });
    expect(result['ok']).toBeFalse();
    expect(result['code']).toBeUndefined();
    expect(result['saveReceipt']).toBeUndefined();
    expect(result['partial']).toBeUndefined();
    expect(service.syncBoardPinConfig).toHaveBeenCalledTimes(1);
    expect(builder.triggerPreprocess).not.toHaveBeenCalled();
  });
});
