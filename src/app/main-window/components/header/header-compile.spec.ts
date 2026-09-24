import { HeaderComponent } from './header.component';

describe('Header compile readiness', () => {
  let header: any;

  beforeEach(() => {
    header = Object.create(HeaderComponent.prototype);
    header.projectService = {
      currentProjectPath: '/projects/current',
      isProjectOpening: true,
      getProjectMode: jasmine.createSpy('mode').and.returnValue('blockly'),
    };
    header.builderService = { build: jasmine.createSpy('build').and.resolveTo({ state: 'done' }) };
    header.translate = { instant: (key: string) => key };
    header.message = { info: jasmine.createSpy('info') };
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
});
