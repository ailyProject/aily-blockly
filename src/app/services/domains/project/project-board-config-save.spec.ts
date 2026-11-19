import { ProjectService } from './project.service';

describe('Blockly board configuration save ordering', () => {
  const project = '/projects/board-config';
  const boardPath = `${project}/node_modules/@aily-project/board-test/board.json`;
  const update = { digital: ['GPIO17'] };
  let previousFs: any, service: any, write: jasmine.Spy, events: string[];
  let stored: string;

  beforeEach(() => {
    previousFs = window['fs'];
    events = [];
    stored = JSON.stringify({ type: 'test', digital: ['GPIO1'], analog: ['A0'] });
    write = jasmine.createSpy('write board').and.callFake((path: string, content: string) => {
      expect(path).toBe(boardPath); events.push('write'); stored = content;
    });
    window['fs'] = { existsSync: (path: string) => path === boardPath, writeFileSync: write };
    service = {
      currentProjectPath: project, isCoderProjectContext: false,
      getBoardModule: jasmine.createSpy('board module').and.resolveTo('@aily-project/board-test'),
      save: jasmine.createSpy('save').and.callFake(async () => { events.push('saved'); return { success: true }; }),
      projectOpen: jasmine.createSpy('open').and.callFake(async () => { events.push('open'); return true; }),
      electronService: { readFile: jasmine.createSpy('read board').and.callFake(() => stored) },
      translate: { instant: (key: string) => key },
      message: {
        loading: jasmine.createSpy('loading').and.callFake(() => events.push('loading')),
        success: jasmine.createSpy('success').and.callFake(() => events.push('success')),
      },
      boardChangeSubject: { next: jasmine.createSpy('board changed').and.callFake(() => events.push('notify')) },
      application: { updateFooterState: jasmine.createSpy('footer').and.callFake(() => events.push('footer')) },
      syncCurrentBoardConfig: jasmine.createSpy('sync config').and.callFake(async () => { events.push('sync'); return true; }),
    };
  });

  afterEach(() => { window['fs'] = previousFs; });

  const change = (target: any) => ProjectService.prototype.setBoardJson.call(target, update);
  const expectNoCompletion = () => {
    expect(service.boardChangeSubject.next).not.toHaveBeenCalled();
    expect(service.application.updateFooterState).not.toHaveBeenCalled();
    expect(service.message.success).not.toHaveBeenCalled();
  };

  it('waits for the original save receipt before writing the board or opening the project', async () => {
    let finish!: (value: { success: boolean }) => void;
    const saved = new Promise<{ success: boolean }>(resolve => finish = resolve);
    service.save.and.callFake(() => { events.push('save-start'); return saved.then(result => { events.push('saved'); return result; }); });
    const pending = change(service);
    await Promise.resolve(); await Promise.resolve();
    expect(events).toEqual(['save-start']);
    expect(write).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expectNoCompletion();
    finish({ success: true });
    await pending;
    expect(events).toEqual(['save-start', 'saved', 'loading', 'write', 'open', 'notify', 'footer', 'success']);
  });

  it('keeps board files and the current view unchanged when saving is rejected', async () => {
    service.save.and.resolveTo({ success: false, error: 'Original save still conflicts' });
    await expectAsync(change(service)).toBeRejectedWithError(/Original save still conflicts/);
    expect(write).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(service.message.loading).not.toHaveBeenCalled();
    expectNoCompletion();
    expect(JSON.parse(stored).digital).toEqual(['GPIO1']);
  });

  it('rejects an unconfirmed save even when its receipt has no error text', async () => {
    service.save.and.resolveTo({ success: false });
    await expectAsync(change(service)).toBeRejectedWithError(/未确认保存完成/);
    expect(write).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expectNoCompletion();
  });

  it('retains the original unknown save receipt and code without reloading or replaying it', async () => {
    const saveReceipt = { version: 1, requestId: 'original-ui-save', project,
      operation: 'project_save', state: 'unknown' };
    service.save.and.resolveTo({ success: false, code: 'PROJECT_SAVE_RECEIPT_UNKNOWN', saveReceipt,
      error: 'Observe the original save request' });
    await expectAsync(change(service)).toBeRejectedWith(jasmine.objectContaining({
      code: 'PROJECT_SAVE_RECEIPT_UNKNOWN', saveReceipt,
    }));
    expect(service.save).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expectNoCompletion();
  });

  it('does not report completion when reopening returns false after the board write', async () => {
    service.projectOpen.and.resolveTo(false);
    await expectAsync(change(service)).toBeRejectedWithError(/项目重新加载失败/);
    expect(write).toHaveBeenCalledTimes(1);
    expect(service.projectOpen).toHaveBeenCalledOnceWith(project);
    expectNoCompletion();
  });

  it('propagates a failed reopening without publishing a success notification', async () => {
    service.projectOpen.and.rejectWith(new Error('Native reload failed'));
    await expectAsync(change(service)).toBeRejectedWithError('Native reload failed');
    expect(write).toHaveBeenCalledTimes(1);
    expectNoCompletion();
  });

  it('rejects a selection change during the original save before changing either board', async () => {
    service.save.and.callFake(async () => { service.currentProjectPath = '/projects/replacement'; return { success: true }; });
    await expectAsync(change(service)).toBeRejectedWithError(/当前项目已切换/);
    expect(write).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expectNoCompletion();
  });

  it('merges board data and announces completion only after saving and reopening succeed', async () => {
    await change(service);
    expect(service.save).toHaveBeenCalledOnceWith(project);
    expect(service.projectOpen).toHaveBeenCalledOnceWith(project);
    expect(JSON.parse(stored)).toEqual({ type: 'test', digital: ['GPIO17'], analog: ['A0'] });
    expect(events).toEqual(['saved', 'loading', 'write', 'open', 'notify', 'footer', 'success']);
    expect(service.syncCurrentBoardConfig).not.toHaveBeenCalled();
  });

  it('retains the Coder in-place pin update without invoking Blockly save or reopen', async () => {
    service.isCoderProjectContext = true;
    await change(service);
    expect(service.save).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(service.syncCurrentBoardConfig).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored)).toEqual({ type: 'test', digital: ['GPIO17'], analog: ['A0'] });
    expect(events).toEqual(['write', 'sync', 'notify']);
    expect(service.application.updateFooterState).not.toHaveBeenCalled();
    expect(service.message.loading).not.toHaveBeenCalled();
    expect(service.message.success).not.toHaveBeenCalled();
  });
});
