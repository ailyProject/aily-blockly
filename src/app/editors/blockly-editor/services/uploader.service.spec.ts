import { fakeAsync, flushMicrotasks, TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { _UploaderService } from './uploader.service';

describe('Uploader command lifecycle during project close', () => {
  let original: any;
  let service: any;
  let output: Subject<any>;

  beforeEach(() => {
    original = { path: window['path'], fs: window['fs'] };
    window['path'] = {
      join: (...parts: string[]) => parts.join('/'),
      basename: (path: string) => path.split('/').pop(),
      getAppDataPath: () => '/sdk',
      getAilyChildPath: () => '/child',
    };
    window['fs'] = {
      existsSync: () => true, mkdirSync() {}, copySync() {}, writeFileSync() {},
      statSync: () => ({ size: 123 }),
    };
    output = new Subject();
    TestBed.configureTestingModule({ providers: [
      { provide: TranslateService, useValue: { instant: (key: string) => key } },
    ] });
    service = TestBed.runInInjectionContext(() => Reflect.construct(_UploaderService, []));
    service.projectService = {
      beginBuildBackendOperation: () => ({ local: false, release() {} }),
      isCloudBuild: () => false, captureCurrentProjectGuard: () => () => true,
      currentProjectPath: '/project', isProjectTransitionInProgress: () => false,
      isAilyCodeProject: () => false, getBuildPath: async () => '/project/build',
      getBoardJson: async () => ({ name: 'board', uploadParam: 'flash' }),
      getBoardModule: async () => 'board', isCdcOnBootEnabledForProject: async () => false,
      getSoftdeviceHexPath: async () => '/sdk/softdevice.hex',
    };
    service.translate = { instant: (key: string) => key };
    service.serialService = { currentPort: 'COM1', currentPortInfo: { type: 'serial' } };
    service._builderService = { passed: true, lastCode: 'code', currentProjectPath: '/project',
      isPreprocessing: () => false, waitForUploadPreprocess: async () => {}, canReuseBuildForUpload: async () => true };
    service.blocklyService = { runWithPreparedProjectCode: async () => 'code' };
    service.workflowService = { startUpload: () => true, finishUpload: jasmine.createSpy('finishUpload') };
    service.noticeService = { update: jasmine.createSpy('notice') };
    service.logService = { update() {} };
    service.cmdService = {
      spawn: jasmine.createSpy('spawn').and.returnValue(output),
      run: jasmine.createSpy('run').and.returnValue(output),
      kill: jasmine.createSpy('kill').and.resolveTo(true),
    };
    service.uploaderBleService = { cancel() {}, findFirmwareFile: () => '/project/build/firmware.bin' };
    service.getNetworkOtaTarget = () => ({ host: '127.0.0.1', port: 80, username: '', password: '', uploadPath: '/' });
    service.appendUploadLog = () => {};
    service.logNetworkOtaUpload = () => {};
  });

  afterEach(() => Object.assign(window, original));

  function startProgressUpload() {
    const outcome = { result: null as any, rejected: false };
    service.upload().then(value => { outcome.result = value; }, error => {
      outcome.result = error;
      outcome.rejected = true;
    });
    flushMicrotasks();
    return {
      outcome,
      emit: (...lines: string[]) => output.next({ type: 'stdout', data: lines.join('\r\n') + '\r\n', streamId: 'local-upload' }),
      progress: () => service.noticeService.update.calls.allArgs()
        .map(args => args[0].progress).filter(value => value !== undefined).pop(),
    };
  }

  it('tracks interleaved esptool v5 files without completing on the small boot files', fakeAsync(() => {
    const f = startProgressUpload();
    f.emit('Executing: esptool write-flash -z 0x0 "sketch.bootloader.bin" 0x8000 "sketch.partitions.bin" 0xe000 "boot_app0.bin" 0x10000 "sketch.bin"',
      "Writing 'sketch.bootloader.bin' at 0x00000000...",
      'Flash will be erased from 0x00000000 to 0x00004fff...',
      'Compressed 19984 bytes to 13015...',
      'Writing at 0x00004e10 [==============================] 100.0% 13015/13015 bytes...',
      'Hash of data verified.');
    expect(f.progress()).toBeLessThan(100);
    expect(service.uploadCompleted).toBeFalse();

    f.emit("Writing 'sketch.partitions.bin' at 0x00008000...",
      'Flash will be erased from 0x00008000 to 0x00008fff...',
      'Compressed 3072 bytes to 129...',
      'Writing at 0x00008c00 [==============================] 100.0% 129/129 bytes...',
      'Hash of data verified.',
      "Writing 'boot_app0.bin' at 0x0000e000...",
      'Flash will be erased from 0x0000e000 to 0x0000ffff...',
      'Compressed 8192 bytes to 47...',
      'Writing at 0x00010000 [==============================] 100.0% 47/47 bytes...',
      'Hash of data verified.',
      "Writing 'sketch.bin' at 0x00010000...",
      'Flash will be erased from 0x00010000 to 0x0044cfff...',
      'Compressed 4440768 bytes to 2927671...');
    let previous = f.progress();
    for (const percent of [25, 50, 99]) {
      f.emit(`Writing at 0x00200000 [==============>               ] ${percent}.0% ${Math.floor(2927671 * percent / 100)}/2927671 bytes...`);
      expect(f.progress()).toBeGreaterThan(previous);
      expect(f.progress()).toBeLessThan(100);
      previous = f.progress();
    }
    f.emit('Writing at 0x0044c2c0 [==============================] 100.0% 2927671/2927671 bytes...');
    expect(f.progress()).toBeLessThan(100);
    f.emit('Hash of data verified.', 'Hard resetting via RTS pin...');
    expect(f.progress()).toBe(100);
    output.next({ type: 'close', code: 0, streamId: 'local-upload' });
    output.complete(); flushMicrotasks();
    expect(f.outcome.rejected).toBeFalse();
    expect(f.outcome.result.state).toBe('done');
  }));

  it('keeps byte weighting for legacy esptool ranges announced before compression', fakeAsync(() => {
    const f = startProgressUpload();
    f.emit('Executing: esptool write_flash -z 0x0 "bootloader.bin" 0x1000 "sketch.bin"',
      'Flash will be erased from 0x00000000 to 0x00000fff...',
      'Flash will be erased from 0x00001000 to 0x00009fff...',
      'Compressed 4096 bytes to 1024...',
      'Writing at 0x00001000 [==============================] 100.0% 1024/1024 bytes...',
      'Hash of data verified.');
    expect(f.progress()).toBe(10);
    f.emit('Compressed 36864 bytes to 18432...',
      'Writing at 0x00005000 [==============>               ] 50.0% 9216/18432 bytes...');
    expect(f.progress()).toBe(55);
    f.emit('Writing at 0x0000a000 [==============================] 100.0% 18432/18432 bytes...',
      'Hash of data verified.');
    expect(f.progress()).toBe(100);
    output.next({ type: 'close', code: 0, streamId: 'local-upload' });
    output.complete(); flushMicrotasks();
    expect(f.outcome.result.state).toBe('done');
  }));

  it('tracks uncompressed esptool files started by filename headers', fakeAsync(() => {
    const f = startProgressUpload();
    f.emit('Executing: esptool write-flash 0x0 "bootloader.bin" 0x1000 "sketch.bin"',
      "Writing 'bootloader.bin' at 0x00000000...",
      'Flash will be erased from 0x00000000 to 0x00000fff...',
      'Writing at 0x00001000 [==============================] 100.0% 4096/4096 bytes...',
      "'bootloader.bin' at 0x00000000 verified.");
    const firstFileProgress = f.progress();
    expect(firstFileProgress).toBeLessThan(100);
    f.emit("Writing 'sketch.bin' at 0x00001000...",
      'Flash will be erased from 0x00001000 to 0x00009fff...',
      'Writing at 0x00005000 [==============>               ] 50.0% 18432/36864 bytes...');
    expect(f.progress()).toBeGreaterThan(firstFileProgress);
    f.emit("'sketch.bin' at 0x00001000 verified.");
    output.next({ type: 'close', code: 0, streamId: 'local-upload' });
    output.complete(); flushMicrotasks();
    expect(f.outcome.result.state).toBe('done');
  }));

  it('rejects a failed process even after esptool reports 100 percent written', fakeAsync(() => {
    const f = startProgressUpload();
    f.emit('Executing: esptool write-flash -z 0x10000 "sketch.bin"',
      'Flash will be erased from 0x00010000 to 0x00019fff...',
      'Compressed 40960 bytes to 20480...',
      'Writing at 0x0001a000 [==============================] 100.0% 20480/20480 bytes...');
    output.next({ type: 'close', code: 2, streamId: 'local-upload' });
    output.complete(); flushMicrotasks();
    expect(f.outcome.rejected).toBeTrue();
    expect(f.outcome.result.state).toBe('error');
    expect(service.workflowService.finishUpload).toHaveBeenCalledWith(false, jasmine.any(String));
  }));

  it('stops the local upload process after its cloud prerequisite was switched to local', fakeAsync(() => {
    const operation = { local: false, release: jasmine.createSpy('release') };
    Object.assign(service.projectService, {
      beginBuildBackendOperation: () => operation, isCloudBuild: () => !operation.local,
      getProjectDependencySession: () => ({}), assertProjectDependencySession() {},
    });
    service._builderService.canReuseBuildForUpload = async () => operation.local;
    service._builderService.build = async () => { operation.local = true; return { state: 'done' }; };
    service._builderService.cancel = jasmine.createSpy('cancelBuild');
    let result: any;
    service.upload().then(value => { result = value; }, error => { result = error; });
    flushMicrotasks();
    expect(service.cmdService.spawn).toHaveBeenCalledTimes(1);
    expect(service.cloudUploadInProgress).toBeFalse();
    output.next({ type: 'stdout', data: 'writing firmware', streamId: 'local-upload' });
    service.cancel(); flushMicrotasks();
    expect(service.cmdService.kill).toHaveBeenCalledWith('local-upload');
    expect(result.state).toBe('warn');
    expect(operation.release).toHaveBeenCalledTimes(1);
    expect(service.uploadInProgress).toBeFalse();
  }));

  for (const mode of ['serial', 'network-ota', 'softdevice']) {
    function start(): Promise<any> {
      if (mode === 'serial') return service.upload();
      if (mode === 'network-ota') return service.uploadByNetworkOta('/project/build', {});
      return service.flashSoftdevice('s110', 'COM1');
    }

    it(`${mode} starts the command in its project and reports completion`, fakeAsync(() => {
      let result: any;
      start().then(value => { result = value; });
      flushMicrotasks();
      if (mode === 'serial') {
        expect(service.cmdService.spawn).toHaveBeenCalledOnceWith('node', jasmine.any(Array),
          { shellProfile: false, cwd: '/project' }, false);
      } else {
        expect(service.cmdService.run).toHaveBeenCalledOnceWith(jasmine.any(String), '/project', false, false);
      }
      output.complete();
      flushMicrotasks();
      expect(mode === 'softdevice' ? result.success : result.state === 'done').toBeTrue();
    }));

    it(`${mode} does not spawn when its project starts closing during preparation`, fakeAsync(() => {
      let result: any;
      start().then(value => { result = value; }, error => { result = error; });
      service.projectService.isProjectTransitionInProgress = () => true;
      flushMicrotasks();
      expect(service.cmdService.spawn).not.toHaveBeenCalled();
      expect(service.cmdService.run).not.toHaveBeenCalled();
      expect(mode === 'softdevice' ? result.success : result.state === 'done').toBeFalse();
      expect(mode === 'softdevice' ? result.message : result.text).toContain('project is closing');
      if (mode !== 'softdevice') {
        expect(service.uploadInProgress).toBeFalse();
        expect(service._builderService.isUploading).toBeFalse();
        expect(service.workflowService.finishUpload).toHaveBeenCalledWith(false, jasmine.any(String));
      }
    }));
  }
});
