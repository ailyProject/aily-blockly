import { HeaderComponent } from './header.component';

describe('Header compile readiness', () => {
  let header: any;

  beforeEach(() => {
    header = Object.create(HeaderComponent.prototype);
    header.projectService = {
      currentProjectPath: '/projects/current',
      isProjectOpening: true,
      getProjectMode: jasmine.createSpy('mode').and.returnValue('blockly'),
      getProjectDependencyBlockMessage: jasmine.createSpy('dependencyBlock').and.returnValue(undefined),
    };
    header.builderService = { build: jasmine.createSpy('build').and.resolveTo({ state: 'done' }) };
    header.translate = { instant: (key: string) => key };
    header.message = { info: jasmine.createSpy('info') };
    header.connectorState = { running: false };
    header.configService = { isCoderProduct: jasmine.createSpy('isCoderProduct').and.returnValue(false) };
  });

  it('does not dispatch while Blockly is loading and can compile once loading finishes', async () => {
    const item = { action: 'compile', state: 'default' };
    await header.process(item, null, 'manual');
    expect(header.builderService.build).not.toHaveBeenCalled();
    expect(item.state).toBe('default');
    expect(header.message.info).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_LOADING');

    header.projectService.isProjectOpening = false;
    await header.process(item, null, 'manual');
    expect(header.builderService.build).toHaveBeenCalledOnceWith(undefined, { source: 'manual' });
    expect(item.state).toBe('done');
  });

  it('keeps duplicate clicks blocked while a build is pending', async () => {
    header.projectService.isProjectOpening = false;
    let finish!: (result: { state: string }) => void;
    const build = new Promise(resolve => { finish = resolve; });
    header.builderService.build.and.returnValue(build);
    const item = { action: 'compile', state: 'default' };
    await header.process(item);
    await header.process(item);
    expect(item.state).toBe('doing');
    expect(header.builderService.build).toHaveBeenCalledTimes(1);
    finish({ state: 'done' });
    await build;
    expect(item.state).toBe('done');
  });

  it('preserves the Coder build path during project activation', async () => {
    header.projectService.getProjectMode.and.returnValue('coder');
    await header.process({ action: 'compile', state: 'default' });
    expect(header.builderService.build).toHaveBeenCalledTimes(1);
    expect(header.message.info).not.toHaveBeenCalled();
  });

  for (const action of ['compile', 'play', 'upload']) {
    it(`blocks ${action} during dependency installation and after failure`, async () => {
      header.configService.isCoderProduct.and.returnValue(true);
      header.projectService.getProjectMode.and.returnValue('coder');
      const item = { action, state: 'default' };
      for (const reason of ['installing', 'retry required']) {
        header.projectService.getProjectDependencyBlockMessage.and.returnValue(reason);
        await header.process(item);
        expect(header.message.info).toHaveBeenCalledWith(reason);
        expect(header.builderService.build).not.toHaveBeenCalled();
        expect(item.state).toBe('default');
      }
    });
  }

  it('does not apply Coder dependency blocking to Blockly software even when opening a Coder project', async () => {
    header.projectService.getProjectMode.and.returnValue('coder');
    header.projectService.getProjectDependencyBlockMessage.and.returnValue('retry required');
    for (const action of ['compile', 'play', 'upload']) {
      expect(header.dependencyBlockMessage({ action })).toBeUndefined();
    }
    await header.process({ action: 'compile', state: 'default' });
    expect(header.projectService.getProjectDependencyBlockMessage).not.toHaveBeenCalled();
    expect(header.builderService.build).toHaveBeenCalledTimes(1);
    expect(header.message.info).not.toHaveBeenCalled();
  });

  it('keeps the stop action available during dependency repair', () => {
    header.configService.isCoderProduct.and.returnValue(true);
    header.connectorState.running = true;
    header.projectService.getProjectDependencyBlockMessage.and.returnValue('installing');
    expect(header.dependencyBlockMessage({ action: 'play', state: 'running' })).toBeUndefined();
    expect(header.dependencyBlockMessage({ action: 'upload', state: 'running' })).toBeUndefined();
  });
});
