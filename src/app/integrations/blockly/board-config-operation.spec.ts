import { getBoardConfig } from './board-config-operation';

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
      getEffectiveBoardDependencies: async () => ({ '@aily-project/sdk-test': '1.0.0' }),
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

  it('the existing all response retains configuration and adds facts without persisting defaults', async () => {
    const service = project();
    const result = await getBoardConfig(service as any);
    expect(result['config_items']).toEqual([]);
    expect(result['buildEnvironment']).toBeDefined();
    expect(service.getBoardConfigMenu).toHaveBeenCalledOnceWith({ persistDefaults: false });
  });

  it('reports unavailable facts instead of guessing SDK paths or failing unrelated board configuration', async () => {
    const service = project();
    service.getEffectiveBoardDependencies = async () => { throw new Error('dependencies unavailable'); };
    const result = await getBoardConfig(service as any);
    expect(result['ok']).toBeTrue();
    expect((result['buildEnvironment'] as any).status).toBe('unavailable');
    expect(result['config_items']).toEqual([]);
  });

  it('does not mix build facts from a project switched during the query', async () => {
    const service = project();
    service.getEffectiveBoardDependencies = async () => {
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
});
