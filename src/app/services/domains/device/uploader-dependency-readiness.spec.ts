import { fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { UploaderService } from './uploader.service';

describe('Coder upload dependency preflight', () => {
  let uploader: any;
  let finish: jasmine.Spy;

  beforeEach(() => {
    uploader = Object.create(UploaderService.prototype);
    finish = jasmine.createSpy('finishOperation');
    uploader.projectService = {
      currentProjectPath: '/project',
      isAilyCodeProject: () => true,
      beginCoderOperation: jasmine.createSpy('beginOperation').and.returnValue(finish),
      ensureCoderBoardSelected: jasmine.createSpy('selectBoard').and.resolveTo(true),
    };
    uploader.configService = { isCoderProduct: () => true };
    uploader.npmService = { assertCoderDependenciesReady: jasmine.createSpy('preflight').and.resolveTo() };
    // Everything past this boundary can release a port or invoke the shared flasher.
    uploader.uploadCurrentProject = jasmine.createSpy('upload').and.resolveTo({ state: 'done' });
  });

  it('waits for dependency checks before touching the port or dispatching upload', fakeAsync(() => {
    let checked!: () => void;
    uploader.npmService.assertCoderDependenciesReady.and.returnValue(new Promise<void>(resolve => { checked = resolve; }));
    const pending = uploader.upload();
    flushMicrotasks();
    expect(uploader.npmService.assertCoderDependenciesReady).toHaveBeenCalledOnceWith('/project', 'firmware-upload');
    expect(uploader.projectService.beginCoderOperation).not.toHaveBeenCalled();
    expect(uploader.uploadCurrentProject).not.toHaveBeenCalled();
    checked();
    let result: any;
    pending.then((value: any) => { result = value; });
    flushMicrotasks();
    expect(result).toEqual({ state: 'done' });
    expect(uploader.uploadCurrentProject).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  }));

  it('requests a board before dependency checks, dispatch or serial-port release', async () => {
    uploader.projectService.ensureCoderBoardSelected.and.resolveTo(false);
    uploader.coderExecution = { upload: jasmine.createSpy('runtimeUpload') };
    expect(await uploader.upload()).toEqual({ state: 'warn',
      text: '请先选择开发板，再编译或上传 Arduino 工程。', buildOutcome: 'not-started' });
    expect(uploader.projectService.ensureCoderBoardSelected).toHaveBeenCalledOnceWith('/project');
    expect(uploader.npmService.assertCoderDependenciesReady).not.toHaveBeenCalled();
    expect(uploader.projectService.beginCoderOperation).not.toHaveBeenCalled();
    expect(uploader.coderExecution.upload).not.toHaveBeenCalled();
    expect(uploader.uploadCurrentProject).not.toHaveBeenCalled();
  });

  it('blocks flashing on a failed disk check even when build artifacts already exist', async () => {
    uploader.npmService.assertCoderDependenciesReady.and.rejectWith(new Error('SDK incomplete'));
    await expectAsync(uploader.upload()).toBeRejectedWithError('SDK incomplete');
    expect(uploader.uploadCurrentProject).not.toHaveBeenCalled();
    expect(uploader.projectService.beginCoderOperation).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('presents upload preparation before releasing the serial port and waits for both before dispatch', async () => {
    const events: string[] = [];
    let painted!: () => void, disconnected!: () => void;
    uploader.isPythonProject = () => false;
    uploader.serialService = { currentPort: 'TEST', currentPortInfo: { type: 'serial' } };
    uploader.translate = { instant: (key: string) => key };
    uploader.application = {
      beginUploadPreparation: () => {
        events.push('notice');
        return { painted: new Promise<void>(resolve => { painted = resolve; }), close: () => events.push('retire') };
      },
      hasActionListener: () => false,
      uploadFromBlocklyEditor: async () => { events.push('flash'); return { state: 'done' }; },
    };
    uploader.metrics = { record() {} };
    uploader.electronService = { isWindowFocused: () => true };
    uploader.sendSerialResourceUploadSignal = async (signal: string) => {
      events.push(signal);
      if (signal === 'serial-monitor:disconnect') await new Promise<void>(resolve => { disconnected = resolve; });
    };
    const upload = UploaderService.prototype['uploadCurrentProject'].call(uploader, undefined, () => {});
    expect(events).toEqual(['notice', 'serial-monitor:disconnect']);
    disconnected();
    await Promise.resolve();
    expect(events).not.toContain('flash');
    painted();
    expect((await upload).state).toBe('done');
    expect(events).toEqual(['notice', 'serial-monitor:disconnect', 'flash', 'retire', 'serial-monitor:connect']);
  });

  it('also blocks SoftDevice flashing before releasing the serial port', async () => {
    uploader.npmService.assertCoderDependenciesReady.and.rejectWith(new Error('SDK incomplete'));
    uploader.sendSerialResourceUploadSignal = jasmine.createSpy('serialSignal');
    expect(await uploader.flashSoftdevice('s110', 'TEST-NO-DEVICE')).toEqual({ success: false, message: 'SDK incomplete' });
    expect(uploader.sendSerialResourceUploadSignal).not.toHaveBeenCalled();
  });

  it('preserves Blockly upload dispatch without invoking the Coder preflight', async () => {
    uploader.configService.isCoderProduct = () => false;
    uploader.npmService.assertCoderDependenciesReady.and.rejectWith(new Error('must not run'));
    expect(await uploader.upload()).toEqual({ state: 'done' });
    expect(uploader.npmService.assertCoderDependenciesReady).not.toHaveBeenCalled();
    expect(uploader.projectService.ensureCoderBoardSelected).not.toHaveBeenCalled();
    expect(uploader.uploadCurrentProject).toHaveBeenCalledTimes(1);
  });
});

describe('manual Blockly upload receipt', () => {
  let uploader: any;
  let bridge: any;
  const request = { version: 1, requestId: 'd839ad93-3b31-4701-a72f-87bc9e5e6d32' };

  beforeEach(() => {
    bridge = window['uploader'];
    uploader = Object.assign(Object.create(UploaderService.prototype), {
      projectService: {
        currentProjectPath: '/project',
        isAilyCodeProject: () => false,
        captureCurrentProjectGuard: () => () => true,
        beginCoderOperation: () => () => {},
      },
      serialService: { currentPort: 'TEST', currentPortInfo: { type: 'serial', serialNumber: 'original' } },
      translate: { instant: (key: string) => key },
      isPythonProject: () => false,
      configService: { isCoderProduct: () => false },
      uploadCurrentProject: jasmine.createSpy('upload').and.resolveTo({ state: 'done', firmwareBuildRequestId: 'build-5' }),
    });
  });

  afterEach(() => { window['uploader'] = bridge; });

  it('begins a receipt before dispatch and confirms exactly what the uploader returned', async () => {
    const stages: string[] = [];
    const manualReceipt = jasmine.createSpy('manual receipt').and.callFake(async (input: any) => {
      stages.push(input.action);
      return request;
    });
    uploader.uploadCurrentProject.and.callFake(async () => {
      stages.push('upload');
      return { state: 'done', firmwareBuildRequestId: 'build-5' };
    });
    window['uploader'] = { manualReceipt };
    await uploader.uploadManual();
    expect(manualReceipt.calls.first().args[0]).toEqual(jasmine.objectContaining({
      action: 'begin', project: '/project', device: jasmine.objectContaining({ name: 'TEST', serialNumber: 'original' }),
    }));
    expect(stages).toEqual(['begin', 'upload', 'finish']);
    expect(manualReceipt.calls.mostRecent().args[0]).toEqual({
      action: 'finish', project: '/project', request, result: { state: 'done', firmwareBuildRequestId: 'build-5' },
    });
  });

  it('does not dispatch when another device with the same port name replaces the selected board', async () => {
    const manualReceipt = jasmine.createSpy('manual receipt').and.callFake(async (input: any) => {
      if (input.action === 'begin') uploader.serialService.currentPortInfo = { type: 'serial', serialNumber: 'replacement' };
      return request;
    });
    window['uploader'] = { manualReceipt };
    await expectAsync(uploader.uploadManual()).toBeRejected();
    expect(uploader.uploadCurrentProject).not.toHaveBeenCalled();
    expect(manualReceipt.calls.mostRecent().args[0]).toEqual({
      action: 'finish', project: '/project', request, result: { state: 'error', notStarted: true },
    });
  });
});
