import { UpdateService } from './update.service';
import { Subject } from 'rxjs';

function createService(options: {
  childPreparation?: { ok: boolean; results: Array<Record<string, unknown>> };
  projectSave?: { success: boolean; error?: string };
  projectPath?: string;
  activeChildAppIds?: string[];
  confirmInterruption?: boolean;
} = {}) {
  const order: string[] = [];
  const project = {
    currentProjectPath: options.projectPath === undefined ? '/tmp/project' : options.projectPath,
    save: jasmine.createSpy('save').and.resolveTo(options.projectSave || { success: true }),
  };
  const config = { save: jasmine.createSpy('save').and.resolveTo(undefined) };
  const modalCloses: Subject<string>[] = [];
  const modal = {
    create: jasmine.createSpy('create').and.callFake(() => {
      const afterClose = new Subject<string>();
      modalCloses.push(afterClose);
      return { afterClose };
    }),
  };
  const childRegistry = {
    prepareAllForApplicationUpdate: jasmine.createSpy('prepareAllForApplicationUpdate').and.callFake(async () => {
      order.push('prepare-child-apps');
      return options.childPreparation || { ok: true, results: [] };
    }),
  };
  const preparationHooks = new Map<string, () => Promise<Record<string, unknown>> | Record<string, unknown>>();
  const childAppSafety = {
    collectActiveChildAppIds: jasmine.createSpy('collectActiveChildAppIds')
      .and.returnValue(options.activeChildAppIds || []),
    confirmInterruption: jasmine.createSpy('confirmInterruption').and.callFake(async () => {
      order.push('confirm-interruption');
      return options.confirmInterruption !== false;
    }),
    registerPreparationHook: jasmine.createSpy('registerPreparationHook').and.callFake(
      (id: string, hook: () => Promise<Record<string, unknown>> | Record<string, unknown>) => {
        preparationHooks.set(id, hook);
        return () => preparationHooks.delete(id);
      },
    ),
    prepareRegisteredWork: jasmine.createSpy('prepareRegisteredWork').and.callFake(async () => {
      order.push('prepare-registered-work');
      for (const hook of preparationHooks.values()) {
        const result = await hook();
        if (result?.['ok'] === false) throw new Error(String(result['message'] || 'preparation failed'));
      }
    }),
  };
  const message = { error: jasmine.createSpy('error') };
  const service = new UpdateService(
    { isElectron: false } as never,
    modal as never,
    config as never,
    project as never,
    { openWindowPathList: [] } as never,
    childRegistry as never,
    message as never,
    { instant: (key: string) => key } as never,
    childAppSafety as never,
  );
  spyOn(service, 'quitAndInstall');
  return {
    service,
    project,
    config,
    message,
    modal,
    modalCloses,
    childRegistry,
    childAppSafety,
    order,
  };
}

describe('UpdateService safe installation', () => {
  it('saves the project before starting installation', async () => {
    const { service, project, config } = createService();

    const result = await service.prepareAndInstall();

    expect(result).toBeTrue();
    expect(project.save).toHaveBeenCalledWith('/tmp/project', 15_000);
    expect(config.save).toHaveBeenCalled();
    expect(service.quitAndInstall).toHaveBeenCalled();
  });

  it('keeps the application open when a child session cannot be saved', async () => {
    const { service, project, message } = createService({
      childPreparation: {
        ok: false,
        results: [{ ok: false, message: 'session save failed' }],
      },
    });

    const result = await service.prepareAndInstall();

    expect(result).toBeFalse();
    expect(project.save).not.toHaveBeenCalled();
    expect(service.quitAndInstall).not.toHaveBeenCalled();
    expect(service.updateStatus.value).toBe('downloaded');
    expect(message.error).toHaveBeenCalled();
  });

  it('does not save a project when no project is open', async () => {
    const { service, project, config } = createService({ projectPath: '' });

    const result = await service.prepareAndInstall();

    expect(result).toBeTrue();
    expect(service.hasOpenProject).toBeFalse();
    expect(project.save).not.toHaveBeenCalled();
    expect(config.save).toHaveBeenCalled();
    expect(service.quitAndInstall).toHaveBeenCalled();
  });

  it('warns before preparing active child apps', async () => {
    const { service, childAppSafety, order } = createService({
      activeChildAppIds: ['aily-chat-react'],
    });

    const result = await service.prepareAndInstall();

    expect(result).toBeTrue();
    expect(childAppSafety.confirmInterruption).toHaveBeenCalledWith(
      'application-update',
      ['aily-chat-react'],
    );
    expect(order.slice(0, 2)).toEqual(['confirm-interruption', 'prepare-child-apps']);
  });

  it('runs registered host work preparation after child preparation and before project save', async () => {
    const { service, project, order } = createService();
    project.save.and.callFake(async () => {
      order.push('save-project');
      return { success: true };
    });
    service.registerInstallPreparationHook('host-chat', async () => {
      order.push('prepare-host-chat');
      return { ok: true };
    });

    expect(await service.prepareAndInstall()).toBeTrue();
    expect(order).toEqual([
      'prepare-child-apps',
      'prepare-registered-work',
      'prepare-host-chat',
      'save-project',
    ]);
  });

  it('does not prepare, save, or install when the child app warning is cancelled', async () => {
    const { service, project, config, childRegistry } = createService({
      activeChildAppIds: ['aily-chat-react'],
      confirmInterruption: false,
    });
    service.updateStatus.next('downloaded');

    const result = await service.prepareAndInstall();

    expect(result).toBeFalse();
    expect(childRegistry.prepareAllForApplicationUpdate).not.toHaveBeenCalled();
    expect(project.save).not.toHaveBeenCalled();
    expect(config.save).not.toHaveBeenCalled();
    expect(service.quitAndInstall).not.toHaveBeenCalled();
    expect(service.updateStatus.value).toBe('downloaded');
  });

  it('reopens a minimized update dialog with the current background state', () => {
    const { service, modal, modalCloses } = createService();
    service.activeUpdateInfo.next({ version: '1.2.3' });
    service.updateStatus.next('downloading');
    service.updateProgress.next(46);

    service.openUpdateDialog();
    service.openUpdateDialog();

    expect(modal.create).toHaveBeenCalledTimes(1);
    expect(modal.create.calls.mostRecent().args[0].nzData).toEqual(jasmine.objectContaining({
      mode: 'downloading',
      version: '1.2.3',
    }));

    modalCloses[0].next('background');
    service.updateStatus.next('downloaded');
    service.openUpdateDialog();

    expect(modal.create).toHaveBeenCalledTimes(2);
    expect(modal.create.calls.mostRecent().args[0].nzData).toEqual(jasmine.objectContaining({
      mode: 'downloaded',
      version: '1.2.3',
    }));
  });

  it('simulates a downloaded update for local UI verification', () => {
    const { service, modal } = createService();

    service.simulateUpdate('downloaded', '9.9.9');

    expect(service.activeUpdateInfo.value?.version).toBe('9.9.9');
    expect(service.updateProgress.value).toBe(100);
    expect(service.updateStatus.value).toBe('downloaded');
    expect(modal.create).toHaveBeenCalled();
  });
});
