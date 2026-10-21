import { AppStoreComponent } from './app-store.component';

describe('Coder editor uninstall protection', () => {
  const editor = {
    id: 'aily-coder-editor',
    extension: true,
    subapp: { catalogId: 'aily-coder-editor', installed: true },
  };

  function createStore() {
    const store = Object.create(AppStoreComponent.prototype) as any;
    store.configService = { isCoderProduct: () => true };
    store.projectService = { currentProjectPath: '/project' };
    store.cdr = { markForCheck: () => {} };
    store.translate = { instant: (key: string) => key };
    store.childToolProcess = {
      stop: jasmine.createSpy('stop').and.resolveTo(undefined),
      forceStop: jasmine.createSpy('forceStop').and.resolveTo(undefined),
    };
    store.uiService = { closeTool: jasmine.createSpy('closeTool') };
    store.subappManager = { uninstall: jasmine.createSpy('uninstall').and.resolveTo(undefined) };
    return store;
  }

  it('only disables the Coder editor while a project is open in the Coder product', () => {
    const store = createStore();
    expect(store.isSubappUninstallBlocked(editor)).toBeTrue();
    expect(store.isSubappUninstallBlocked({ id: 'aily-chat' })).toBeFalse();
    store.projectService.currentProjectPath = '';
    expect(store.isSubappUninstallBlocked(editor)).toBeFalse();
    store.projectService.currentProjectPath = '/project';
    store.configService.isCoderProduct = () => false;
    expect(store.isSubappUninstallBlocked(editor)).toBeFalse();
  });

  it('cancels an existing confirmation without stopping the editor', async () => {
    const store = createStore();
    store.confirmUninstallCatalogId = editor.id;
    store.uninstallSubapp(editor);
    await store.runSubappAction('uninstall', editor);
    // The interrupted-uninstall card also routes through runSubappAction.
    store.openApp({ ...editor, subapp: { ...editor.subapp, uninstalling: true } });
    expect(store.confirmUninstallCatalogId).toBe('');
    expect(store.childToolProcess.stop).not.toHaveBeenCalled();
    expect(store.uiService.closeTool).not.toHaveBeenCalled();
    expect(store.subappManager.uninstall).not.toHaveBeenCalled();
  });

  it('allows the normal confirmation after closing the project', () => {
    const store = createStore();
    store.projectService.currentProjectPath = '';
    store.runSubappAction = jasmine.createSpy('runSubappAction');
    store.uninstallSubapp(editor);
    expect(store.confirmUninstallCatalogId).toBe(editor.id);
    store.uninstallSubapp(editor);
    expect(store.runSubappAction).toHaveBeenCalledOnceWith('uninstall', editor);
  });

  it('blocks a forced retry if a project opens while the confirmation is pending', async () => {
    const store = createStore();
    store.projectService.currentProjectPath = '';
    store.subappManager.uninstall.and.rejectWith(new Error('busy'));
    store.isBusyForceRequiredError = () => true;
    store.confirmBusyForceClose = async () => {
      store.projectService.currentProjectPath = '/project';
      return true;
    };
    await expectAsync(store.runSubappMutationWithBusyRetry('uninstall', editor))
      .toBeRejectedWithError('APP_STORE.CODER_EDITOR_UNINSTALL_BLOCKED');
    expect(store.childToolProcess.forceStop).not.toHaveBeenCalled();
    expect(store.subappManager.uninstall).toHaveBeenCalledTimes(1);
  });
});
