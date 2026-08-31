import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectService } from './project.service';
import { detectProjectMode, getProjectCreationModeError, type ProjectMode } from './project-mode';
import { getGuideRecentProjects } from './recent-projects';
import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';

describe('project mode boundaries', () => {
  const blockly = { name: 'Blocks', path: '/projects/blocks' };
  const coder = { name: 'Code', path: '/projects/code' };

  function createService(mode: ProjectMode): any {
    const service = Object.create(ProjectService.prototype);
    service.configService = {
      data: { recentlyProjects: [coder, blockly] },
      init: jasmine.createSpy('init').and.resolveTo(),
      getPreferredChatAgentRuntimeMode: () => mode,
      save: jasmine.createSpy('save').and.resolveTo(),
    };
    service.currentProjectPathSubject = new BehaviorSubject(blockly.path);
    service.stateSubject = new BehaviorSubject('loaded');
    service.projectActivationSubject = new Subject();
    service.electronService = { isElectron: true, exists: () => true };
    service.messageService = { error: jasmine.createSpy('error'), warning: jasmine.createSpy('warning') };
    service.modalService = { confirm: jasmine.createSpy('confirm') };
    service.translate = { instant: (key: string) => key };
    spyOn(service, 'getProjectMode').and.callFake((path: string) => path.includes('code') ? 'coder' : path.includes('blocks') ? 'blockly' : null);
    spyOn(service, 'shouldBlockForAiOperation').and.returnValue(false);
    return service;
  }

  it('recognizes source-only Coder projects and lets the manifest override a stale ABI', () => {
    expect(detectProjectMode({ manifest: { type: 'coder', entry: 'src/main.cpp' }, hasAbi: false, hasAci: false })).toBe('coder');
    expect(detectProjectMode({ manifest: { type: 'coder' }, hasAbi: true, hasAci: false })).toBe('coder');
    expect(detectProjectMode({ hasAbi: true, hasAci: false })).toBe('blockly');
    expect(detectProjectMode({ hasAbi: false, hasAci: true })).toBe('coder');
    expect(detectProjectMode({ manifest: { type: 'module' }, hasAbi: false, hasAci: false })).toBeNull();
  });

  it('filters before the six-item guide limit and preserves both modes when history changes', () => {
    const service = createService('blockly');
    service.configService.data.recentlyProjects = [coder, ...Array.from({ length: 8 }, (_, i) => ({ name: `${i}`, path: `/blocks/${i}` }))];
    expect(service.recentlyProjects.length).toBe(8);
    expect(getGuideRecentProjects(service.recentlyProjects).length).toBe(6);
    service.addRecentlyProject(blockly);
    expect(service.configService.data.recentlyProjects).toContain(coder);
    expect(service.recentlyProjects).not.toContain(coder);
    service.removeRecentlyProject(blockly);
    expect(service.configService.data.recentlyProjects).toContain(coder);
    expect(service.configService.data.recentlyProjects).not.toContain(blockly);
    service.configService.getPreferredChatAgentRuntimeMode = () => 'coder';
    expect(service.recentlyProjects).toEqual([coder]);
  });

  for (const mode of ['blockly', 'coder'] as const) {
    it(`still activates matching ${mode} projects through the correct editor`, async () => {
      const service = createService(mode);
      const originalIpc = window['ipcRenderer'];
      window['ipcRenderer'] = { invoke: jasmine.createSpy('invoke').and.resolveTo() };
      service.routerService = { url: '/main/guide', navigate: jasmine.createSpy('navigate').and.resolveTo(true) };
      Object.defineProperty(service, 'application', { value: { closeConnectionGraphWindows: async () => true } });
      spyOn(service, 'waitForProjectOpenCompletion').and.resolveTo();
      try {
        const target = mode === 'coder' ? coder.path : blockly.path;
        expect(await service.projectOpen(target, { reason: 'open' })).toBeTrue();
        expect(service.currentProjectPath).toBe(target);
        expect(service.routerService.navigate).toHaveBeenCalledWith(
          [mode === 'coder' ? '/main/code-editor-pro' : '/main/blockly-editor'],
          { queryParams: { path: target }, replaceUrl: true },
        );
        expect(service.modalService.confirm).not.toHaveBeenCalled();
      } finally { window['ipcRenderer'] = originalIpc; }
    });

    it(`rejects a different project in ${mode} before changing the project, route, lock or activation`, async () => {
      const service = createService(mode);
      const originalIpc = window['ipcRenderer'];
      const originalLock = window['projectLock'];
      const acquire = jasmine.createSpy('acquire');
      const activated = jasmine.createSpy('activated');
      service.projectActivationSubject.subscribe(activated);
      window['ipcRenderer'] = { invoke: jasmine.createSpy('invoke').and.resolveTo({ installed: true }) };
      window['projectLock'] = { tryAcquire: acquire };
      try {
        const target = mode === 'blockly' ? coder.path : blockly.path;
        expect(await service.projectOpen(target)).toBeFalse();
        expect(service.currentProjectPath).toBe(blockly.path);
        expect(service.stateSubject.value).toBe('loaded');
        expect(acquire).not.toHaveBeenCalled();
        expect(activated).not.toHaveBeenCalled();
        expect(service.modalService.confirm).toHaveBeenCalled();
        const dialog = service.modalService.confirm.calls.mostRecent().args[0];
        expect(dialog.nzContent).toBe('PROJECT.MODE_OPEN_OTHER');
        expect(window['ipcRenderer'].invoke).toHaveBeenCalledTimes(1);
      } finally {
        window['ipcRenderer'] = originalIpc;
        window['projectLock'] = originalLock;
      }
    });

    it(`rejects incompatible create calls before touching the filesystem in ${mode}`, async () => {
      const service = createService(mode);
      const updateFooterState = jasmine.createSpy('footer');
      Object.defineProperty(service, 'application', { value: { updateFooterState } });
      service.platformService = { getPlatformSeparator: jasmine.createSpy('separator') };
      expect(await service.projectNew({}, { templateDirectory: mode === 'blockly' ? 'template_arduino' : 'template' })).toBeFalse();
      expect(service.platformService.getPlatformSeparator).not.toHaveBeenCalled();
      expect(service.messageService.error).toHaveBeenCalled();
    });

    it(`makes AI use ${mode} and rejects explicit mode overrides before creating anything`, async () => {
      const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
      bridge.configService = createService(mode).configService;
      const createCoder = spyOn(bridge, 'executeCoderProjectCreate').and.resolveTo({ ok: true });
      bridge.projectService = { createDefaultNewProjectData: jasmine.createSpy('defaults') };
      const result = await bridge.executeProjectCreate({ developmentMode: mode === 'blockly' ? 'coder' : 'blockly' });
      expect(result.reason).toBe('project_mode_mismatch');
      expect(createCoder).not.toHaveBeenCalled();
      expect(bridge.projectService.createDefaultNewProjectData).not.toHaveBeenCalled();
      if (mode === 'coder') {
        await bridge.executeProjectCreate({ boardName: 'board-uno' });
        expect(createCoder).toHaveBeenCalledWith({ boardName: 'board-uno' });
      }
    });
  }

  it('only offers the download action when the companion is absent and does not launch without a click', async () => {
    const service = createService('blockly');
    const originalIpc = window['ipcRenderer'];
    const invoke = jasmine.createSpy('invoke').and.resolveTo({ installed: false, ok: true });
    window['ipcRenderer'] = { invoke };
    try {
      expect(await service.ensureProjectModeAllowed(coder.path)).toBeFalse();
      expect(invoke).toHaveBeenCalledTimes(1);
      const dialog = service.modalService.confirm.calls.mostRecent().args[0];
      expect(dialog.nzContent).toBe('PROJECT.MODE_DOWNLOAD_OTHER');
      await dialog.nzOnOk();
      expect(invoke).toHaveBeenCalledWith('project-companion-download', { mode: 'coder', projectPath: coder.path });
    } finally { window['ipcRenderer'] = originalIpc; }
  });

  it('leaves firmware devmode separate from the host project type', () => {
    expect(getProjectCreationModeError('blockly', { devmode: 'micropython' })).toBeNull();
    expect(getProjectCreationModeError('coder', { developmentMode: 'coder', devmode: 'arduino' })).toBeNull();
    expect(getProjectCreationModeError('coder', { projectType: 'blockly' })).toContain('Aily Coder');
    expect(getProjectCreationModeError('blockly', { developmentMode: 'unknown' })).toContain('Aily Blockly');
  });
});
