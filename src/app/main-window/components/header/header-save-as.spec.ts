import { HeaderComponent } from './header.component';

describe('Header project save as', () => {
  let header: any;
  let previousApis: any;

  beforeEach(() => {
    previousApis = { path: window['path'], ipcRenderer: window['ipcRenderer'] };
    window['path'] = {
      dirname: () => '/Aily Projects',
      basename: () => 'My Project',
    };
    window['ipcRenderer'] = { invoke: jasmine.createSpy('dialog').and.resolveTo('/Aily Projects/Copy') };
    header = Object.create(HeaderComponent.prototype);
    header.projectService = {
      currentProjectPath: '/Aily Projects/My Project',
      currentPackageData: { name: 'my_project', path: '/legacy/default' },
      getProjectMode: jasmine.createSpy('mode').and.returnValue('coder'),
      saveAs: jasmine.createSpy('saveAs').and.resolveTo(),
    };
    header.message = { error: jasmine.createSpy('error') };
  });

  afterEach(() => Object.assign(window, previousApis));

  it('defaults Coder copies to a sibling directory and opts into empty cancellation', async () => {
    await header.process({ action: 'project-save-as' });
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledOnceWith('select-folder-saveAs', {
      path: '/Aily Projects', suggestedName: 'My Project_new', returnEmptyOnCancel: true,
    });
    expect(header.projectService.saveAs).toHaveBeenCalledOnceWith('/Aily Projects/Copy');
  });

  it('does nothing when the Coder dialog is cancelled', async () => {
    window['ipcRenderer'].invoke.and.resolveTo('');
    await header.process({ action: 'project-save-as' });
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
    finish('/Aily Projects/Copy');
    await first;
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledTimes(1);
    expect(header.projectService.saveAs).toHaveBeenCalledTimes(1);
  });

  it('does not copy a different project when the active project changes during the dialog', async () => {
    window['ipcRenderer'].invoke.and.callFake(async () => {
      header.projectService.currentProjectPath = '/different/project';
      return '/Aily Projects/Copy';
    });
    await header.process({ action: 'project-save-as' });
    expect(header.projectService.saveAs).not.toHaveBeenCalled();
    expect(header.message.error).toHaveBeenCalled();
  });

  it('retains the original Blockly dialog arguments and save call', async () => {
    header.projectService.getProjectMode.and.returnValue('blockly');
    await header.process({ action: 'project-save-as' });
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledOnceWith('select-folder-saveAs', {
      path: '/legacy/default', suggestedName: 'my_project_new',
    });
    expect(header.projectService.saveAs).toHaveBeenCalledOnceWith('/Aily Projects/Copy');
  });
});
