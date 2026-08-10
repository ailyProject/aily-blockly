import { UpdateService } from './update.service';

function createService(options: {
  childPreparation?: { ok: boolean; results: Array<Record<string, unknown>> };
  projectSave?: { success: boolean; error?: string };
} = {}) {
  const project = {
    currentProjectPath: '/tmp/project',
    save: jasmine.createSpy('save').and.resolveTo(options.projectSave || { success: true }),
  };
  const config = { save: jasmine.createSpy('save').and.resolveTo(undefined) };
  const childRegistry = {
    prepareAllForApplicationUpdate: jasmine.createSpy('prepareAllForApplicationUpdate').and.resolveTo(
      options.childPreparation || { ok: true, results: [] },
    ),
  };
  const message = { error: jasmine.createSpy('error') };
  const service = new UpdateService(
    { isElectron: false } as never,
    {} as never,
    config as never,
    project as never,
    { openWindowPathList: [] } as never,
    childRegistry as never,
    message as never,
    { instant: (key: string) => key } as never,
  );
  spyOn(service, 'quitAndInstall');
  return { service, project, config, message };
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
});
