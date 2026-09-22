import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';

describe('shared project tools route by project mode', () => {
  const board = '@aily-project/board-old';
  const target = '@aily-project/board-new';
  function fixture() {
    let manifest: any = { type: 'coder', dependencies: { [board]: '1' }, entry: 'firmware/app.cpp' };
    let activeBoard = board;
    const session = { editorReady: true, busy: null as string | null,
      project: { syncCurrentBoardConfig: jasmine.createSpy('syncCoder').and.resolveTo(true) } };
    const service: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    service.projectService = {
      currentProjectPath: '/coder', coderProjects: [{ path: '/coder' }],
      getProjectMode: () => 'coder', isAilyCodeProject: () => true,
      isProjectTransitionInProgress: () => false,
      currentBoardConfig: {}, getRuntimeBoardModule: () => activeBoard,
      getPackageJson: async () => manifest,
      setPackageJson: jasmine.createSpy('persist').and.callFake(async value => { manifest = value; }),
      getBoardConfigMenu: async () => [{ key: 'Speed', children: [{ key: 'Speed', data: 'fast' }] }],
      getBlocklyProjectLoadStatus: jasmine.createSpy('blocklyStatus').and.throwError('Coder must not query Blockly readiness'),
      changeBoard: jasmine.createSpy('nativeSwitch').and.callFake(async value => {
        activeBoard = value.name;
        manifest.dependencies = { [value.name]: value.version };
      }),
    };
    service.coderRuntime = { getSession: () => session, build: jasmine.createSpy('coderPreprocess').and.resolveTo({}) };
    service.configService = { init: async () => {}, boardDict: { [target]: { version: '2' }, [board]: { version: '1' } } };
    service.builderService = { triggerPreprocess: jasmine.createSpy('blocklyPreprocess').and.throwError('Wrong preprocessor') };
    service.blocklyEditor = { setAiWritingActive: jasmine.createSpy('blocklyWrite').and.throwError('Wrong editor') };
    service.aiOperations = { setActive: jasmine.createSpy('aiActive') };
    service.electronService = {};
    return { service, session, manifest: () => manifest,
      execute: (operation: string, params = {}, path = '/coder') => service.executeOperation({ operation, params, path }) };
  }

  it('reads board identity using Coder readiness even without Blockly state', async () => {
    const f = fixture();
    const result = await f.execute('get_board_config', { section: 'pins' });
    expect(result.ok).toBeTrue();
    expect(result.boardPackage).toBe(board);
    expect(f.service.projectService.getBlocklyProjectLoadStatus).not.toHaveBeenCalled();
  });

  it('persists Coder configuration and preprocesses through its own runtime', async () => {
    const f = fixture();
    const result = await f.execute('set_board_config', { config_key: 'Speed', config_value: 'fast' });
    expect(result.ok).toBeTrue();
    expect(result.preprocess_requested).toBeTrue();
    expect(f.manifest().projectConfig.Speed).toBe('fast');
    expect(f.service.coderRuntime.build).toHaveBeenCalledOnceWith('/coder', { preprocessOnly: true });
    expect(f.service.builderService.triggerPreprocess).not.toHaveBeenCalled();
  });

  it('reports persisted configuration honestly if Coder preprocessing fails', async () => {
    const f = fixture(); f.service.coderRuntime.build.and.rejectWith(new Error('SDK unavailable'));
    const result = await f.execute('set_board_config', { config_key: 'Speed', config_value: 'fast' });
    expect(result.ok).toBeFalse(); expect(result.persisted).toBeTrue();
    expect(result.reason).toBe('board_config_sync_failed');
    expect(result.message).toContain('SDK unavailable');
  });

  it('switches Coder through the native lifecycle without Blockly mutation or runtime sync', async () => {
    const f = fixture();
    const result = await f.execute('board_switch', { boardName: target, developmentMode: 'coder' });
    expect(result.ok).toBeTrue(); expect(result.developmentMode).toBe('coder');
    expect(result.boardPackage).toBe(target);
    expect(f.service.projectService.changeBoard).toHaveBeenCalledOnceWith({ name: target, version: '2' });
    expect(f.session.project.syncCurrentBoardConfig).toHaveBeenCalledTimes(1);
    expect(f.service.blocklyEditor.setAiWritingActive).not.toHaveBeenCalled();
    expect(f.manifest().entry).toBe('firmware/app.cpp');
  });

  it('same-board Coder requests are idempotent and still attest readiness', async () => {
    const f = fixture();
    const result = await f.execute('board_switch', { boardName: board, developmentMode: 'coder' });
    expect(result.ok).toBeTrue(); expect(result.changed).toBeFalse();
    expect(f.service.projectService.changeBoard).not.toHaveBeenCalled();
  });

  it('rejects wrong mode, wrong project, busy and unready contexts before changing a board', async () => {
    const f = fixture();
    expect((await f.execute('board_switch', { boardName: target, developmentMode: 'blockly' })).reason).toBe('project_mode_mismatch');
    expect((await f.execute('board_switch', { boardName: target }, '/other')).ok).toBeFalse();
    f.session.busy = 'build';
    expect((await f.execute('board_switch', { boardName: target })).reason).toBe('project_operation_busy');
    expect((await f.execute('set_board_config', { config_key: 'Speed', config_value: 'fast' })).reason).toBe('project_operation_busy');
    f.session.busy = null; f.session.editorReady = false;
    expect((await f.execute('board_switch', { boardName: target })).reason).toBe('project_not_ready');
    expect(f.service.projectService.changeBoard).not.toHaveBeenCalled();
    expect(f.service.projectService.setPackageJson).not.toHaveBeenCalled();
  });

  it('still rejects Blockly workspace operations in Coder', async () => {
    const f = fixture();
    for (const operation of ['abs_projection', 'abs_apply', 'block_metadata_snapshot', 'library_runtime_sync']) {
      expect((await f.execute(operation)).reason).toBe('coder_operation_mismatch');
    }
  });
});
