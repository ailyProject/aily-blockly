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
    expect(uploader.npmService.assertCoderDependenciesReady).toHaveBeenCalledOnceWith('/project');
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
