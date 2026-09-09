import { HeaderComponent } from './header.component';

describe('Header add Coder project', () => {
  let header: any;
  let originals: any;
  beforeEach(() => {
    originals = { path: window['path'], ipcRenderer: window['ipcRenderer'] };
    window['path'] = { dirname: () => '/projects' };
    window['ipcRenderer'] = { invoke: jasmine.createSpy('dialog').and.resolveTo({ filePaths: ['/projects/b', '/projects/c'] }) };
    header = Object.create(HeaderComponent.prototype);
    header.translate = { instant: (key: string) => key };
    header.message = { error: jasmine.createSpy('error') };
    header.projectService = {
      currentProjectPath: '/projects/a',
      getProjectMode: jasmine.createSpy('mode').and.returnValue('coder'),
      addCoderProject: jasmine.createSpy('add').and.resolveTo(),
      projectOpen: jasmine.createSpy('open'),
    };
  });
  afterEach(() => Object.assign(window, originals));

  it('defers saving on open and new to the Coder activation handshake', async () => {
    expect(await header.checkUnsavedChanges('open')).toBeTrue();
    expect(await header.checkUnsavedChanges('new')).toBeTrue();
  });

  it('adds selected projects as tabs without switching the editor', async () => {
    await header.process({ action: 'project-add' });
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledOnceWith('dialog-select-files', {
      title: 'MENU.PROJECT_ADD', defaultPath: '/projects', properties: ['openDirectory', 'multiSelections'],
    });
    expect(header.projectService.addCoderProject.calls.allArgs()).toEqual([['/projects/b'], ['/projects/c']]);
    expect(header.projectService.projectOpen).not.toHaveBeenCalled();
  });

  it('does nothing when the dialog is cancelled or the host is in Blockly mode', async () => {
    window['ipcRenderer'].invoke.and.resolveTo({ canceled: true, filePaths: [] });
    await header.process({ action: 'project-add' });
    expect(header.projectService.addCoderProject).not.toHaveBeenCalled();
    header.projectService.getProjectMode.and.returnValue('blockly');
    await header.process({ action: 'project-add' });
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledTimes(1);
  });

  it('blocks duplicate dialogs and allows a retry after a failed addition', async () => {
    let finish!: (result: any) => void;
    window['ipcRenderer'].invoke.and.returnValue(new Promise(resolve => { finish = resolve; }));
    header.projectService.addCoderProject.and.rejectWith(new Error('locked'));
    const pending = header.process({ action: 'project-add' });
    await header.process({ action: 'project-add' });
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledTimes(1);
    finish({ filePaths: ['/projects/b'] });
    await pending;
    expect(header.message.error).toHaveBeenCalledWith('locked');
    window['ipcRenderer'].invoke.and.resolveTo({ filePaths: ['/projects/c'] });
    header.projectService.addCoderProject.and.resolveTo();
    await header.process({ action: 'project-add' });
    expect(header.projectService.addCoderProject).toHaveBeenCalledTimes(2);
  });
});
