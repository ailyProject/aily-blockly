import { fakeAsync, flushMicrotasks } from '@angular/core/testing';
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
    service = Object.create(_UploaderService.prototype);
    service.projectService = {
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
    service.cmdService = {
      spawn: jasmine.createSpy('spawn').and.returnValue(output),
      run: jasmine.createSpy('run').and.returnValue(output),
      kill: jasmine.createSpy('kill').and.resolveTo(true),
    };
    service.uploaderBleService = { findFirmwareFile: () => '/project/build/firmware.bin' };
    service.getNetworkOtaTarget = () => ({ host: '127.0.0.1', port: 80, username: '', password: '', uploadPath: '/' });
    service.appendUploadLog = () => {};
    service.logNetworkOtaUpload = () => {};
  });

  afterEach(() => Object.assign(window, original));

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
