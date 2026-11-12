import { ProjectApplicationAdapter } from './project-application.adapter';
import { ConfigService } from '@core/preferences/public-api';

describe('Blockly to Coder current source capture', () => {
  let adapter: any, originalFs: any, originalFsp: any, originalPath: any, originalBuilder: any, originalCloud: any;
  beforeEach(() => {
    originalFs = window['fs']; originalFsp = window['fsp']; originalPath = window['path'];
    originalBuilder = window['builder']; originalCloud = window['cloudBuild'];
    adapter = Object.create(ProjectApplicationAdapter.prototype);
    adapter.projectService = { currentProjectPath: '/project', getBoardModule: async () => '@aily-project/board-test' };
    adapter.blocklyEditorProjectService = { currentProjectPath: '/project' };
    adapter.blocklyService = { runWithPreparedProjectCode: async (callback: any) => callback({
      code: 'void setup() { delay(913); } void loop() {}', artifacts: [],
      projectMacros: [{name: 'DRIVER', value: 'DRIVER=913'}],
      sourceWorkspace: {documentText: '{"blocks":{}}', revision: 7, runtimeRevision: 2, pageId: 'main'},
    }, () => {}) };
    window['path'] = {join: (...parts: string[]) => parts.join('/')};
    window['fs'] = {blocklyCoderConversionVersion: 2, readFileSync: jasmine.createSpy('read').and.returnValue(JSON.stringify({
      MACROS: [['USER=1'], ['DRIVER=731']], ailyGeneratorMacros: {DRIVER: 'DRIVER=731'},
    })), convertBlocklyProjectToCoder: jasmine.createSpy('convert').and.returnValue('/project_coder')};
    window['fsp'] = {rm: jasmine.createSpy('rm').and.resolveTo()};
    window['builder'] = {inspectBlocklyCompileProof: jasmine.createSpy('localEvidence').and.resolveTo({version: 1, status: 'unverified'}),
      captureBuildSource: jasmine.createSpy('capture').and.returnValue({workspace: {revision: 7}})};
    window['cloudBuild'] = {reusable: jasmine.createSpy('cloudEvidence').and.resolveTo(false)};
    adapter.settings = {backend: 'local', key: 'settings-1',
      getCompileBackend() {return this.backend;}, getCompileSettingsKey() {return this.key;}};
    adapter.injector = {get: jasmine.createSpy('inject').and.callFake((token: any) => {
      expect(token).toBe(ConfigService);
      return adapter.settings;
    })};
  });
  afterEach(() => {
    window['fs'] = originalFs; window['fsp'] = originalFsp; window['path'] = originalPath;
    window['builder'] = originalBuilder; window['cloudBuild'] = originalCloud;
  });

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

  it('recognizes matching native build evidence without resolving a second component-scoped builder', async () => {
    window['builder'].inspectBlocklyCompileProof.and.resolveTo({version: 1, status: 'verified'});
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeTrue();
    expect(window['builder'].inspectBlocklyCompileProof).toHaveBeenCalledOnceWith({currentProjectPath: '/project',
      boardModule: '@aily-project/board-test', code: 'void setup() { delay(913); } void loop() {}',
      projectMacros: [{name: 'DRIVER', value: 'DRIVER=913'}], generatedArtifacts: []});
  });

  it('distinguishes unverified evidence from unavailable evidence and rejects another project without invoking a compiler', async () => {
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeFalse();
    window['builder'].inspectBlocklyCompileProof.and.resolveTo({version: 1, status: 'unknown'});
    await expectAsync(adapter.hasVerifiedBlocklyBuild('/project')).toBeRejectedWithError(/unavailable/);
    expect(await adapter.hasVerifiedBlocklyBuild('/another')).toBeFalse();
    expect(window['builder'].inspectBlocklyCompileProof).toHaveBeenCalledTimes(2);
  });

  it('uses the current generated inputs so an older successful code snapshot cannot hide a warning', async () => {
    window['builder'].inspectBlocklyCompileProof.and.callFake(async (config: any) => ({version: 1, status: config.code.includes('delay(913)') ? 'verified' : 'unverified'}));
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeTrue();
    const original = adapter.blocklyService.runWithPreparedProjectCode;
    adapter.blocklyService.runWithPreparedProjectCode = (callback: any) => original((prepared: any, current: any) =>
      callback({...prepared, code: 'void setup() { delay(914); } void loop() {}'}, current));
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeFalse();
  });

  it('reports an old or failed preload as unknown instead of claiming a failed build', async () => {
    delete window['builder'].inspectBlocklyCompileProof;
    await expectAsync(adapter.hasVerifiedBlocklyBuild('/project')).toBeRejectedWithError(/restart/);
    window['builder'].inspectBlocklyCompileProof = async () => {throw new Error('worker exited');};
    await expectAsync(adapter.hasVerifiedBlocklyBuild('/project')).toBeRejectedWithError('worker exited');
  });

  it('rejects a late native worker proof after the project or compilation settings change', async () => {
    window['builder'].inspectBlocklyCompileProof.and.callFake(async () => {
      adapter.projectService.currentProjectPath = '/replacement';
      return {version: 1, status: 'verified'};
    });
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeFalse();
    adapter.projectService.currentProjectPath = '/project';
    window['builder'].inspectBlocklyCompileProof.and.callFake(async () => {
      adapter.settings.key = 'settings-2';
      return {version: 1, status: 'verified'};
    });
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeFalse();
  });

  it('verifies cloud results using the captured workspace and never substitutes local evidence', async () => {
    adapter.settings.backend = 'cloud';
    window['builder'].inspectBlocklyCompileProof.and.resolveTo({version: 1, status: 'verified'});
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeFalse();
    window['cloudBuild'].reusable.and.resolveTo(true);
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeTrue();
    expect(window['builder'].captureBuildSource).toHaveBeenCalled();
    expect(window['cloudBuild'].reusable.calls.mostRecent().args[0].config.sourceCapture).toEqual({workspace: {revision: 7}});
    expect(window['builder'].inspectBlocklyCompileProof).not.toHaveBeenCalled();
  });

  it('rejects a project or compile settings switch while an asynchronous cloud proof is being read', async () => {
    adapter.settings.backend = 'cloud';
    window['cloudBuild'].reusable.and.callFake(async () => {adapter.projectService.currentProjectPath = '/replacement'; return true;});
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeFalse();
    adapter.projectService.currentProjectPath = '/project';
    window['cloudBuild'].reusable.and.callFake(async () => {adapter.settings.key = 'settings-2'; return true;});
    expect(await adapter.hasVerifiedBlocklyBuild('/project')).toBeFalse();
  });
});
