import { HeaderComponent } from './header.component';

describe('Header project save as', () => {
  let header: any;
  let previousApis: any;

  beforeEach(() => {
    previousApis = { path: window['path'], ipcRenderer: window['ipcRenderer'] };
    window['path'] = {
      dirname: () => '/aily Projects',
      basename: () => 'My Project',
    };
    window['ipcRenderer'] = { invoke: jasmine.createSpy('dialog').and.resolveTo('/aily Projects/Copy') };
    header = Object.create(HeaderComponent.prototype);
    header.projectService = {
      currentProjectPath: '/aily Projects/My Project',
      currentPackageData: { name: 'my_project', path: '/legacy/default' },
      getProjectMode: jasmine.createSpy('mode').and.returnValue('coder'),
      captureCurrentProjectGuard() {
        const original = this.currentProjectPath;
        return () => this.currentProjectPath === original;
      },
      getSaveAsBlockMessage: jasmine.createSpy('blockMessage'),
      saveAs: jasmine.createSpy('saveAs').and.resolveTo(),
    };
    header.message = { error: jasmine.createSpy('error'), warning: jasmine.createSpy('warning') };
  });

  afterEach(() => Object.assign(window, previousApis));

  it('defaults Coder copies to a sibling directory and opts into empty cancellation', async () => {
    await header.process({ action: 'project-save-as' });
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledOnceWith('select-folder-saveAs', {
      path: '/aily Projects', suggestedName: 'My Project_new', returnEmptyOnCancel: true,
    });
    expect(header.projectService.saveAs).toHaveBeenCalledOnceWith('/aily Projects/Copy');
  });

  for (const mode of ['blockly', 'coder']) it(`does nothing when the ${mode} dialog is cancelled`, async () => {
    header.projectService.getProjectMode.and.returnValue(mode);
    window['ipcRenderer'].invoke.and.resolveTo('');
    await header.process({ action: 'project-save-as' });
    expect(window['ipcRenderer'].invoke.calls.mostRecent().args[1].returnEmptyOnCancel).toBe(true);
    expect(header.projectService.saveAs).not.toHaveBeenCalled();
    expect(header.message.error).not.toHaveBeenCalled();
  });

  it('shows failures and permits a subsequent retry', async () => {
    header.projectService.saveAs.and.rejectWith(new Error('disk full'));
    await header.process({ action: 'project-save-as' });
    expect(header.message.error).toHaveBeenCalledOnceWith('另存为失败：disk full');
    header.projectService.saveAs.and.resolveTo();
    await header.process({ action: 'project-save-as' });
    expect(header.projectService.saveAs).toHaveBeenCalledTimes(2);
  });

  it('suppresses repeated clicks while the save dialog is pending', async () => {
    let finish!: (path: string) => void;
    window['ipcRenderer'].invoke.and.returnValue(new Promise<string>(resolve => { finish = resolve; }));
    const first = header.process({ action: 'project-save-as' });
    await header.process({ action: 'project-save-as' });
    finish('/aily Projects/Copy');
    await first;
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledTimes(1);
    expect(header.projectService.saveAs).toHaveBeenCalledTimes(1);
  });

  it('does not copy a different project when the active project changes during the dialog', async () => {
    window['ipcRenderer'].invoke.and.callFake(async () => {
      header.projectService.currentProjectPath = '/different/project';
      return '/aily Projects/Copy';
    });
    await header.process({ action: 'project-save-as' });
    expect(header.projectService.saveAs).not.toHaveBeenCalled();
    expect(header.message.error).toHaveBeenCalled();
  });

  it('preserves Blockly defaults and opts into empty cancellation', async () => {
    header.projectService.getProjectMode.and.returnValue('blockly');
    await header.process({ action: 'project-save-as' });
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledOnceWith('select-folder-saveAs', {
      path: '/legacy/default', suggestedName: 'my_project_new', returnEmptyOnCancel: true,
    });
    expect(header.projectService.saveAs).toHaveBeenCalledOnceWith('/aily Projects/Copy');
  });
  for (const mode of ['blockly', 'coder']) it(`blocks ${mode} Save As while AI is running without opening a dialog`, async () => {
    header.projectService.getProjectMode.and.returnValue(mode);
    header.projectService.getSaveAsBlockMessage.and.returnValue('AI 任务正在运行，请等待完成后再另存为。');
    await header.process({ action: 'project-save-as' });
    expect(window['ipcRenderer'].invoke).not.toHaveBeenCalled();
    expect(header.projectService.saveAs).not.toHaveBeenCalled();
    expect(header.message.warning).toHaveBeenCalledWith('AI 任务正在运行，请等待完成后再另存为。');
  });
  it('rechecks AI state after the destination dialog', async () => {
    window['ipcRenderer'].invoke.and.callFake(async () => {
      header.projectService.getSaveAsBlockMessage.and.returnValue('AI busy'); return '/copy';
    });
    await header.process({ action: 'project-save-as' });
    expect(header.projectService.saveAs).not.toHaveBeenCalled(); expect(header.message.warning).toHaveBeenCalledWith('AI busy');
  });

  for (const action of ['project-save-as', 'project-save']) it(`routes automated ${action} before UI or document side effects`, async () => {
    const itemId = `header/${action}~1`;
    header.createHeaderMenuAutomationSnapshot = () => ({ sourceById: new Map([[itemId, { action }]]) });
    header.showInRouter = () => true;
    header.process = jasmine.createSpy('process').and.throwError('Automation must use the candidate-aware operation');
    const result = await header.executeHeaderMenuAutomationItem(itemId, { confirm: true });
    expect(result).toEqual(jasmine.objectContaining({ ok: false, commandDispatched: false, requiresUserAction: false,
      code: action === 'project-save-as' ? 'PROJECT_RECOVERY_IN_PLACE_REQUIRED' : 'PROJECT_SAVE_REQUIRES_TOOL' }));
    expect(result.nextAction.tool).toBe(action === 'project-save-as' ? 'project_recover' : 'project_save');
    expect(header.process).not.toHaveBeenCalled();
    expect(window['ipcRenderer'].invoke).not.toHaveBeenCalled();
    expect(header.projectService.saveAs).not.toHaveBeenCalled();
  });

  for (const [action, tool] of [['project-new', 'project_create'], ['project-open', 'app_open'],
    ['recent-project-open', 'app_open'], ['project-close', 'app_close']]) {
    it(`routes ${action} through candidate-preserving tools before any dialog or navigation`, async () => {
      const itemId = `header/${action}~1`;
      header.createHeaderMenuAutomationSnapshot = () => ({ sourceById: new Map([[itemId, { action }]]) });
      header.showInRouter = () => true;
      header.process = jasmine.createSpy('process').and.throwError('No direct lifecycle operation');
      header.onHeaderMenuSubItemClick = jasmine.createSpy('recent').and.throwError('No recent-project navigation');
      const result = await header.executeHeaderMenuAutomationItem(itemId, { confirm: true });
      expect(result).toEqual(jasmine.objectContaining({ ok: false, commandDispatched: false,
        requiresUserAction: false, code: 'PROJECT_LIFECYCLE_REQUIRES_TOOL' }));
      expect(result.nextAction.tool).toBe(tool);
      expect(header.process).not.toHaveBeenCalled();
      expect(header.onHeaderMenuSubItemClick).not.toHaveBeenCalled();
      expect(window['ipcRenderer'].invoke).not.toHaveBeenCalled();
    });
  }

});
