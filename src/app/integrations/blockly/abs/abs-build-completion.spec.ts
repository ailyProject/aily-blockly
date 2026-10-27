import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ActionService } from '@core/app-shell/public-api';
import { BuilderService } from '@domain/build/public-api';
import { BlocklyBuildAdapter } from '../../build/blockly-build.adapter';
import { runProjectBuild } from '../project-build-operation';

describe('active Blockly compilation completion', () => {
  function fixture() {
    const actions = new ActionService();
    let complete!: (value: any) => void;
    const completion = new Promise<any>(resolve => { complete = resolve; });
    const finish = jasmine.createSpy('operationFinished');
    const project: any = {
      currentProjectPath: '/isolated', boardChangeSubject: new Subject(),
      isAilyCodeProject: () => false,
      beginCoderOperation: () => finish,
    };
    const service: any = new BuilderService(actions, project, {} as any, {} as any,
      { isWindowFocused: () => true } as any, { runCompileFromDisk: jasmine.createSpy('diskBuild') } as any);
    const stop = actions.listen('compile-begin', () => completion, 'builder-compile-begin');
    service.blocklyBuild = { isAvailable: () => true, build: jasmine.createSpy('build').and.returnValue(completion) };
    const events = jasmine.createSpy('finishedEvent'); service.buildFinishedSubject.subscribe(events);
    return { service, actions, complete, finish, events, stop };
  }

  for (const success of [true, false]) it(`does not publish a false terminal event at the old ten-minute deadline (success=${success})`, fakeAsync(() => {
    const f = fixture(), resolved = jasmine.createSpy('resolved'), rejected = jasmine.createSpy('rejected');
    f.service.build().then(resolved, rejected); flushMicrotasks();
    tick(600001); flushMicrotasks();
    expect(resolved).not.toHaveBeenCalled(); expect(rejected).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled(); expect(f.events).not.toHaveBeenCalled();
    const result = { state: success ? 'done' : 'error', text: success ? 'compiled' : 'compiler failed', fullStdErr: success ? '' : 'actual diagnostic' };
    f.complete({ success, result, checkpoint: {} }); flushMicrotasks();
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.service.blocklyBuild.build).toHaveBeenCalledOnceWith(jasmine.objectContaining({ projectPath: '/isolated' }));
    expect(f.events).toHaveBeenCalledOnceWith(jasmine.objectContaining({ success, result }));
    if (success) expect(resolved).toHaveBeenCalledOnceWith(result);
    else expect(rejected).toHaveBeenCalledOnceWith(jasmine.objectContaining({ message: 'compiler failed', fullStdErr: 'actual diagnostic' }));
    f.stop();
  }));

  it('refuses a missing active executor instead of falling back to an expiring Action or disk build', async () => {
    const f = fixture(); f.service.blocklyBuild = undefined;
    await expectAsync(f.service.build()).toBeRejectedWithError('The active Blockly build executor is unavailable.');
    expect(f.service.compileService.runCompileFromDisk).not.toHaveBeenCalled(); f.stop();
  });

  it('distinguishes rejected editor admission from an actual compiler failure', async () => {
    const f = fixture();
    f.service.blocklyBuild.build.and.resolveTo({ success: false, result: { state: 'warn', text: 'busy' }, checkpoint: {} });
    await expectAsync(f.service.build()).toBeRejectedWith(jasmine.objectContaining({ buildOutcome: 'not-started', message: 'busy' }));
    f.stop();
  });
});

describe('Blockly build execution adapter', () => {
  function fixture() {
    const actions = new ActionService(), project: any = { currentProjectPath: '/isolated' };
    const editor = { build: jasmine.createSpy('editorBuild').and.callFake(async (_graph, _id, checkpoint) => {
      checkpoint.startedAt = 123;
      return { state: 'done', text: 'compiled' };
    }) };
    const injector = { get: jasmine.createSpy('get').and.returnValue(editor) };
    const adapter = new BlocklyBuildAdapter(actions, project, injector as any);
    return { adapter, actions, project, editor, injector };
  }

  it('does not instantiate an unmounted editor or compile a replacement project', async () => {
    const f = fixture();
    expect(f.adapter.isAvailable()).toBeFalse();
    await expectAsync(f.adapter.build({ projectPath: '/isolated' })).toBeRejectedWithError(/no longer active/);
    expect(f.injector.get).not.toHaveBeenCalled();
    const stop = f.actions.listen('compile-begin', () => undefined, 'builder-compile-begin');
    f.project.currentProjectPath = '/replacement';
    await expectAsync(f.adapter.build({ projectPath: '/isolated' })).toBeRejectedWithError(/no longer active/);
    expect(f.injector.get).not.toHaveBeenCalled(); stop();
  });

  for (const failure of [false, true]) it(`preserves the exact editor outcome, checkpoint and scoped request (failure=${failure})`, async () => {
    const f = fixture(), stop = f.actions.listen('compile-begin', () => undefined, 'builder-compile-begin');
    const result = { state: failure ? 'error' : 'done', text: 'actual outcome', fullStdErr: 'actual diagnostics' };
    f.editor.build.and.callFake(async (graph, id, checkpoint) => {
      expect(graph).toBe('a'.repeat(64)); expect(id).toBe('owned-request');
      checkpoint.startedAt = 123; checkpoint.inputCapturedAt = 456;
      if (failure) throw result; return result;
    });
    const completed = await f.adapter.build({ projectPath: '/isolated', graphSemanticRevision: 'a'.repeat(64), requestId: 'owned-request' });
    expect(completed.success).toBe(!failure); expect(completed.result).toBe(result);
    expect(completed.checkpoint).toEqual({ startedAt: 123, inputCapturedAt: 456 }); stop();
  });
});

describe('build failure reporting', () => {
  for (const notStarted of [true, false]) it(`keeps admission rejection distinct from compiler failure (notStarted=${notStarted})`, async () => {
    const error = Object.assign(new Error('actual reason'), notStarted
      ? { buildOutcome: 'not-started' }
      : { buildResult: { state: 'error', text: 'actual reason', fullStdErr: 'main.cpp:1: error: invalid code' } });
    const builder = { build: jasmine.createSpy('build').and.rejectWith(error) };
    const result = await runProjectBuild(builder as any, {}, '/isolated');
    expect(result.is_error).toBeTrue();
    const content = JSON.parse(String(result.content));
    expect(content.message).toBe(`${notStarted ? '编译未开始' : '编译失败'}: actual reason`);
    if (notStarted) expect(result.metadata?.['buildOutcome']).toBe('not-started');
    else expect(content.errors).toContain('invalid code');
  });
});
