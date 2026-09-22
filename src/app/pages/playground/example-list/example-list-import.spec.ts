import { Subject } from 'rxjs';
import { ExampleListComponent } from './example-list.component';

describe('cloud example import coordination', () => {
  let component: any;
  let downloads: Subject<string>[];
  let fs: any;
  let previous: any;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  beforeEach(() => {
    previous = { fs: window['fs'], path: window['path'] };
    fs = { existsSync: () => true, mkdirSync: jasmine.createSpy('mkdir'), rmdirSync: jasmine.createSpy('delete') };
    window['fs'] = fs; window['path'] = { dirname: () => '/projects' };
    downloads = []; component = Object.create(ExampleListComponent.prototype);
    component.exampleLoadGeneration = 0; component.destroy$ = new Subject<void>();
    component.exampleList = [{ name: 'example', archive_url: 'first' }, { name: '../outside', archive_url: 'second' }];
    component.params = { id: 'before' };
    component.cloudService = { getProjectArchive: () => { const source = new Subject<string>(); downloads.push(source); return source; } };
    component.platformService = { getPlatformSeparator: () => '/' };
    component.electronService = { readFile: () => '{}', writeFile: jasmine.createSpy('metadata') };
    component.projectService = { projectRootPath: '/projects', importProjectDirectory: jasmine.createSpy('copy').and.callFake((_source, target) => target),
      initializeProjectDataSchema: jasmine.createSpy('initialize').and.resolveTo(), projectOpen: jasmine.createSpy('open').and.resolveTo(true) };
    component.messageService = { error: jasmine.createSpy('error') };
    spyOn(console, 'error'); spyOn(console, 'log');
  });
  afterEach(() => { component.destroy$.next(); component.destroy$.complete(); Object.assign(window, previous); });

  it('snapshots parameters and awaits the single normalization before opening', async () => {
    let resolve!: () => void;
    component.projectService.initializeProjectDataSchema.and.callFake(() => new Promise<void>(done => { resolve = done; }));
    component.loadExample(0); component.params.id = 'later'; downloads[0].next('/archive');
    await settle();
    expect(component.projectService.initializeProjectDataSchema.calls.mostRecent().args[2]).toEqual({ id: 'before' });
    expect(component.projectService.projectOpen).not.toHaveBeenCalled();
    expect(fs.rmdirSync).not.toHaveBeenCalled();
    resolve(); await settle();
    expect(component.projectService.projectOpen).toHaveBeenCalledTimes(1);
    expect(component.projectService.importProjectDirectory.calls.mostRecent().args[2]).toBeTrue();
  });
  it('does not open an uncommitted example after a normalization failure', async () => {
    component.projectService.initializeProjectDataSchema.and.rejectWith(new Error('publication conflict'));
    component.loadExample(0); downloads[0].next('/archive'); await settle();
    expect(component.projectService.projectOpen).not.toHaveBeenCalled();
    expect(component.messageService.error).toHaveBeenCalledWith(jasmine.stringMatching(/publication conflict/));
    expect(fs.rmdirSync).not.toHaveBeenCalled();
  });
  it('superseded imports cannot commit or open and old download errors do not reset the new loading state', async () => {
    let resolve!: () => void;
    component.projectService.initializeProjectDataSchema.and.callFake(() => new Promise<void>(done => { resolve = done; }));
    component.loadExample(0); downloads[0].next('/archive');
    const guard = component.projectService.initializeProjectDataSchema.calls.mostRecent().args[1];
    component.loadExample(1); expect(guard).toThrow(); resolve();
    downloads[0].error(new Error('old download')); await settle();
    expect(component.projectService.projectOpen).not.toHaveBeenCalled();
    expect(component.loadingExampleIndex).toBe(1); expect(component.messageService.error).not.toHaveBeenCalled();
  });
  it('archive names cannot escape the configured project directory', async () => {
    component.loadExample(1); downloads[0].next('/archive'); await settle();
    const target = component.projectService.importProjectDirectory.calls.mostRecent().args[1];
    expect(target).toMatch(/^\/projects\/[a-zA-Z0-9_-]+$/);
    expect(target).not.toContain('..');
  });
});
