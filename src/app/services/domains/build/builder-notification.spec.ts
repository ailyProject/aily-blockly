import { of, Subject } from 'rxjs';
import { BuilderService } from './builder.service';

describe('后台编译系统通知', () => {
  function harness({ coder = true, focused = false, result = { success: true, result: { state: 'done', text: 'compiled' } } as any, error = undefined as any } = {}) {
    const electron = { isWindowFocused: () => focused, notify: jasmine.createSpy('notify').and.resolveTo({ success: true }) };
    const action = { hasListener: () => false, dispatch() {}, dispatchWithFeedback: () => of({ success: true }) };
    const project = {
      currentProjectPath: coder ? '/coder' : '/blockly', coderProjects: [{ path: '/coder' }],
      isAilyCodeProject: () => coder, boardChangeSubject: new Subject<void>(), beginCoderOperation: () => () => {},
    };
    const compile = { runCompileFromDisk: jasmine.createSpy('compile').and.callFake(async () => { if (error) throw error; return result; }) };
    const service = new BuilderService(action as any, project as any, {} as any, {} as any, electron as any, compile as any);
    return { service, electron, compile };
  }

  it('真实 Coder 编译成功后发送一次系统通知', async () => {
    const { service, electron } = harness(); await service.build();
    expect(electron.notify).toHaveBeenCalledOnceWith('编译', 'compiled');
  });

  it('前台编译不发送系统通知', async () => {
    const { service, electron } = harness({ focused: true }); await service.build();
    expect(electron.notify).not.toHaveBeenCalled();
  });

  it('Coder 编译失败只发送一次且保留失败结果', async () => {
    const { service, electron } = harness({ result: { success: false, result: { state: 'error', text: 'compile failed' } } });
    await expectAsync(service.build()).toBeRejectedWithError('compile failed');
    expect(electron.notify).toHaveBeenCalledOnceWith('编译', 'compile failed');
  });

  it('编译进程抛异常时仍发送失败通知', async () => {
    const { service, electron } = harness({ error: new Error('compiler exited') });
    await expectAsync(service.build()).toBeRejectedWithError('compiler exited');
    expect(electron.notify).toHaveBeenCalledOnceWith('编译', 'compiler exited');
  });

  for (const success of [true, false]) {
    it(`预处理${success ? '成功' : '失败'}不发送编译完成通知`, async () => {
      const { service, electron } = harness({ result: { success, result: { state: success ? 'done' : 'error', text: 'preprocess' } } });
      await service.build('/coder', { preprocessOnly: true }).catch(() => undefined);
      expect(electron.notify).not.toHaveBeenCalled();
    });
  }

  it('取消编译不发送失败通知', async () => {
    const { service, electron } = harness({ result: { success: false, result: { state: 'warn', text: 'cancelled', code: 'BUILD_CANCELLED', buildOutcome: 'cancelled' } } });
    await service.build().catch(() => undefined);
    expect(electron.notify).not.toHaveBeenCalled();
  });

  it('未启动的编译不发送完成通知', async () => {
    const { service, electron } = harness({ error: Object.assign(new Error('busy'), { buildOutcome: 'not-started' }) });
    await service.build().catch(() => undefined);
    expect(electron.notify).not.toHaveBeenCalled();
  });

  it('Blockly 编译失败只发送一条系统通知', async () => {
    const { service, electron } = harness({ coder: false, result: { success: false, result: { state: 'error', text: 'Blockly failed' } } });
    await expectAsync(service.build()).toBeRejectedWithError('Blockly failed');
    expect(electron.notify).toHaveBeenCalledOnceWith('编译', 'Blockly failed');
  });
});
