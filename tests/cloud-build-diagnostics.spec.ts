import { runCloudBuildWithProgress } from '../src/app/utils/cloud-build-progress.utils';
import { _BuilderService } from '../src/app/editors/blockly-editor/services/builder.service';
import { CompileService } from '../src/app/services/domains/build/compile.service';
import { NoticeService } from '../src/app/services/core/app-shell/notice.service';
import { runProjectBuild } from '../src/app/integrations/blockly/project-build-operation';
import { BlocklyLiveOperationBridgeService } from '../src/app/services/integrations/automation/blockly-live-operation-bridge.service';

const diagnostic = "src/main.cpp:4:3: error: 'missing_symbol' was not declared in this scope\n    4 | missing_symbol();\n      | ^~~~~~~~~~~~~~\nnote: suggested alternative: known_symbol";

describe('cloud compiler diagnostic handoff', () => {

  for (const editor of ['Blockly', 'Coder']) it(editor + ' keeps streamed stdout neutral and logs only the final error summary', async () => {
    const summary = 'This SDK version has no reviewed Windows upload resource policy.';
    const stdout = 'Ninja build completed successfully\n' + 'compiler command succeeded\n'.repeat(500) + '[SUCCESS] Compilation successful!';
    const entries: any[] = [], notices: any[] = [];
    const logService = { update: (entry: any) => entries.push(entry) };
    const noticeService = new NoticeService(logService as any);
    noticeService.stateSubject.subscribe(notice => notices.push(notice));
    const service: any = Object.create(editor === 'Blockly' ? _BuilderService.prototype : CompileService.prototype);
    Object.assign(service, { logService, noticeService, application: { updateNotice: (notice: any) => noticeService.update(notice) },
      buildStartTime: Date.now(), t: (key: string) => key, messageWithDuration: (text: string) => text });
    let listener: any, failure: any;
    try {
      await runCloudBuildWithProgress({ requestId: 'summary' }, {
        onProgress: callback => { listener = callback; return () => {}; }, cancel: () => {},
        run: async () => { listener({ requestId: 'summary', stream: 'stdout', log: stdout }); throw new Error(summary); },
      }, { isCurrent: () => true, log: (text, stream) => logService.update({ detail: text, state: stream === 'stderr' ? 'error' : 'doing' }), progress: () => {} });
      fail('expected cloud failure');
    } catch (error) { failure = error; }
    const oldPath = (window as any).path, oldFs = (window as any).fs;
    // This test exercises notice/log presentation; it must not write project files.
    try {
      (window as any).path = undefined; (window as any).fs = undefined;
      if (editor === 'Blockly') service.handleCompileError(failure.message, true, failure.fullStdErr, undefined, true);
      else service.handleFailNotice('/project', 'FAILED_TITLE', failure.message, failure.fullStdErr, undefined, true);
    } finally { (window as any).path = oldPath; (window as any).fs = oldFs; }
    expect(failure.fullStdErr).toBe(stdout + '\n' + summary);
    expect(notices[0].detail).toBe(failure.fullStdErr);
    expect(notices[0].sendToLog).toBeFalse();
    expect(entries.filter(entry => entry.state === 'error').map(entry => entry.detail)).toEqual([summary]);
    expect(entries.filter(entry => entry.state !== 'error').map(entry => entry.detail)).toEqual([stdout]);
    expect(entries.filter(entry => entry.detail.includes('[SUCCESS]')).length).toBe(1);
  });

  it('retains stdout and buffered stderr on rejection, scoped to this request', async () => {
    let listener: any;
    const logs: string[] = [];
    let current = true;
    const unsubscribe = jasmine.createSpy('unsubscribe');
    const bridge = {
      onProgress: (callback: any) => { listener = callback; return unsubscribe; },
      cancel: () => {},
      run: async () => {
        listener({ requestId: 'build', stage: 'compiling', progress: 50 });
        listener({ requestId: 'other', log: 'unrelated error' });
        listener({ requestId: 'build', stream: 'stdout', log: diagnostic });
        listener({ requestId: 'build', stream: 'stderr', log: 'collect2: error: ld returned 1 exit status' });
        current = false;
        listener({ requestId: 'build', log: 'late event after invalidation' });
        current = true;
        throw { name: 'Error', code: 'COMPILE_ERROR', message: 'Compiler exited with code 1' };
      },
    };
    try {
      await runCloudBuildWithProgress({ requestId: 'build' }, bridge, {
        isCurrent: () => current, log: text => logs.push(text), progress: () => {},
      });
      fail('expected compilation failure');
    } catch (error: any) {
      expect(error.message).toBe('Compiler exited with code 1');
      expect(error.code).toBe('COMPILE_ERROR');
      expect(error.fullStdErr).toBe(`${diagnostic}\ncollect2: error: ld returned 1 exit status\nCompiler exited with code 1`);
      expect(logs.join('\n')).toBe(`${diagnostic}\ncollect2: error: ld returned 1 exit status`);
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('retains diagnostics for explicit failure results and does not reuse a previous run', async () => {
    let listener: any;
    let calls = 0;
    const bridge = {
      onProgress: (callback: any) => { listener = callback; return () => {}; }, cancel: () => {},
      run: async () => {
        if (++calls === 1) listener({ requestId: 'build', log: diagnostic });
        return { success: false, text: calls === 1 ? 'Compiler failed' : 'Gateway unavailable' };
      },
    };
    const callbacks = { isCurrent: () => true, log: () => {}, progress: () => {} };
    for (let call = 1; call <= 2; call++) {
      try {
        await runCloudBuildWithProgress({ requestId: 'build' }, bridge, callbacks);
        fail('expected failure');
      } catch (error: any) {
        expect(error.fullStdErr).toBe(call === 1 ? `${diagnostic}\nCompiler failed` : 'Gateway unavailable');
      }
    }
  });

  it('keeps Blockly compiler output beyond the UI summary limit for the AI bridge', async () => {
    const fullStdErr = `${'other.cpp:9:2: error: compiler context\n'.repeat(400)}${diagnostic}`;
    const buildResult = { state: 'error', text: 'Compiler exited with code 1', fullStdErr };
    const service = { build: async () => { throw Object.assign(new Error(buildResult.text), { buildResult }); } };
    const result = await runProjectBuild(service as any, {}, '/project');
    expect(result.is_error).toBeTrue();
    expect(result.metadata?.['buildResult']).toEqual(buildResult);
    const summary = JSON.parse(result.content as string);
    expect(summary.errors).toContain('other.cpp:9:2: error:');
    expect(summary.errors.length).toBe(3000);
    expect(summary.errors).not.toContain('missing_symbol');
    const bridge = Object.create(BlocklyLiveOperationBridgeService.prototype) as any;
    bridge.projectService = { currentProjectPath: '/project', ensureBlocklyLibraryRuntimeReady: async () => {} };
    bridge.builderService = service;
    const response = await bridge.executeProjectBuild({});
    expect(response.ok).toBeFalse();
    expect(response.result.fullStdErr).toBe(fullStdErr);
  });
});
