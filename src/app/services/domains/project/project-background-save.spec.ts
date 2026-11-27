import { BehaviorSubject } from 'rxjs';
import { ProjectService } from './project.service';

describe('background project save presentation', () => {
  function fixture() {
    const service: any = Object.create(ProjectService.prototype);
    service.currentProjectPathSubject = new BehaviorSubject('/project');
    service.stateSubject = new BehaviorSubject('loaded');
    service.getProjectMode = () => 'coder';
    service.saveContext = () => [];
    service.prepareResolvedLibraryChangesForSave = async () => false;
    service.getPackageJson = async () => ({ name: 'saved-project' });
    const dispatch = jasmine.createSpy('dispatch').and.resolveTo({ success: true });
    Object.defineProperty(service, 'dependencyLifecycle', { value: { get: () => undefined } });
    Object.defineProperty(service, 'application', { value: { dispatchProjectSave: dispatch } });
    Object.defineProperty(service, 'projectSaveReceipts', { value: {
      execute: async (_path: string, _request: unknown, _context: unknown, run: () => Promise<unknown>) => ({ result: await run() }),
    } });
    const states: string[] = [];
    service.stateSubject.subscribe((state: string) => states.push(state));
    return { service, dispatch, states };
  }

  it('awaits the real asynchronous publication without foreground saving/saved messages', async () => {
    const h = fixture(); let finish!: (result: unknown) => void;
    h.dispatch.and.returnValue(new Promise(resolve => { finish = resolve; }));
    const saving = h.service.saveInBackground('/project');
    await Promise.resolve(); await Promise.resolve();
    expect(h.dispatch).toHaveBeenCalledOnceWith('/project', 0, undefined, true); expect(h.states).toEqual(['loaded']);
    finish({ success: true }); expect((await saving).success).toBeTrue();
    expect(h.service.currentPackageData.name).toBe('saved-project'); expect(h.states).toEqual(['loaded']);
  });

  it('returns background failures without switching the foreground project into an error state', async () => {
    const h = fixture(); h.dispatch.and.resolveTo({ success: false, error: 'disk full' });
    const result = await h.service.saveInBackground('/project');
    expect(result.success).toBeFalse(); expect(result.error).toBe('disk full'); expect(h.states).toEqual(['loaded']);
  });

  it('keeps manual save progress and success feedback', async () => {
    const h = fixture(); expect((await h.service.save('/project')).success).toBeTrue();
    expect(h.states).toEqual(['loaded', 'saving', 'saved']);
  });

  it('refuses to start either save when the original project directory has been replaced', async () => {
    const h = fixture(), originalFs = window['fs'];
    const attachment = (ino: string) => ({
      version: 1, root: '/project', identity: { dev: '1', ino, birthtimeNs: '10' },
    });
    h.service.activeProjectDirectory = attachment('10');
    h.service.translate = { instant: () => '工程目录已被替换' };
    try {
      window['fs'] = { captureProjectAttachment: () => attachment('11') };
      for (const result of [await h.service.save(), await h.service.saveInBackground()]) {
        expect(result).toEqual(jasmine.objectContaining({
          success: false, path: '/project', code: 'PROJECT_VIEW_ATTACHMENT_CHANGED', error: '工程目录已被替换',
        }));
      }
      expect(h.dispatch).not.toHaveBeenCalled();
      window['fs'] = { captureProjectAttachment: () => attachment('10') };
      expect((await h.service.save()).success).toBeTrue();
      expect(h.dispatch).toHaveBeenCalledTimes(1);
    } finally { window['fs'] = originalFs; }
  });
});
