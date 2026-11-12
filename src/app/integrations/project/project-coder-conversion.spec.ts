import { ProjectApplicationAdapter } from './project-application.adapter';

describe('Blockly to Coder current source capture', () => {
  let adapter: any, originalFs: any, originalFsp: any, originalPath: any;
  beforeEach(() => {
    originalFs = window['fs']; originalFsp = window['fsp']; originalPath = window['path'];
    adapter = Object.create(ProjectApplicationAdapter.prototype);
    adapter.projectService = { currentProjectPath: '/project' };
    adapter.blocklyEditorProjectService = { currentProjectPath: '/project' };
    adapter.blocklyService = { runWithPreparedProjectCode: async (callback: any) => callback({
      code: 'void setup() { delay(913); } void loop() {}', artifacts: [],
      projectMacros: [{name: 'DRIVER', value: 'DRIVER=913'}],
    }, () => {}) };
    window['path'] = {join: (...parts: string[]) => parts.join('/')};
    window['fs'] = {blocklyCoderConversionVersion: 2, readFileSync: jasmine.createSpy('read').and.returnValue(JSON.stringify({
      MACROS: [['USER=1'], ['DRIVER=731']], ailyGeneratorMacros: {DRIVER: 'DRIVER=731'},
    })), convertBlocklyProjectToCoder: jasmine.createSpy('convert').and.returnValue('/project_coder')};
    window['fsp'] = {rm: jasmine.createSpy('rm').and.resolveTo()};
  });
  afterEach(() => {window['fs'] = originalFs; window['fsp'] = originalFsp; window['path'] = originalPath;});

  it('passes the protected current generation and merged macros without reading shared generated files', async () => {
    expect(await adapter.createBlocklyCoderProject('/project')).toBe('/project_coder');
    expect(window['fs'].readFileSync).toHaveBeenCalledOnceWith('/project/package.json', 'utf8');
    expect(window['fs'].convertBlocklyProjectToCoder).toHaveBeenCalledOnceWith('/project', undefined, {
      code: 'void setup() { delay(913); } void loop() {}', artifacts: [], macros: [['USER=1'], ['DRIVER=913']],
    });
  });

  it('rejects a replaced project before creating a copy', async () => {
    adapter.projectService.currentProjectPath = '/replacement';
    await expectAsync(adapter.createBlocklyCoderProject('/project')).toBeRejectedWithError(/已切换/);
    expect(window['fs'].convertBlocklyProjectToCoder).not.toHaveBeenCalled();
  });

  it('removes only its new copy if the protected revision becomes invalid', async () => {
    const original = adapter.blocklyService.runWithPreparedProjectCode;
    adapter.blocklyService.runWithPreparedProjectCode = async (callback: any) => { await original(callback); throw new Error('revision changed'); };
    await expectAsync(adapter.createBlocklyCoderProject('/project')).toBeRejectedWithError('revision changed');
    expect(window['fsp'].rm).toHaveBeenCalledOnceWith('/project_coder', {recursive: true, force: true});
  });

  it('rejects an old preload instead of letting it silently ignore the current generated snapshot', async () => {
    delete window['fs'].blocklyCoderConversionVersion;
    await expectAsync(adapter.createBlocklyCoderProject('/project')).toBeRejectedWithError(/重启/);
    expect(window['fs'].convertBlocklyProjectToCoder).not.toHaveBeenCalled();
  });

  it('treats absent or failed current build evidence as unverified without invoking a compiler', async () => {
    const builder = {canReuseBuildForUpload: jasmine.createSpy('evidence').and.resolveTo(false)};
    adapter.injector = {get: () => builder};
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeFalse();
    builder.canReuseBuildForUpload.and.resolveTo(true);
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeTrue();
    builder.canReuseBuildForUpload.and.rejectWith(new Error('unreadable evidence'));
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeFalse();
    expect(await adapter.hasVerifiedBlocklyBuild('/another')).toBeFalse();
    expect(builder.canReuseBuildForUpload).toHaveBeenCalledTimes(3);
  });
});
