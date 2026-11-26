import { localCompileDiagnostic, localCompileErrorEvents } from '../../../../../tests/fixtures/local-compile-error-events';
import { fakeAsync, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { CmdService } from '@core/platform/public-api';
import { ProcessState, NoticeService } from '@core/app-shell/public-api';
import { sha256Hex } from '../../../utils/crypto.utils';
import { _BuilderService } from './builder.service';
import { _UploaderService } from './uploader.service';
import { canOfferLocalBuildFallback, CLOUD_BUILD_LOCAL_REQUESTED } from '../../../utils/cloud-build-progress.utils';
import { NpmService } from '../../../services/domains/dependencies/public-api';
import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { ProjectBuildReceipts } from '../../../services/integrations/automation/project-build-receipts';

describe('Blockly compile and upload handoff', () => {
  let originalFs: any, originalPath: any, originalBuilder: any, originalCmd: any, originalCloudBuild: any;
  beforeEach(() => {
    originalFs = window['fs']; originalPath = window['path']; originalBuilder = window['builder']; originalCmd = window['cmd'];
    originalCloudBuild = window['cloudBuild'];
  });
  afterEach(() => {
    window['fs'] = originalFs; window['path'] = originalPath; window['builder'] = originalBuilder; window['cmd'] = originalCmd;
    window['cloudBuild'] = originalCloudBuild;
  });

  function uploadFixture() {
    const events: string[] = [];
    const prepared = { revision: 1, code: 'compiled code', artifacts: [], projectMacros: [] };
    const project: any = { beginBuildBackendOperation: () => ({ local: false, release() {} }), isCloudBuild: () => false, captureCurrentProjectGuard: () => () => true,
      currentProjectPath: '/project', getBoardModule: async () => '@aily-project/board-test',
      getProjectDependencySession: (projectPath: string) => ({ projectPath, projectSessionId: 'build-upload-opening' }),
      isAilyCodeProject: () => false, getBoardJson: async () => ({}), getBuildPath: async () => '/project/.build' };
    const workflow: any = { currentState: ProcessState.IDLE,
      // Stop at the device boundary; these tests never flash hardware.
      startUpload: () => { events.push('upload'); return false; }, finishUpload() {} };
    const builder: any = Object.create(_BuilderService.prototype);
    Object.assign(builder, { projectService: project, passed: true, lastCode: prepared.code, currentProjectPath: '/project',
      preprocessRunGeneration: 0, workflowService: workflow,
      configService: { getCompileBackend: () => 'local', getCompileSettingsKey: () => 'local' },
      blocklyService: { workspace: {}, getActivePageId: () => 'page', isWorkspaceEditBlocked: () => false,
        captureBuildSnapshot: () => ({ revision: 1 }), readAfterWorkspaceEdit: (read: () => unknown) => read() },
      runWithInteractiveProjectCode: async (_workspace: unknown, consume: any) => consume(prepared, () => {}),
      build: jasmine.createSpy('build').and.callFake(async () => {
        events.push('build'); builder.passed = true; builder.lastCode = prepared.code;
        window['builder'].canReuseBlocklyUpload.and.returnValue(true); return {};
      }) });
    const uploader: any = Object.create(_UploaderService.prototype);
    Object.assign(uploader, { projectService: project, _builderService: builder,
      serialService: { currentPort: 'TEST-NO-DEVICE', currentPortInfo: { type: 'serial' } }, workflowService: workflow,
      translate: { instant: (text: string) => text }, noticeService: { update() {} }, message: { warning() {} },
      cmdService: { kill() {} }, hostBuilderService: { build: jasmine.createSpy('coderBuild').and.resolveTo({}) } });
    window['fs'] = { existsSync: () => true };
    const compiledCode = prepared.code;
    window['builder'] = { canReuseBlocklyUpload: jasmine.createSpy('reuse').and.callFake(config => config.code === compiledCode),
      publishArduinoGeneratedCode: jasmine.createSpy('publish').and.throwError('Upload checks must not publish files') };
    const run = () => uploader.upload().catch((error: any) => error);
    return { events, prepared, project, builder, uploader, run };
  }

  it('uploads unchanged successful firmware without compiling or publishing source', async () => {
    const f = uploadFixture(); await f.run();
    expect(f.events).toEqual(['upload']);
    expect(window['builder'].publishArduinoGeneratedCode).not.toHaveBeenCalled();
  });

  it('keeps the cloud unavailable notice and its local retry when upload needs a new build', async () => {
    const f = uploadFixture(), fault = { state: 'error', code: 'CLOUD_TARGET_UNAVAILABLE', text: 'Cloud target unavailable' };
    useCloudPreference(f);
    f.builder.canReuseBuildForUpload = jasmine.createSpy('reuse').and.resolveTo(false);
    const retry = jasmine.createSpy('manual local retry');
    f.builder.build.and.callFake(async () => {
      f.uploader.noticeService.data = { state: 'error', onRetryLocally: retry };
      throw fault;
    });
    const generic = spyOn(f.uploader, 'handleUploadError');
    expect(await f.run()).toBe(fault);
    expect(f.uploader.noticeService.data.onRetryLocally).toBe(retry);
    expect(retry).not.toHaveBeenCalled();
    expect(generic).not.toHaveBeenCalled();
    expect(f.events).not.toContain('upload');
  });

  it('uses a verified local execution after reopening the editor', async () => {
    const f = uploadFixture();
    Object.assign(f.builder, { passed: false, lastCode: '', currentProjectPath: '' });
    Object.assign(window['builder'], { isolatedBuildExecutionVersion: 1,
      resolveBuildExecution: () => ({ buildPath: '/private/.build' }) });
    await f.run();
    expect(f.events).toEqual(['upload']);
    expect(window['builder'].canReuseBlocklyUpload).toHaveBeenCalledOnceWith(jasmine.objectContaining({ code: f.prepared.code }));
  });

  it('keeps the cloud upload route when a prior isolated local firmware remains available', async () => {
    const f = uploadFixture();
    const backend = { local: false, useLocal() { this.local = true; }, release() {} };
    Object.assign(f.project, { beginBuildBackendOperation: () => backend,
      isCloudBuild: () => !backend.local, assertProjectDependencySession() {} });
    f.builder.configService.getCompileBackend = () => 'cloud';
    Object.assign(window['builder'], { isolatedBuildExecutionVersion: 1, sharedBuildExecutionVersion: 1,
      requiresIsolatedBuildRecovery: async () => true,
      resolveBuildExecution: jasmine.createSpy('resolveBuildExecution').and.returnValue({
        isolatedRecovery: true, buildPath: '/private/.build',
      }) });
    f.builder.waitForUploadPreprocess = async () => {};
    f.builder.canReuseBuildForUpload = jasmine.createSpy('reuseCloud').and.resolveTo(true);
    f.uploader.prepareCloudUploader = jasmine.createSpy('cloudUploader').and.resolveTo('legacy');
    window['cloudBuild'] = { artifactPath: async () => '/cloud/build' };

    await f.run();
    expect(f.events).toEqual(['upload']);
    expect(f.uploader.prepareCloudUploader).toHaveBeenCalled();
    expect(backend.local).toBeFalse();
    expect(f.builder.build).not.toHaveBeenCalled();
  });

  const firmware = {
    version: 1, executionId: '11111111-1111-4111-8111-111111111111',
    buildRequestId: 'prepared-build', inputDigest: 'a'.repeat(64), abiHash: 'sha256:' + 'b'.repeat(64),
  } as const;

  it('passes the exact live-verified shared firmware to BLE even when a newer receipt points to the same directory', async () => {
    const f = uploadFixture();
    const selected = { ...firmware, layout: 'shared', logicalProjectPath: '/project', currentProjectPath: '/project',
      buildPath: '/project/.build', preprocessPath: '/project/.temp/preprocess.json' };
    const latest = { ...selected, executionId: '22222222-2222-4222-8222-222222222222', buildRequestId: 'another-build' };
    const resolveExecution = jasmine.createSpy('resolveBuildExecution').and.callFake((_project, config) => config ? selected : latest);
    Object.assign(window['builder'], { isolatedBuildExecutionVersion: 1, sharedBuildExecutionVersion: 1, resolveBuildExecution: resolveExecution });
    f.uploader.serialService.currentPortInfo = { type: 'ble' };
    f.uploader.uploaderBleService = { authorizeDevice: async () => {} };
    f.uploader.workflowService.startUpload = () => true;
    f.uploader.uploadByBle = jasmine.createSpy('uploadByBle').and.resolveTo({ state: 'done' });

    expect(await f.run()).toEqual({ state: 'done', firmwareBackend: 'local', firmwareBuildRequestId: selected.buildRequestId });
    expect(resolveExecution).toHaveBeenCalledOnceWith('/project', jasmine.objectContaining({ code: f.prepared.code }));
    expect(f.uploader.uploadByBle.calls.mostRecent().args[3]).toBe(selected);
    expect(f.builder.build).not.toHaveBeenCalled();
  });

  function exposePreparedExecution(buildInput = firmware, isolatedRecovery = false) {
    const inspect = jasmine.createSpy('inspectBuildExecution').and.returnValue({
      ...firmware, status: 'completed', current: true, buildInput,
      result: { buildRequestId: firmware.buildRequestId, inputDigest: firmware.inputDigest, buildPath: '/private/.build', isolatedRecovery },
    });
    Object.assign(window['builder'], { isolatedBuildExecutionVersion: 1, inspectBuildExecution: inspect });
    return inspect;
  }

  it('uses the exact prepared Blockly firmware without compiling again', async () => {
    const f = uploadFixture(), inspect = exposePreparedExecution();
    await f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', preparedFirmware: firmware }).catch(() => {});
    expect(inspect).toHaveBeenCalledWith('/project', firmware.buildRequestId);
    expect(f.events).toEqual(['upload']);
    expect(f.builder.build).not.toHaveBeenCalled();
  });

  function useCloudPreference(f: ReturnType<typeof uploadFixture>) {
    const operation = { local: false, useLocal() { this.local = true; }, release() { this.local = false; } };
    Object.assign(f.project, { beginBuildBackendOperation: () => operation,
      isCloudBuild: () => !operation.local, assertProjectDependencySession() {} });
    f.builder.configService.getCompileBackend = () => 'cloud';
    return operation;
  }

  it('uses the saved shared result of a manual local switch while the preference remains cloud', async () => {
    const f = uploadFixture();
    const operation = useCloudPreference(f);
    const selected = { ...firmware, layout: 'shared', logicalProjectPath: '/project', currentProjectPath: '/project',
      buildPath: '/project/.build', preprocessPath: '/project/.temp/preprocess.json' };
    const inspect = exposePreparedExecution();
    inspect.and.returnValue({ ...inspect(), result: selected });
    const resolve = jasmine.createSpy('resolveBuildExecution').and.returnValue(selected);
    Object.assign(window['builder'], { sharedBuildExecutionVersion: 1, resolveBuildExecution: resolve });
    f.uploader.serialService.currentPortInfo = { type: 'ble' };
    f.uploader.uploaderBleService = { authorizeDevice: async () => {} };
    f.uploader.workflowService.startUpload = () => true;
    f.uploader.uploadByBle = jasmine.createSpy('uploadByBle').and.callFake(async () => {
      expect(operation.local).toBeTrue();
      return { state: 'done' };
    });

    expect(await f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', preparedFirmware: firmware }))
      .toEqual(jasmine.objectContaining({ state: 'done', firmwareBackend: 'local', firmwareBuildRequestId: firmware.buildRequestId }));
    expect(f.uploader.uploadByBle.calls.mostRecent().args[3]).toBe(selected);
    expect(resolve).toHaveBeenCalledOnceWith('/project', jasmine.objectContaining({ code: f.prepared.code }));
    expect(f.builder.build).not.toHaveBeenCalled();
    expect(f.project.isCloudBuild()).toBeTrue();
  });

  it('rejects a prepared receipt when the active source resolves to a different current build', async () => {
    const f = uploadFixture();
    useCloudPreference(f);
    exposePreparedExecution();
    Object.assign(window['builder'], { sharedBuildExecutionVersion: 1,
      resolveBuildExecution: () => ({ ...firmware, buildRequestId: 'different-build' }) });

    await expectAsync(f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', preparedFirmware: firmware }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'BUILD_ARTIFACT_STALE' }));
    expect(f.events).toEqual([]);
    expect(f.builder.build).not.toHaveBeenCalled();
  });

  it('reuses the previous local build from a new upload request while cloud is preferred', async () => {
    const f = uploadFixture();
    useCloudPreference(f);
    Object.assign(f.builder, { passed: false, lastCode: '', currentProjectPath: '' });
    const resolve = jasmine.createSpy('resolveBuildExecution').and.returnValue({ ...firmware, layout: 'shared',
      logicalProjectPath: '/project', currentProjectPath: '/project', buildPath: '/project/.build' });
    Object.assign(window['builder'], { isolatedBuildExecutionVersion: 1, sharedBuildExecutionVersion: 1, resolveBuildExecution: resolve });
    window['cloudBuild'] = { hasArtifact: async () => false };
    f.uploader.serialService.currentPortInfo = { type: 'ble' };
    f.uploader.uploaderBleService = { authorizeDevice: async () => {} };
    f.uploader.workflowService.startUpload = () => true;
    f.uploader.uploadByBle = jasmine.createSpy('uploadByBle').and.resolveTo({ state: 'done' });

    expect(await f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', reuseExistingFirmware: true }))
      .toEqual({ state: 'done', firmwareBackend: 'local', firmwareBuildRequestId: firmware.buildRequestId });
    expect(f.uploader.uploadByBle.calls.mostRecent().args[3].buildRequestId).toBe(firmware.buildRequestId);
    expect(resolve).toHaveBeenCalledOnceWith('/project', jasmine.objectContaining({ code: f.prepared.code }));
    expect(f.builder.build).not.toHaveBeenCalled();
    expect(f.project.isCloudBuild()).toBeTrue();
  });

  it('checks a matching local build when the cloud artifact hint is stale', async () => {
    const f = uploadFixture();
    useCloudPreference(f);
    window['cloudBuild'] = { hasArtifact: async () => true };
    const verify = jasmine.createSpy('canReuseBuild')
      .and.callFake(async (_cancel, _capture, backend) => backend === 'local');
    f.builder.canReuseBuildForUpload = verify;
    f.uploader.serialService.currentPortInfo = { type: 'ble' };
    f.uploader.uploaderBleService = { authorizeDevice: async () => {} };
    f.uploader.workflowService.startUpload = () => true;
    f.uploader.uploadByBle = jasmine.createSpy('uploadByBle').and.resolveTo({ state: 'done' });

    expect(await f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', reuseExistingFirmware: true }))
      .toEqual(jasmine.objectContaining({ state: 'done', firmwareBackend: 'local' }));
    expect(verify.calls.allArgs().map(args => args[2])).toEqual(['cloud', 'local']);
    expect(f.builder.build).not.toHaveBeenCalled();
    expect(f.project.isCloudBuild()).toBeTrue();
  });

  it('fails strict reuse before transport when there is no current verified firmware', async () => {
    const f = uploadFixture();
    useCloudPreference(f);
    const authorizeDevice = jasmine.createSpy('authorizeDevice');
    const publishNotice = spyOn(f.uploader.noticeService, 'update');
    f.uploader.serialService.currentPortInfo = { type: 'ble' };
    f.uploader.uploaderBleService = { authorizeDevice };
    window['cloudBuild'] = { hasArtifact: async () => false };
    f.prepared.code = 'different program';

    await expectAsync(f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', reuseExistingFirmware: true }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_REUSABLE_FIRMWARE_REQUIRED' }));
    expect(authorizeDevice).not.toHaveBeenCalled();
    expect(publishNotice).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    expect(f.builder.build).not.toHaveBeenCalled();
  });

  it('stops a verified upload if the Blockly build revision changes during device preparation', async () => {
    const f = uploadFixture();
    f.uploader.serialService.currentPortInfo = { type: 'ble' };
    f.uploader.uploaderBleService = { authorizeDevice: async () => {
      f.builder.blocklyService.captureBuildSnapshot = () => ({ revision: 2 });
    } };

    await expectAsync(f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', reuseExistingFirmware: true }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'BUILD_SOURCE_STALE' }));
    expect(f.events).toEqual([]);
    expect(f.builder.build).not.toHaveBeenCalled();
  });

  for (const stale of ['receipt', 'canvas']) {
    it(`rejects stale prepared Blockly firmware (${stale}) without a fallback build`, async () => {
      const f = uploadFixture();
      exposePreparedExecution(stale === 'receipt' ? { ...firmware, abiHash: 'sha256:' + 'c'.repeat(64) } : firmware);
      if (stale === 'canvas') f.prepared.code = 'edited after compile';
      const result = f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', preparedFirmware: firmware });
      await expectAsync(result).toBeRejectedWith(jasmine.objectContaining({ code: 'BUILD_ARTIFACT_STALE' }));
      expect(f.events).toEqual([]);
      expect(f.builder.build).not.toHaveBeenCalled();
    });
  }

  function preparedUploadBridge(ports: { name: string; type: string }[]) {
    uploadFixture();
    const inspect = exposePreparedExecution();
    const selectSerialPort = jasmine.createSpy('selectSerialPort').and.resolveTo(ports[0]);
    const upload = jasmine.createSpy('upload').and.resolveTo({ state: 'done' });
    const ensureReady = jasmine.createSpy('ensureReady').and.resolveTo(undefined);
    const bridge = Object.assign(Object.create(BlocklyLiveOperationBridgeService.prototype), {
      projectService: { currentProjectPath: '/project', isCloudBuild: () => false,
        getProjectMode: () => 'blockly', captureCurrentProjectGuard: () => () => true, ensureBlocklyLibraryRuntimeReady: ensureReady },
      configService: { getCompileSettingsKey: () => 'settings' },
      blocklyEditor: { hasUnsavedBuildChanges: jasmine.createSpy('hasUnsavedBuildChanges').and.resolveTo(false),
        getProjectRevisionSnapshot: jasmine.createSpy('getProjectRevisionSnapshot').and.resolveTo({ changed: true }) },
      serialService: { getSerialPorts: async () => ports, selectSerialPort },
      uploaderService: { upload },
    });
    return { bridge, selectSerialPort, upload, inspect, ensureReady };
  }

  it('rejects unverified prepared firmware before runtime or port admission', async () => {
    const f = preparedUploadBridge([{ name: 'COM99', type: 'serial' }]);
    f.inspect.and.returnValue(null);
    await expectAsync(f.bridge.executeProjectUpload({ preparedFirmware: firmware }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'BUILD_ARTIFACT_STALE' }));
    expect(f.ensureReady).not.toHaveBeenCalled();
    expect(f.selectSerialPort).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('keeps the no-port result for verified prepared firmware', async () => {
    const f = preparedUploadBridge([]);
    expect(await f.bridge.executeProjectUpload({ preparedFirmware: firmware }))
      .toEqual(jasmine.objectContaining({ ok: false, code: 'serial_port_not_found', ports: [] }));
    expect(f.selectSerialPort).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('reports the prepared firmware reference only after confirmed upload', async () => {
    const f = preparedUploadBridge([{ name: 'COM99', type: 'serial' }]);
    expect(await f.bridge.executeProjectUpload({ preparedFirmware: firmware }))
      .toEqual(jasmine.objectContaining({ ok: true, preparedFirmware: firmware }));
    expect(f.bridge.blocklyEditor.hasUnsavedBuildChanges).toHaveBeenCalledOnceWith();
    expect(f.bridge.blocklyEditor.getProjectRevisionSnapshot).not.toHaveBeenCalled();
    expect(f.upload).toHaveBeenCalledOnceWith('/project', 'COM99', { preparedFirmware: firmware });
    f.upload.and.resolveTo({ state: 'warn' });
    expect(await f.bridge.executeProjectUpload({ preparedFirmware: firmware }))
      .toEqual(jasmine.objectContaining({ ok: false, code: 'PREPARED_FIRMWARE_UPLOAD_UNCONFIRMED' }));
  });

  it('reuses cloud firmware with an unsaved canvas viewport', async () => {
    const f = preparedUploadBridge([{ name: 'COM99', type: 'serial' }]);
    f.bridge.projectService.isCloudBuild = () => true;
    expect(await f.bridge.executeProjectUpload({ reuseCloudFirmware: true }))
      .toEqual(jasmine.objectContaining({ ok: true, reuseCloudFirmware: true }));
    expect(f.bridge.blocklyEditor.hasUnsavedBuildChanges).toHaveBeenCalledOnceWith();
    expect(f.bridge.blocklyEditor.getProjectRevisionSnapshot).not.toHaveBeenCalled();
    expect(f.upload).toHaveBeenCalledOnceWith('/project', 'COM99', { reuseCloudFirmware: true });
  });

  for (const mode of ['local', 'cloud']) {
    it(`rejects an unsaved program edit before the strict ${mode} upload`, async () => {
      const f = preparedUploadBridge([{ name: 'COM99', type: 'serial' }]);
      const cloud = mode === 'cloud';
      f.bridge.projectService.isCloudBuild = () => cloud;
      f.bridge.blocklyEditor.hasUnsavedBuildChanges.and.resolveTo(true);
      expect(await f.bridge.executeProjectUpload(cloud ? { reuseCloudFirmware: true } : { preparedFirmware: firmware }))
        .toEqual(jasmine.objectContaining({ ok: false, code: 'BUILD_ARTIFACT_STALE' }));
      expect(f.selectSerialPort).not.toHaveBeenCalled();
      expect(f.upload).not.toHaveBeenCalled();
    });
  }

  it('passes any currently proven prepared local firmware to the uploader with cloud preferred', async () => {
    const f = preparedUploadBridge([{ name: 'COM99', type: 'serial' }]);
    f.bridge.projectService.isCloudBuild = () => true;
    expect(await f.bridge.executeProjectUpload({ preparedFirmware: firmware }))
      .toEqual(jasmine.objectContaining({ ok: true, preparedFirmware: firmware }));
    expect(f.upload).toHaveBeenCalledOnceWith('/project', 'COM99', { preparedFirmware: firmware });
    expect(f.bridge.projectService.isCloudBuild()).toBeTrue();
  });

  it('reports prepared firmware support and the active project build backend', async () => {
    const { bridge } = preparedUploadBridge([]);
    const isCloudBuild = jasmine.createSpy('isCloudBuild').and.returnValue(true);
    bridge.projectService.isCloudBuild = isCloudBuild;
    bridge.themeService = { theme: () => 'dark', getBlocklyThemeId: () => 'default' };
    bridge.configService = { data: {}, getApplicationName: () => 'aily',
      getPreferredChatAgentRuntimeMode: () => 'blockly',
      getDevelopmentModePreference: () => 'blockly', isCoderEnabled: () => false };
    bridge.electronService = { applicationVersion: '1.0.0' };
    const cloud = await bridge.executeAppInfo();
    expect(cloud.capabilities.projectPreparedFirmwareUpload).toBe(1);
    expect(cloud.capabilities.projectCloudFirmwareReuse).toBe(1);
    expect(cloud.capabilities.projectExistingFirmwareReuse).toBe(1);
    expect(cloud.capabilities.projectCrossBackendFirmwareReuse).toBe(1);
    expect(cloud.lifecycle.sourceProject).toBe('/project');
    expect(cloud.runtime.compileBackend).toBe('cloud');
    isCloudBuild.and.returnValue(false);
    expect((await bridge.executeAppInfo()).runtime.compileBackend).toBe('local');
    bridge.projectService.currentPackageData = { devmode: 'python' };
    expect((await bridge.executeAppInfo()).capabilities.projectExistingFirmwareReuse).toBeUndefined();
  });

  it('reports the backend and receipt of completed generic reuse', async () => {
    const f = preparedUploadBridge([{ name: 'COM99', type: 'serial' }]);
    f.upload.and.resolveTo({ state: 'done', firmwareBackend: 'local', firmwareBuildRequestId: firmware.buildRequestId });
    expect(await f.bridge.executeProjectUpload({ reuseExistingFirmware: true }))
      .toEqual(jasmine.objectContaining({ ok: true, reuseExistingFirmware: true,
        firmwareBackend: 'local', firmwareBuildRequestId: firmware.buildRequestId }));
    expect(f.upload).toHaveBeenCalledOnceWith('/project', 'COM99', { reuseExistingFirmware: true });
  });

  it('distinguishes a missing reusable build from an unsaved program edit before transport', async () => {
    const f = preparedUploadBridge([{ name: 'COM99', type: 'serial' }]);
    f.upload.and.rejectWith({ code: 'PROJECT_REUSABLE_FIRMWARE_REQUIRED' });
    const missed = await f.bridge.executeProjectUpload({ reuseExistingFirmware: true });
    expect(missed).toEqual(jasmine.objectContaining({ ok: false, code: 'PROJECT_REUSABLE_FIRMWARE_REQUIRED',
      uploadStarted: false, uploadOutcome: 'not-started' }));
    expect(missed.requiresSave).toBeUndefined();
    f.selectSerialPort.calls.reset();
    f.upload.calls.reset();
    f.bridge.blocklyEditor.hasUnsavedBuildChanges.and.resolveTo(true);
    expect(await f.bridge.executeProjectUpload({ reuseExistingFirmware: true }))
      .toEqual(jasmine.objectContaining({ ok: false, code: 'PROJECT_REUSABLE_FIRMWARE_REQUIRED', requiresSave: true,
        uploadStarted: false, uploadOutcome: 'not-started' }));
    expect(f.selectSerialPort).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('does not dispatch strict reuse after the selected port no longer matches', async () => {
    const f = preparedUploadBridge([{ name: 'COM99', type: 'serial' }]);
    f.selectSerialPort.and.resolveTo({ name: 'COM100', type: 'serial' });
    expect(await f.bridge.executeProjectUpload({ reuseExistingFirmware: true }))
      .toEqual(jasmine.objectContaining({ ok: false, code: 'BUILD_ARTIFACT_STALE', uploadOutcome: 'not-started' }));
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('rejects a strict reuse request with an exact cloud selector', async () => {
    const f = preparedUploadBridge([{ name: 'COM99', type: 'serial' }]);
    await expectAsync(f.bridge.executeProjectUpload({ reuseExistingFirmware: true, reuseCloudFirmware: true }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'PREPARED_FIRMWARE_INVALID' }));
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('forwards cloud firmware reuse and returns proof only on completion', async () => {
    const f = preparedUploadBridge([{ name: 'COM99', type: 'serial' }]);
    expect(await f.bridge.executeProjectUpload({ reuseCloudFirmware: true }))
      .toEqual(jasmine.objectContaining({ ok: true, reuseCloudFirmware: true }));
    expect(f.upload).toHaveBeenCalledOnceWith('/project', 'COM99', { reuseCloudFirmware: true });
  });

  it('reuses a verified cloud artifact while local is preferred', async () => {
    const f = uploadFixture();
    const hasArtifact = jasmine.createSpy('hasArtifact').and.resolveTo(true);
    f.builder.canReuseBuildForUpload = jasmine.createSpy('canReuseBuild').and.resolveTo(true);
    f.builder.waitForUploadPreprocess = async () => {};
    f.project.assertProjectDependencySession = () => {};
    f.uploader.prepareCloudUploader = async () => 'legacy';
    f.uploader.workflowService.startUpload = () => true;
    f.uploader.uploadCloudResult = jasmine.createSpy('uploadCloudResult').and.resolveTo({ state: 'done' });
    window['cloudBuild'] = { hasArtifact, artifactPath: async () => '/verified/current-cloud' };

    expect(await f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', reuseExistingFirmware: true }))
      .toEqual({ state: 'done', firmwareBackend: 'cloud' });
    expect(hasArtifact).toHaveBeenCalledOnceWith({ projectPath: '/project' });
    expect(f.builder.canReuseBuildForUpload.calls.mostRecent().args[2]).toBe('cloud');
    expect(f.uploader.uploadCloudResult).toHaveBeenCalledOnceWith('/project', 'TEST-NO-DEVICE', jasmine.any(Function));
    expect(f.builder.build).not.toHaveBeenCalled();
    expect(f.project.isCloudBuild()).toBeFalse();
  });

  for (const reusable of [true, false]) {
    it(`handles cloud firmware reuse (reusable=${reusable}) without compiling`, async () => {
      const f = uploadFixture();
      Object.assign(f.project, { isCloudBuild: () => true, getProjectDependencySession: () => ({}),
        assertProjectDependencySession() {} });
      f.builder.waitForUploadPreprocess = async () => {};
      f.builder.canReuseBuildForUpload = jasmine.createSpy('canReuseBuild').and.resolveTo(reusable);
      f.uploader.prepareCloudUploader = jasmine.createSpy('prepareCloudUploader').and.resolveTo('legacy');
      const authorizeDevice = jasmine.createSpy('authorizeDevice').and.resolveTo(undefined);
      if (!reusable) {
        f.uploader.serialService.currentPortInfo = { type: 'ble' };
        f.uploader.uploaderBleService = { authorizeDevice };
      }
      window['cloudBuild'] = { artifactPath: async () => '/current-cloud-artifact' };
      const result = f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', reuseCloudFirmware: true });
      if (reusable) {
        await result.catch(() => {});
        expect(f.events).toEqual(['upload']);
      } else {
        await expectAsync(result).toBeRejectedWith(jasmine.objectContaining({ code: 'BUILD_ARTIFACT_STALE' }));
        expect(f.events).toEqual([]);
        expect(authorizeDevice).not.toHaveBeenCalled();
        expect(f.uploader.prepareCloudUploader).not.toHaveBeenCalled();
      }
      expect(f.builder.canReuseBuildForUpload).toHaveBeenCalledTimes(1);
      expect(f.builder.build).not.toHaveBeenCalled();
    });
  }

  for (const portType of ['ble', 'network-ota']) {
    it(`prepares and uses the signed cloud firmware for the selected ${portType} transport`, async () => {
      const f = uploadFixture();
      Object.assign(f.project, { isCloudBuild: () => true, assertProjectDependencySession() {} });
      f.builder.canReuseBuildForUpload = async () => true;
      f.uploader.serialService.currentPortInfo = { type: portType };
      f.uploader.uploaderBleService = { authorizeDevice: async () => {} };
      f.uploader.canUseWifiOta = async () => true;
      f.uploader.workflowService.startUpload = () => true;
      const upload = jasmine.createSpy('uploadOta').and.resolveTo({ state: 'done' });
      f.uploader[portType === 'ble' ? 'uploadByBle' : 'uploadByNetworkOta'] = upload;
      const artifactUploadInfo = jasmine.createSpy('artifactUploadInfo').and.resolveTo({ protocol: 'cloud-recipe', requirements: [] });
      const prepareArtifactUpload = jasmine.createSpy('prepareArtifactUpload').and.callFake(async ({ requestId }) => ({
        requestId, buildPath: '/verified/build', uploadArtifactInventory: { primary: 'sketch.bin' },
      }));
      const beginArtifactUploadRoute = jasmine.createSpy('beginArtifactUploadRoute').and.resolveTo(true);
      window['path'] = { join: (...parts: string[]) => parts.join('/') };
      window['cloudBuild'] = {
        artifactUploadInfo, prepareArtifactUpload, beginArtifactUploadRoute,
        artifactPath: async () => '/verified/build/sketch.bin', assertArtifactUpload: async () => true,
        finishArtifactUpload: async () => true, onProgress: () => () => {},
      };

      expect(await f.uploader.upload({ projectPath: '/project', port: 'TEST-NO-DEVICE', reuseCloudFirmware: true }))
        .toEqual({ state: 'done', firmwareBackend: 'cloud' });
      expect(artifactUploadInfo).toHaveBeenCalledOnceWith({ projectPath: '/project', portType });
      expect(prepareArtifactUpload).toHaveBeenCalledOnceWith(jasmine.objectContaining({ projectPath: '/project', portType }));
      expect(upload).toHaveBeenCalledOnceWith('/verified/build', { type: portType }, undefined, undefined);
      expect(beginArtifactUploadRoute.calls.count()).toBe(portType === 'ble' ? 1 : 0);
    });
  }

  for (const changed of ['code', 'inputs-or-firmware', 'config-reset']) {
    it(`rebuilds before upload after ${changed}`, async () => {
      const f = uploadFixture();
      if (changed === 'code') f.prepared.code = 'new code';
      if (changed === 'inputs-or-firmware') window['builder'].canReuseBlocklyUpload.and.returnValue(false);
      if (changed === 'config-reset') f.builder.passed = false;
      await f.run(); expect(f.events).toEqual(['build', 'upload']);
    });
  }

  it('waits for running preprocessing without publishing into its workspace', fakeAsync(() => {
    const f = uploadFixture(); f.builder.preprocessProcess = {};
    void f.run(); tick(0);
    expect(f.builder.isUploading).toBeTrue(); expect(f.events).toEqual([]);
    tick(300); expect(f.events).toEqual([]);
    f.builder.preprocessProcess = null; tick(100);
    expect(f.events).toEqual(['upload']);
    expect(window['builder'].publishArduinoGeneratedCode).not.toHaveBeenCalled();
  }));

  for (const interrupted of ['cancelled', 'project-switched']) {
    it(`does not compile or upload when ${interrupted} during preprocess waiting`, fakeAsync(() => {
      const f = uploadFixture(); f.builder.preprocessProcess = {};
      void f.run(); tick(0);
      if (interrupted === 'cancelled') f.uploader.cancelled = true;
      else f.project.currentProjectPath = '/other';
      tick(100); expect(f.events).toEqual([]); expect(f.builder.isUploading).toBeFalse();
    }));
  }

  it('does not upload after a failed build and releases background scheduling', async () => {
    const f = uploadFixture(); f.builder.passed = false;
    f.builder.build.and.callFake(async () => { f.events.push('build'); throw new Error('compile failed'); });
    await f.run(); expect(f.events).toEqual(['build']); expect(f.builder.isUploading).toBeFalse();
  });

  it('stops upload when the workspace changes again during compilation', async () => {
    const f = uploadFixture(); f.builder.passed = false;
    f.builder.build.and.callFake(async () => {
      f.events.push('build'); f.builder.passed = true; f.prepared.code = 'edited during compile'; return {};
    });
    await f.run(); expect(f.events).toEqual(['build']); expect(f.builder.isUploading).toBeFalse();
  });

  it('preserves the Coder disk-build route', async () => {
    const f = uploadFixture(); f.project.isAilyCodeProject = () => true;
    await f.run(); expect(f.uploader.hostBuilderService.build).toHaveBeenCalledOnceWith('/project');
    expect(f.builder.build).not.toHaveBeenCalled(); expect(window['builder'].canReuseBlocklyUpload).not.toHaveBeenCalled();
  });

  for (const reusable of [true, false]) it(`uses the local Coder receipt before upload (reusable=${reusable})`, async () => {
    const f = uploadFixture();
    f.project.isAilyCodeProject = () => true;
    window['builder'].canReuseCoderUpload = async () => true;
    const check = jasmine.createSpy('checkCoderBuild').and.returnValues(Promise.resolve(reusable), Promise.resolve(true));
    f.uploader.hostBuilderService.canReuseBuildForUpload = check;
    await f.run();
    expect(check).toHaveBeenCalledTimes(reusable ? 1 : 2);
    expect(f.uploader.hostBuilderService.build).toHaveBeenCalledTimes(reusable ? 0 : 1);
    expect(f.events).toEqual(['upload']);
  });

  for (const reusable of [true, false]) it(`prepares the new Coder settings session only on a firmware miss (reusable=${reusable})`, async () => {
    const f = uploadFixture();
    Object.assign(f.project, { isAilyCodeProject: () => true, isCoderProjectContext: true, getProjectDependencyStatus: () => 'idle' });
    window['builder'].canReuseCoderUpload = async () => true;
    f.uploader.hostBuilderService.canReuseBuildForUpload = jasmine.createSpy('verify').and.returnValues(reusable, true);
    const prepare = jasmine.createSpy('prepare').and.resolveTo(true);
    f.uploader.npmService = { ensureProjectAndBoardDeps: prepare };
    await f.run();
    expect(f.events).toEqual(['upload']);
    expect(prepare).toHaveBeenCalledTimes(reusable ? 0 : 1);
    if (!reusable) expect(prepare).toHaveBeenCalledBefore(f.uploader.hostBuilderService.build);
  });

  for (const coder of [false, true]) it(`continues ${coder ? 'Coder' : 'Blockly'} upload with local firmware after a task-only switch`, async () => {
    const f = uploadFixture();
    const operation = { local: false, release: jasmine.createSpy('release') };
    Object.assign(f.project, {
      beginBuildBackendOperation: () => operation, isCloudBuild: () => !operation.local,
      isAilyCodeProject: () => coder, getProjectDependencySession: () => ({}), assertProjectDependencySession() {},
      getBuildPath: async () => { expect(operation.local).toBeTrue(); return '/project/.build'; },
    });
    const build = async () => { f.events.push('build'); operation.local = true; f.builder.passed = true; return {}; };
    f.builder.build.and.callFake(build);
    f.builder.canReuseBuildForUpload = async () => operation.local;
    f.uploader.hostBuilderService.build.and.callFake(build);
    f.uploader.hostBuilderService.canReuseBuildForUpload = jasmine.createSpy('cloudReuse').and.resolveTo(false);
    f.uploader.prepareCloudUploader = jasmine.createSpy('prepareCloudUploader');
    await f.run();
    expect(f.events).toEqual(['build', 'upload']);
    expect(f.uploader.prepareCloudUploader).not.toHaveBeenCalled();
    expect(operation.release).toHaveBeenCalledTimes(1);
    if (coder) expect(f.uploader.hostBuilderService.canReuseBuildForUpload).toHaveBeenCalledTimes(1);
  });

  function compileFixture() {
    const files = new Map([
      ['/project/package.json', JSON.stringify({ name: 'project', MACROS: [['WIDTH=240']] })],
      ['/project/node_modules/@aily-project/board-test/package.json', '{}'],
      ['/project/node_modules/@aily-project/board-test/board.json', '{"name":"board"}'],
    ]);
    window['fs'] = { readFileSync: (file: string) => files.get(file),
      existsSync: (file: string) => files.has(file), mkdirSync() {},
      lstatSync: () => ({ _isSymbolicLink: false }),
      writeFileSync: (file: string, content: string) => files.set(file, content),
      appendFileSync: (file: string, content: string) => files.set(file, files.get(file)! + content),
      renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
      replaceProjectText: async (request: any, check: () => void) => {
        check(); const file = `${request.projectPath}/${request.fileName}`;
        expect(`sha256:${await sha256Hex(files.get(file)!)}`).toBe(request.expectedHash);
        files.set(file, request.content);
        return { status: 'COMMITTED', hash: `sha256:${await sha256Hex(request.content)}` };
      } };
    window['path'] = { join: (...parts: string[]) => parts.join('/'), isExists: () => false, getAppDataPath: () => '/appdata', getAilyChildPath: () => '/child' };
    window['builder'] = { captureBuildSource: () => ({ digest: 'test' }) };
    const service: any = Object.create(_BuilderService.prototype), command = new Subject<any>();
    const prepared = { code: 'void setup() {}', artifacts: null, projectMacros: [{ name: 'WIDTH', value: 'WIDTH=320' }],
      revision: 1, sourceWorkspace: { documentText: '{}', revision: 1, runtimeRevision: 1, pageId: 'main' } };
    Object.assign(service, {
      metrics: { record: jasmine.createSpy('record') },
      passed: true, projectService: { captureCurrentProjectGuard: () => () => true, beginBuildBackendOperation: () => ({ release() {} }), currentProjectPath: '/project', currentPackageData: {},
        getBuildPath: async () => '/project/.build', getBoardModule: async () => '@aily-project/board-test',
        getRuntimeBoardModule: () => '@aily-project/board-test', getBoardJson: async () => ({ name: 'board' }),
        currentBoardConfig: { name: 'board' },
        prepareCloudBoardForBuild: jasmine.createSpy('prepareCloudBoardForBuild').and.resolveTo({
          boardModule: '@aily-project/board-test', profileDigest: 'a'.repeat(64), capabilities: { compile: true },
        }),
        ensureCustomPartitionFile: async (_path: string, assertCurrent: () => void) => { assertCurrent(); return null; } },
      workflowService: { currentState: ProcessState.IDLE,
        startBuild() { this.currentState = ProcessState.BUILDING; return true; },
        finishBuild: jasmine.createSpy('finishBuild').and.callFake((success: boolean) => {
          service.workflowService.currentState = success ? ProcessState.IDLE : ProcessState.ERROR;
        }) },
      electronService: { pathJoin: (...parts: string[]) => parts.join('/'), calculateHash: async () => 'hash' },
      platformService: { za7: '/tool' }, configService: { getCompileBackend: () => 'local', getCompileSettingsKey: () => 'local', data: {} }, translate: { instant: (x: string) => x },
      blocklyService: { workspace: {}, isWorkspaceEditBlocked: () => false, getActivePageId: () => 'main',
        captureBuildSnapshot: () => ({ revision: 1 }), publishPreparedCodeView() {},
        readAfterWorkspaceEdit: (read: () => unknown) => read() },
      runWithInteractiveProjectCode: async (_workspace: unknown, consume: any) => consume(prepared, () => {}),
      waitForOneIdleBoundary: async () => {}, runBuilderPreprocessPhase: (_tag: string, fn: any) => fn(),
      waitForAilyBuilderReady: async () => {}, writeCompileRequest: jasmine.createSpy('request').and.resolveTo('/request'),
      cmdService: { spawn: jasmine.createSpy('spawn').and.returnValue(command) },
      npmService: { ensureLocalCompilerDependencies: jasmine.createSpy('compilerIntegrity').and.resolveTo() },
      noticeService: { update() {} }, logService: { update() {} }, message: { warning() {} },
      projectDebugConfigurationService: { updateWorkspaceGeneratedCode: async () => {} },
      compileValidationService: { triggerAfterSuccessfulCompile() {} },
      appendCompileLog() {}, saveBuildInfo: async () => {}, handleCompileError() {},
    });
    const start = async (requestId?: string, preparation = {}) => {
      const result = service.build(undefined, requestId, {}, preparation).catch((error: any) => error);
      // Let asynchronous macro hashing/publication and request preparation finish.
      for (let n = 0; n < 100 && !service.cmdService.spawn.calls.count(); n++) {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (service.workflowService.finishBuild.calls.count()) break;
      }
      return { result };
    };
    return { service, files, command, start };
  }

  it('publishes a cancellable preparation notice on admission, before writing the request log', async () => {
    const f = compileFixture();
    const notices: any[] = [];
    f.service.noticeService = { update: (notice: any) => notices.push(notice) };
    f.service.workflowService.currentState = ProcessState.BUILDING;
    f.service.ensureCancelState = () => {};
    const build = f.service.build().catch((error: any) => error);
    expect(notices[0]).toEqual(jasmine.objectContaining({
      title: 'BLOCKLY_EDITOR.BUILD.PREPARING_TITLE', state: 'doing', showProgress: false,
    }));
    expect([...f.files.keys()].some(path => path.endsWith('.log'))).toBeFalse();
    notices[0].stop();
    const result = await build;
    expect(result.code).toBe('BUILD_CANCELLED');
    expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
    expect(f.service.workflowService.finishBuild).toHaveBeenCalled();
    expect(notices.at(-1).isCancellationNotice).toBeTrue();
  });

  it('builds and revalidates cloud firmware without publishing to a protected local workspace', async () => {
    const f = compileFixture();
    const manifest = f.files.get('/project/package.json');
    Object.assign(window['builder'], {
      isolatedBuildExecutionVersion: 1,
      requiresIsolatedBuildRecovery: async () => true,
      publishArduinoGeneratedCode: jasmine.createSpy('publish').and.throwError('Local build workspace is protected'),
    });
    f.service.projectService.isCloudBuild = () => true;
    f.service.configService.getCompileBackend = () => 'cloud';
    f.service.npmService.prepareCompileBackend = async () => {};
    f.service.npmService.ensureCloudLibrarySources = async () => {};
    f.service.saveBuildInfo = jasmine.createSpy('saveBuildInfo');
    f.service.runCloudCompilation = jasmine.createSpy('runCloud').and.resolveTo({ state: 'done' });
    const reusable = jasmine.createSpy('reusable').and.resolveTo(true);
    window['cloudBuild'] = { reusable };

    expect((await f.service.build()).state).toBe('done');
    expect(f.service.runCloudCompilation).toHaveBeenCalledOnceWith(jasmine.objectContaining({ isolatedCloudBuild: true,
      projectMacros: [{ name: 'WIDTH', value: 'WIDTH=320' }], sourceCapture: { digest: 'test' } }), 'board', jasmine.any(Function), jasmine.objectContaining({ profileDigest: 'a'.repeat(64) }));
    expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
    expect(f.service.saveBuildInfo).not.toHaveBeenCalled();
    expect(f.files.get('/project/package.json')).toBe(manifest);
    expect(window['builder'].publishArduinoGeneratedCode).not.toHaveBeenCalled();
    expect(await f.service.canReuseBuildForUpload(() => false)).toBeTrue();
    expect(reusable).toHaveBeenCalledOnceWith({ config: jasmine.objectContaining({ isolatedCloudBuild: true, generatedArtifacts: null }) });
  });

  for (const exitCode of [0, 1]) it(`uses a tool loading diagnostic only for a failed build (exit=${exitCode})`, async () => {
    const f = compileFixture();
    const requestId = 'tool-loading-original';
    const code = 'TOOL_LOAD_PYTHON_DLL';
    const diagnostic = '[AILY_TOOL_LOAD_FAILURE] ' + JSON.stringify({ version: 1, code, stage: 'objcopy' });
    const nativeError = "[PYI-1:ERROR] Failed to load Python DLL 'python313.dll'";
    f.service.handleCompileError = jasmine.createSpy('handleCompileError');
    const { result } = await f.start(requestId);
    f.command.next({ type: 'stderr', data: nativeError + '\n' + diagnostic.slice(0, 28) });
    f.command.next({ type: 'stderr', data: diagnostic.slice(28) + '\nBuild terminated\n' });
    f.command.next({ type: 'close', code: exitCode });
    f.command.complete();

    const settled = await result;
    expect(settled.state).toBe(exitCode ? 'error' : 'done');
    expect(settled.buildLog).toEqual(jasmine.objectContaining({ requestId, complete: true }));
    expect(f.files.get(settled.buildLog.path)).toContain(diagnostic);
    if (exitCode) {
      expect(settled.text).toBe('BLOCKLY_EDITOR.BUILD.' + code);
      expect(f.service.handleCompileError).toHaveBeenCalledOnceWith(settled.text, false, jasmine.stringContaining(nativeError));
    } else expect(f.service.handleCompileError).not.toHaveBeenCalled();
  });

  for (const early of [false, true]) it(`persists a cancelled Blockly request after cleanup and before releasing workflow (early=${early})`, async () => {
    const f = compileFixture();
    let stopped!: (value: boolean) => void, prepared!: () => void, persisted!: () => void;
    let persisting!: () => void;
    const metadataStarted = new Promise<void>(resolve => { persisting = resolve; });
    f.service.workflowService.currentState = ProcessState.BUILDING;
    f.service.workflowService.finishBuild.and.callFake(() => { f.service.workflowService.currentState = ProcessState.ERROR; });
    f.service.ensureCancelState = () => {};
    f.service.saveBuildInfo = jasmine.createSpy('saveBuildInfo').and.callFake(() => new Promise<void>(resolve => {
      persisted = resolve;
      persisting();
    }));
    f.service.cmdService.kill = jasmine.createSpy('kill').and.returnValue(new Promise<boolean>(resolve => { stopped = resolve; }));
    if (early) f.service.npmService.ensureLocalCompilerDependencies = () => new Promise<void>(resolve => { prepared = resolve; });
    const result = f.service.build().catch((error: any) => error);
    for (let n = 0; n < 100 && !(early ? prepared : f.service.streamId); n++) await new Promise(resolve => setTimeout(resolve, 1));
    f.service.cancel();
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(f.service.saveBuildInfo).not.toHaveBeenCalled();
    expect(f.service.workflowService.finishBuild).not.toHaveBeenCalled();
    if (early) prepared(); else stopped(true);
    await metadataStarted;
    expect(f.service.saveBuildInfo).toHaveBeenCalledOnceWith('/project', 'cancelled', jasmine.any(String), early ? '' : 'hash', true,
      { config: early ? undefined : f.service.activeExecutionConfig });
    expect(f.service.workflowService.finishBuild).not.toHaveBeenCalled();
    expect(f.service.workflowService.currentState).toBe(ProcessState.BUILDING);
    persisted();
    const completed = await result;
    expect(completed).toEqual(jasmine.objectContaining({ code: 'BUILD_CANCELLED', buildOutcome: 'cancelled', state: 'warn', retryable: false }));
    expect(f.service.workflowService.finishBuild).toHaveBeenCalledTimes(1);
    expect(f.service.passed).toBeFalse();
  });

  for (const terminal of ['completed', 'failed', 'mismatched', 'unconfirmed']) it(`a late Blockly Stop preserves the ${terminal} request and its log tail`, async () => {
    const f = compileFixture();
    const requestId = 'native-terminal-before-stop';
    const { result } = await f.start(requestId);
    const binding = { version: 1, id: 'native-execution', inputDigest: 'digest', buildRequestId: requestId };
    const config = { ...f.service.activeExecutionConfig, execution: binding };
    f.service.activeExecutionConfig = config;
    const nativeReply = terminal === 'mismatched' ? { ...binding, status: 'cancelled', id: 'other-execution' }
      : terminal === 'unconfirmed' ? undefined : { ...binding, status: terminal };
    window['builder'].cancelBuildExecution = jasmine.createSpy('cancelBuildExecution').and.returnValue(nativeReply);
    f.service.cmdService.kill = jasmine.createSpy('kill').and.resolveTo(true);
    f.service.ensureCancelState = jasmine.createSpy('ensureCancelState');

    f.service.cancel(requestId);
    expect(window['builder'].cancelBuildExecution).toHaveBeenCalledOnceWith(config);
    expect(f.service.buildCancellation.signal.aborted).toBeFalse();
    expect(f.command.observed).toBeTrue();
    expect(f.service.cmdService.kill).not.toHaveBeenCalled();
    expect(f.service.workflowService.currentState).toBe(ProcessState.BUILDING);
    f.command.next({ type: 'stdout', data: 'final compiler output\n' });
    f.command.next({ type: 'close', code: terminal === 'failed' ? 1 : 0 });
    f.command.complete();
    const settled = await result;
    expect(settled.state).toBe(terminal === 'failed' ? 'error' : 'done');
    expect(settled.code).not.toBe('BUILD_CANCELLED');
    expect(settled.buildLog).toEqual(jasmine.objectContaining({ requestId, complete: true }));
    expect(f.files.get(settled.buildLog.path)).toContain('final compiler output');
    expect(f.service.workflowService.finishBuild).toHaveBeenCalledTimes(1);
  });

  it('ends an unconfirmed private build in the foreground without recording a fake cancellation', async () => {
    const f = compileFixture();
    const id = 'private-uncertain-original';
    const { result } = await f.start(id);
    expect(f.service.streamId).toBeTruthy();
    const binding = { version: 1, id: 'original-execution', inputDigest: 'original-input',
      buildRequestId: id, logicalProjectPath: '/project' };
    f.service.activeExecutionConfig = { ...f.service.activeExecutionConfig, execution: binding,
      currentProjectPath: '/project/.aily/build-executions/original-execution/project' };
    window['builder'].isolatedBuildExecutionVersion = 1;
    window['builder'].cancelBuildExecution = jasmine.createSpy('cancel').and.returnValue(undefined);
    f.service.saveBuildInfo = jasmine.createSpy('saveBuildInfo').and.resolveTo(undefined);
    f.service.cmdService.kill = jasmine.createSpy('kill');

    f.service.cancel(id);
    const stopped = await result;
    expect(stopped).toEqual(jasmine.objectContaining({ buildOutcome: 'unknown', code: 'BUILD_OBSERVATION_UNCONFIRMED' }));
    expect(f.service.cmdService.kill).not.toHaveBeenCalled();
    expect(f.service.saveBuildInfo).not.toHaveBeenCalled();
    expect(f.service.activeBuildRequestId).toBeNull();
    expect(f.service.workflowService.currentState).toBe(ProcessState.ERROR);
    expect(f.command.observed).toBeFalse();
  });

  it('a confirmed native Blockly Stop aborts the matching request', async () => {
    const f = compileFixture();
    const requestId = 'native-cancelled-request';
    const { result } = await f.start(requestId);
    const binding = { version: 1, id: 'native-execution', inputDigest: 'digest', buildRequestId: requestId };
    const config = { ...f.service.activeExecutionConfig, execution: binding };
    f.service.activeExecutionConfig = config;
    window['builder'].cancelBuildExecution = jasmine.createSpy('cancelBuildExecution').and.returnValue({ ...binding, status: 'cancelled' });
    f.service.cmdService.kill = jasmine.createSpy('kill').and.resolveTo(true);
    f.service.ensureCancelState = jasmine.createSpy('ensureCancelState');
    const streamId = f.service.streamId;

    f.service.cancel(requestId);
    expect(window['builder'].cancelBuildExecution).toHaveBeenCalledOnceWith(config);
    expect(f.service.buildCancellation.signal.aborted).toBeTrue();
    expect(f.service.cmdService.kill).toHaveBeenCalledOnceWith(streamId);
    expect(await result).toEqual(jasmine.objectContaining({ code: 'BUILD_CANCELLED', buildOutcome: 'cancelled' }));
  });

  for (const scenario of [
    { name: 'stdout-typed-error', stream: 'stdout', newline: true, ending: 'typed-error', noWarning: true },
    { name: 'stderr-tail-typed-error', stream: 'stderr', newline: false, ending: 'typed-error' },
    { name: 'captured-native-error', stream: 'stderr', newline: true, ending: 'close', native: true },
    { name: 'silent-stderr-close', stream: 'stderr', newline: true, ending: 'close', silent: true },
    { name: 'stderr-close', stream: 'stderr', newline: true, ending: 'close' },
    { name: 'stderr-tail-close', stream: 'stderr', newline: false, ending: 'close' },
    { name: 'stdout-close-fallback', stream: 'stdout', newline: true, ending: 'close' },
    { name: 'stderr-tail-observable-error', stream: 'stderr', newline: false, ending: 'observable-error' },
  ]) it('local Blockly diagnostic appears once: ' + scenario.name, async () => {
    const f = compileFixture(), entries: any[] = [], notices: any[] = [];
    const logService = { update: (entry: any) => entries.push(entry) };
    const noticeService = new NoticeService(logService as any);
    noticeService.stateSubject.subscribe(notice => notices.push(notice));
    let listener: any, rejectRun!: (reason: unknown) => void;
    window['cmd'] = { onData: (streamId: string, callback: any) => {
      listener = (event: any) => callback({ ...event, streamId });
      return () => { listener = undefined; };
    },
      run: () => new Promise((_resolve, reject) => { rejectRun = reject; }) };
    const cmd = new CmdService(logService as any), spawn = cmd.spawn.bind(cmd);
    spyOn(cmd, 'spawn').and.callFake((command, args, options, silent) => spawn(command, args, options, scenario.silent || silent));
    f.service.cmdService = cmd;
    f.service.logService = logService; f.service.noticeService = noticeService;
    f.service.handleCompileError = _BuilderService.prototype['handleCompileError'];
    f.service.npmService.prepareCompileBackend = async () => {};
    const normal = scenario.native ? 'Starting compilation of' : 'LOCAL_BLOCKLY_NORMAL_' + scenario.name;
    const warning = 'warning: LOCAL_BLOCKLY_WARNING_' + scenario.name;
    const diagnostic = scenario.native ? localCompileDiagnostic : '[ERROR] source.cpp:4:3: LOCAL_BLOCKLY_DIAGNOSTIC_' + scenario.name;
    const transport = 'LOCAL_BLOCKLY_TRANSPORT_' + scenario.name;
    const { result } = await f.start();
    expect(f.service.cmdService.spawn).toHaveBeenCalledTimes(1);
    if (scenario.native) localCompileErrorEvents.forEach(event => listener({ ...event }));
    else {
    listener({ type: 'stdout', data: normal + '\n' });
    if (!scenario.noWarning) listener({ type: 'stderr', data: warning + '\n' });
    listener({ type: scenario.stream, data: diagnostic + (scenario.newline ? '\n' : '') });
    }
    if (scenario.ending === 'observable-error') rejectRun(new Error(transport));
    else if (scenario.ending === 'typed-error') listener({ type: 'error', error: transport });
    else {
      listener({ type: 'close', code: 1 });
    }
    const outcome = await result;
    f.service.clearProgressTimer();
    expect(outcome.state).toBe('error');
    const count = (marker: string) => entries.reduce((n, entry) => n + String(entry.detail || '').split(marker).length - 1, 0);
    console.log('LOCAL_LOG_REPRO ' + JSON.stringify({ editor: 'Blockly', scenario: scenario.name,
      normal: count(normal), warning: count(warning), diagnostic: count(diagnostic),
      errorEntries: entries.filter(entry => entry.state === 'error').length,
      finalNoticeHasDiagnostic: notices.filter(notice => notice.state === 'error').at(-1)?.detail?.includes(diagnostic) || false }));
    expect(count(normal)).withContext('normal stdout replayed after local failure').toBe(1);
    if (!scenario.native && !scenario.noWarning) expect(count(warning)).withContext('warning missing or replayed after local failure').toBe(1);
    expect(count(diagnostic)).withContext('diagnostic missing or replayed after local failure').toBe(1);
    expect(notices.filter(notice => notice.state === 'error').at(-1)?.detail).toContain(diagnostic);
    if (scenario.ending === 'typed-error') expect(notices.filter(notice => notice.state === 'error').at(-1)?.detail).toContain(transport);
  });

  for (const stage of ['preflight', 'cloud-execution']) it(`offers an explicit new local Blockly task after ${stage} fails`, async () => {
    const f = compileFixture();
    let local = false, owners = 0;
    f.service.projectService.beginBuildBackendOperation = () => {
      owners++;
      return { useLocal() { local = true; }, release() { if (--owners === 0) local = false; } };
    };
    f.service.projectService.isCloudBuild = () => !local;
    f.service.configService.getCompileBackend = () => 'cloud';
    f.service.workflowService.currentState = ProcessState.IDLE;
    f.service.workflowService.startBuild = () => { f.service.workflowService.currentState = ProcessState.BUILDING; return true; };
    f.service.workflowService.finishBuild.and.callFake((success: boolean) => {
      f.service.workflowService.currentState = success ? ProcessState.IDLE : ProcessState.ERROR;
    });
    const notices: any[] = [];
    f.service.noticeService.update = (notice: any) => notices.push(notice);
    f.service.translate.instant = (key: string, params?: { message?: string }) =>
      key === 'BLOCKLY_EDITOR.BUILD.MESSAGE_WITH_DURATION' ? params?.message : key;
    f.service.handleCompileError = _BuilderService.prototype['handleCompileError'];
    const fault = stage === 'preflight'
      ? Object.assign(new Error('Board no longer supports cloud builds'), { code: 'CLOUD_BOARD_UNSUPPORTED' })
      : Object.assign(new Error('This CI resource generator requires a supported exact SDK and citool version.'), { code: 'CI_RESOURCE_UNSUPPORTED' });
    f.service.npmService = { ensureLocalCompilerDependencies: async () => {}, ensureCloudLibrarySources: async () => {}, prepareCompileBackend: async () => {
      if (!local && stage === 'preflight') throw fault;
    }, prepareLocalCompileBackend: jasmine.createSpy('localDeps').and.callFake(async () => {
      expect(local).toBeTrue(); expect(owners).toBe(1);
    }) };
    f.service.runCloudCompilation = jasmine.createSpy('cloud').and.rejectWith(fault);
    const { result } = await f.start();
    const completed = await result;
    expect(completed).toEqual(jasmine.objectContaining({ state: 'error', code: fault.code, text: 'PROJECT.CLOUD_TARGET_UNAVAILABLE' }));
    expect(completed.fullStdErr).toContain(fault.message);
    expect(f.service.runCloudCompilation).toHaveBeenCalledTimes(stage === 'cloud-execution' ? 1 : 0);
    expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
    expect(f.service.npmService.prepareLocalCompileBackend).not.toHaveBeenCalled();
    expect(owners).toBe(0);
    const notice = notices.find(n => n.state === 'error');
    expect(notice.text).toContain('PROJECT.CLOUD_TARGET_UNAVAILABLE');
    expect(notice.detail).toContain(fault.message);
    const retry = notice.onRetryLocally;
    expect(retry).toEqual(jasmine.any(Function));
    const pending = retry(); await retry();
    for (let n = 0; n < 100 && !f.service.cmdService.spawn.calls.count(); n++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(f.service.cmdService.spawn).toHaveBeenCalledTimes(1);
    f.command.next({ type: 'stdout', data: 'Sketch uses 123 bytes\n' });
    f.command.next({ type: 'close', code: 0 }); f.command.complete();
    await pending;
    expect(f.service.passed).toBeTrue();
    expect(JSON.parse(f.files.get('/project/.log/compile/latest-result.json')!)).toEqual(jasmine.objectContaining({ success: true, source: 'manual' }));
    expect(local).toBeFalse(); expect(owners).toBe(0);
    expect(f.service.configService.getCompileBackend()).toBe('cloud');
    expect(f.service.npmService.prepareLocalCompileBackend).toHaveBeenCalledTimes(1);
  });

  it('publishes changed generator macros and reaches the compiler on the first build', async () => {
    const f = compileFixture(), { result } = await f.start();
    expect(f.service.cmdService.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.files.get('/project/package.json')!).MACROS).toEqual([['WIDTH=320']]);
    expect(f.service.writeCompileRequest.calls.mostRecent().args[0].projectMacros).toEqual([{ name: 'WIDTH', value: 'WIDTH=320' }]);
    f.command.next({ type: 'stdout', data: 'Sketch uses 123 bytes\n' });
    f.command.next({ type: 'close', code: 0 }); f.command.complete();
    expect((await result).state).toBe('done'); expect(f.service.passed).toBeTrue();
    expect(f.service.metrics.record.calls.allArgs()).toEqual([['compile_attempted'], ['build_succeeded']]);
  });

  it('keeps real board/configuration drift guarded during generator preparation', async () => {
    const f = compileFixture();
    f.service.runWithInteractiveProjectCode = async (_workspace: unknown, consume: any) => {
      f.files.set('/project/package.json', '{"name":"changed-target"}');
      return consume({ code: 'new', artifacts: null, revision: 1 }, () => {});
    };
    const { result } = await f.start();
    expect((await result).text).toContain('BUILD_SOURCE_STALE'); expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
  });

  it('guards macros again after publication while writing the compile request', async () => {
    const f = compileFixture();
    f.service.writeCompileRequest.and.callFake(async () => {
      const pkg = JSON.parse(f.files.get('/project/package.json')!); pkg.MACROS = [['WIDTH=480']];
      f.files.set('/project/package.json', JSON.stringify(pkg)); return '/request';
    });
    const { result } = await f.start();
    expect((await result).text).toContain('BUILD_SOURCE_STALE'); expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
  });

  it('does not accept success-looking output followed by failed post-build validation', async () => {
    const f = compileFixture(), { result } = await f.start();
    f.command.next({ type: 'stdout', data: 'Sketch uses 123 bytes\n' });
    f.command.next({ type: 'close', code: 1 }); f.command.complete();
    expect((await result).state).toBe('error'); expect(f.service.passed).toBeFalse();
    expect(f.service.metrics.record.calls.allArgs()).toEqual([['compile_attempted']]);
  });

  it('rejects the completed compiler result when a Blockly edit supersedes its captured inputs', async () => {
    const f = compileFixture(), { result } = await f.start();
    f.service.blocklyService.captureBuildSnapshot = () => ({ revision: 2 });
    f.command.next({ type: 'close', code: 0 }); f.command.complete();
    expect(await result).toEqual(jasmine.objectContaining({ state: 'error', code: 'BUILD_SOURCE_STALE', sourceReason: 'blocks' }));
    expect(f.service.passed).toBeFalse();
    expect(f.service.metrics.record.calls.allArgs()).toEqual([['compile_attempted']]);
  });

  it('rejects a target without compilation capability before generating or capturing source', async () => {
    const f = compileFixture();
    f.service.projectService.isCloudBuild = () => true;
    f.service.configService.getCompileBackend = () => 'cloud';
    f.service.npmService = { prepareCompileBackend: async () => {}, ensureCloudLibrarySources: async () => {} };
    f.service.projectService.prepareCloudBoardForBuild.and.resolveTo({
      boardModule: '@aily-project/board-test', profileDigest: 'a'.repeat(64), capabilities: { compile: false },
    });
    const capture = spyOn(f.service, 'generateWorkspaceBuildSnapshotForPreprocess');
    const { result } = await f.start();
    expect((await result).code).toBe('CLOUD_COMPILE_UNSUPPORTED');
    expect(capture).not.toHaveBeenCalled();
    expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
    expect(f.service.projectService.prepareCloudBoardForBuild).toHaveBeenCalledTimes(1);
  });

  for (const metadataFailure of [false, true]) it(`restores cloud pins before capture and requires result metadata persistence (failure=${metadataFailure})`, async () => {
    const f = compileFixture();
    f.service.projectService.isCloudBuild = () => true;
    f.service.configService.getCompileBackend = () => 'cloud';
    f.service.npmService = { prepareCompileBackend: async () => {}, ensureCloudLibrarySources: async () => {} };
    let pinsRestored = false;
    const profile = { boardModule: '@aily-project/board-test', profileDigest: 'b'.repeat(64), capabilities: { compile: true } };
    f.service.projectService.prepareCloudBoardForBuild.and.callFake(async (board: any, assertCurrent: () => void) => {
      expect(board).toBe(f.service.projectService.currentBoardConfig);
      assertCurrent();
      pinsRestored = true;
      return profile;
    });
    const prepareSource = f.service.runWithInteractiveProjectCode;
    f.service.runWithInteractiveProjectCode = (...args: any[]) => {
      expect(pinsRestored).toBeTrue(); return prepareSource(...args);
    };
    f.service.runCloudCompilation = jasmine.createSpy('cloud').and.resolveTo({ state: 'done', text: 'cloud complete' });
    f.service.saveBuildInfo = jasmine.createSpy('saveBuildInfo').and.callFake(async () => {
      if (metadataFailure) throw new Error('metadata unavailable');
    });
    const { result } = await f.start();
    const completed = await result;
    expect(f.service.projectService.prepareCloudBoardForBuild).toHaveBeenCalledTimes(1);
    expect(f.service.runCloudCompilation.calls.mostRecent().args[3]).toBe(profile);
    expect(f.service.runCloudCompilation).toHaveBeenCalledTimes(1);
    expect(f.service.saveBuildInfo).toHaveBeenCalledOnceWith('/project', 'success', jasmine.any(String), 'hash', true);
    expect(completed.state).toBe(metadataFailure ? 'error' : 'done');
    expect(f.service.passed).toBe(!metadataFailure);
    expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
    if (metadataFailure) expect(completed.text).toBe('metadata unavailable');
  });

  for (const outcome of ['success', 'compile-error', 'prepare-error', 'cancel']) it(`retains the Blockly build request through local handoff: ${outcome}`, async () => {
    const f = compileFixture();
    const operation = { local: false, useLocal() { this.local = true; }, release: jasmine.createSpy('release') };
    f.service.projectService.beginBuildBackendOperation = () => operation;
    f.service.projectService.isCloudBuild = () => !operation.local;
    f.service.configService.getCompileBackend = () => 'cloud';
    f.service.npmService = { prepareCompileBackend: async () => {}, ensureCloudLibrarySources: async () => {},
      prepareLocalCompileBackend: async () => {
        expect(operation.local).toBeTrue();
        if (outcome === 'prepare-error') throw new Error('local SDK unavailable');
        if (outcome === 'cancel') { f.service.buildCancellation.abort(); throw new Error('cancelled'); }
      } };
    f.service.runCloudCompilation = jasmine.createSpy('cloud').and.rejectWith(Object.assign(new Error('local requested'), { code: CLOUD_BUILD_LOCAL_REQUESTED }));
    const { result } = await f.start();
    expect(f.service.runCloudCompilation).toHaveBeenCalledTimes(1);
    if (outcome === 'success' || outcome === 'compile-error') {
      expect(f.service.workflowService.finishBuild).not.toHaveBeenCalled();
      expect(operation.release).not.toHaveBeenCalled();
      f.command.next({ type: 'stdout', data: 'Sketch uses 123 bytes\n' });
      f.command.next({ type: 'close', code: outcome === 'success' ? 0 : 1 }); f.command.complete();
    } else expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
    const completed = await result;
    expect(completed.state).toBe(outcome === 'success' ? 'done' : outcome === 'cancel' ? 'warn' : 'error');
    expect(f.service.workflowService.finishBuild).toHaveBeenCalledTimes(1);
    expect(operation.release).toHaveBeenCalledTimes(1);
  });

  for (const stage of ['board-support', 'target-profile', 'target-unavailable', 'target-timeout', 'target-unreachable', 'cloud-run', 'changed', 'nested-upload', 'sdk-unsupported']) {
    it(`reports Blockly cloud failure without starting local compilation: ${stage}`, async () => {
      const f = compileFixture();
      const operation = { local: false, isNested: stage === 'nested-upload', useLocal() { this.local = true; }, release: jasmine.createSpy('release') };
      f.service.projectService.beginBuildBackendOperation = () => operation;
      f.service.projectService.isCloudBuild = () => !operation.local;
      f.service.configService.getCompileBackend = () => 'cloud';
      const offline = Object.assign(new Error('Gateway unavailable'), { code: 'gateway_closing', httpStatus: 503 });
      Object.assign(f.service.npmService, {
        prepareCompileBackend: async () => { if (stage === 'board-support') throw offline; },
        ensureCloudLibrarySources: async () => {},
        prepareLocalCompileBackend: jasmine.createSpy('prepareLocal').and.callFake(async () => {
          expect(operation.local).toBeTrue();
          expect(operation.release).not.toHaveBeenCalled();
        }),
      });
      if (stage === 'target-profile') f.service.projectService.prepareCloudBoardForBuild.and.rejectWith(offline);
      const connectionError = stage === 'target-timeout' ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNREACHABLE';
      if (stage === 'target-timeout' || stage === 'target-unreachable') {
        f.service.projectService.prepareCloudBoardForBuild.and.rejectWith(Object.assign(new Error('Gateway connection failed'), { code: connectionError }));
      }
      if (stage === 'target-unavailable') {
        f.service.projectService.prepareCloudBoardForBuild.and.rejectWith(Object.assign(new Error('No matching cloud target'), { code: 'CLOUD_TARGET_UNAVAILABLE' }));
      }
      f.service.runCloudCompilation = jasmine.createSpy('runCloud').and.callFake(async () => {
        if (stage === 'changed') {
          f.service.blocklyService.captureBuildSnapshot = () => ({ revision: 2 });
          throw Object.assign(new Error('Unsupported SDK'), { code: 'CI_RESOURCE_UNSUPPORTED', ciResourceReason: 'sdk-toolchain-unsupported' });
        }
        if (stage === 'sdk-unsupported') throw Object.assign(new Error('Unsupported SDK'), { code: 'CI_RESOURCE_UNSUPPORTED' });
        throw offline;
      });
      let guard: (() => void) | undefined;
      const { result } = await f.start('cloud-service-failure', { localFallback: {
        recordCloudFailure: (error: unknown, check: () => void) => { if (canOfferLocalBuildFallback(error)) guard = check; },
      } });
      expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
      expect(f.service.npmService.prepareLocalCompileBackend).not.toHaveBeenCalled();
      const completed = await result;
      expect(completed.state).toBe('error');
      expect(completed.buildLog.requestId).toBe('cloud-service-failure');
      if (['board-support', 'target-profile', 'target-unavailable', 'cloud-run'].includes(stage)) expect(guard).not.toThrow();
      else if (stage === 'changed') expect(guard).toThrowError(/canvas changed/);
      else expect(guard).toBeUndefined();
      if (['sdk-unsupported', 'target-unavailable', 'changed'].includes(stage)) {
        expect(completed.code).toBe(stage === 'target-unavailable' ? 'CLOUD_TARGET_UNAVAILABLE' : 'CI_RESOURCE_UNSUPPORTED');
        expect(completed.text).toBe('PROJECT.CLOUD_TARGET_UNAVAILABLE');
        expect(completed.fullStdErr).toContain(stage === 'target-unavailable' ? 'No matching cloud target' : 'Unsupported SDK');
      } else if (['board-support', 'target-profile', 'target-timeout', 'target-unreachable'].includes(stage)) {
        const connectionFailed = stage === 'target-timeout' || stage === 'target-unreachable';
        expect(completed.code).toBe(connectionFailed ? connectionError : offline.code);
        expect(completed.text).toBe('PROJECT.CLOUD_TARGET_UNAVAILABLE');
        expect(completed.fullStdErr).toContain(connectionFailed ? 'Gateway connection failed' : offline.message);
        expect(f.service.runCloudCompilation).not.toHaveBeenCalled();
      } else expect(completed.text).toBe(offline.message);
      expect(operation.release).toHaveBeenCalledTimes(1);
      expect(f.service.configService.getCompileBackend()).toBe('cloud');
    });
  }

  it('locally compiles Blockly after receiving a checked CI resource incompatibility receipt', async () => {
    const f = compileFixture();
    const operation = { local: false, isNested: false, useLocal() { this.local = true; }, release: jasmine.createSpy('release') };
    operation.release.and.callFake(() => { operation.local = false; });
    f.service.projectService.beginBuildBackendOperation = () => operation;
    f.service.projectService.isCloudBuild = () => !operation.local;
    f.service.configService.getCompileBackend = () => 'cloud';
    f.service.npmService.prepareCompileBackend = async () => {};
    f.service.npmService.ensureCloudLibrarySources = async () => {};
    f.service.npmService.prepareLocalCompileBackend = jasmine.createSpy('prepareLocal').and.resolveTo();
    const failure = Object.assign(new Error('Unsupported CI SDK version'), {
      code: 'CI_RESOURCE_UNSUPPORTED', ciResourceReason: 'sdk-toolchain-unsupported',
    });
    f.service.runCloudCompilation = jasmine.createSpy('runCloud').and.rejectWith(failure);
    const receipts = new ProjectBuildReceipts();
    const cloud = await receipts.start('/project', { version: 1, requestId: 'original-cloud', waitMs: 10_000 }, 'full', async localFallback => {
      const { result } = await f.start('original-cloud', { localFallback });
      const completed = await result;
      return { ok: completed.state === 'done', code: completed.code };
    });
    expect(cloud.result).toEqual({ ok: false, code: failure.code, localFallback: { fromRequestId: 'original-cloud' } });
    expect(f.service.npmService.prepareLocalCompileBackend).not.toHaveBeenCalled();

    const local = receipts.start('/project', { version: 1, requestId: 'explicit-local', waitMs: 10_000 }, 'full-local', async localFallback => {
      return { ok: (await f.service.build(undefined, 'explicit-local', {}, { localFallback })).state === 'done' };
    }, cloud.result?.['localFallback']?.fromRequestId);
    for (let n = 0; n < 100 && !f.service.cmdService.spawn.calls.count(); n++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(f.service.npmService.prepareLocalCompileBackend).toHaveBeenCalledTimes(1);
    expect(f.service.cmdService.spawn).toHaveBeenCalledTimes(1);
    f.command.next({ type: 'close', code: 0 }); f.command.complete();
    const completed = await local;
    expect(completed.result?.['ok']).toBeTrue();
    expect(completed.buildReceipt.requestId).toBe('explicit-local');
    const log = [...f.files.values()].find(value => value.includes('AI requested local compilation after cloud build original-cloud'));
    expect(log).toBeDefined();
    expect(f.service.runCloudCompilation).toHaveBeenCalledTimes(1);
    expect(f.service.projectService.isCloudBuild()).toBeTrue();
  });

  for (const ending of ['cloud', 'local', 'unsupported', 'outage', 'cancel']) it(`keeps the same Blockly caller through a cloud/local round trip ending in ${ending}`, async () => {
    const f = compileFixture();
    const operation = { local: false, useLocal() { this.local = true; }, useCloud() { this.local = false; }, release: jasmine.createSpy('release') };
    f.service.projectService.beginBuildBackendOperation = () => operation;
    f.service.projectService.isCloudBuild = () => !operation.local;
    f.service.configService.getCompileBackend = () => 'cloud';
    f.service.workflowService.currentState = ProcessState.BUILDING;
    f.service.workflowService.finishBuild.and.callFake((success: boolean) => {
      f.service.workflowService.currentState = success ? ProcessState.IDLE : ProcessState.ERROR;
    });
    f.service.ensureCancelState = () => {};
    const commands = [f.command, new Subject<any>()];
    let launches = 0, stopped!: (value: boolean) => void;
    f.service.cmdService.spawn.and.callFake(() => commands[launches++]);
    f.service.cmdService.kill = jasmine.createSpy('kill').and.returnValue(new Promise<boolean>(resolve => { stopped = resolve; }));
    Object.assign(f.service.projectService, {
      getProjectDependencySession: () => ({ projectPath: '/project' }), assertProjectDependencySession() {},
      resolveCompileBackend: async () => {
        if (ending === 'unsupported') throw Object.assign(new Error('Board no longer supports cloud builds'), { code: 'CLOUD_BOARD_UNSUPPORTED' });
        if (ending === 'outage') throw Object.assign(new Error('Cloud worker offline'), { code: 'CLOUD_BOARD_OFFLINE' });
        return 'cloud';
      },
    });
    f.service.npmService = Object.assign(Object.create(NpmService.prototype), {
      prjService: f.service.projectService, configService: { isCoderProduct: () => false },
      prepareCompileBackend: async () => {}, ensureCloudLibrarySources: async () => {},
      prepareLocalCompileBackend: async () => {},
      ensureLocalCompilerDependencies: async () => {},
    });
    let clouds = 0;
    f.service.runCloudCompilation = jasmine.createSpy('cloud').and.callFake(async () => {
      if (++clouds === 1 || ending === 'local') throw Object.assign(new Error('local requested'), { code: CLOUD_BUILD_LOCAL_REQUESTED });
      return { state: 'done', text: 'cloud completed' };
    });
    const { result } = await f.start();
    f.command.next({ type: 'stdout', data: 'compiling locally\n' });
    expect(f.service.localSwitchAction).toEqual(jasmine.any(Function));
    f.service.localSwitchAction();
    expect(f.service.workflowService.finishBuild).not.toHaveBeenCalled(); expect(operation.release).not.toHaveBeenCalled();
    if (ending === 'cancel') f.service.cancel();
    f.command.complete();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.service.runCloudCompilation).toHaveBeenCalledTimes(1);
    expect(operation.release).not.toHaveBeenCalled();
    stopped(true);
    if (ending === 'local') {
      for (let n = 0; n < 100 && launches < 2; n++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(launches).toBe(2);
      commands[1].next({ type: 'stdout', data: 'Sketch uses 123 bytes\n' });
      commands[1].next({ type: 'close', code: 0 }); commands[1].complete();
    }
    const completed = await result;
    expect(completed.state).toBe(ending === 'cancel' ? 'warn' : ['unsupported', 'outage'].includes(ending) ? 'error' : 'done');
    expect(f.service.metrics.record.calls.allArgs()).toEqual(['cancel', 'unsupported', 'outage'].includes(ending)
      ? [['compile_attempted']] : [['compile_attempted'], ['build_succeeded']]);
    if (ending === 'unsupported') {
      expect(completed.code).toBe('CLOUD_BOARD_UNSUPPORTED');
      expect(completed.text).toBe('PROJECT.CLOUD_TARGET_UNAVAILABLE');
      expect(completed.fullStdErr).toContain('Board no longer supports cloud builds');
      expect(launches).toBe(1);
      expect(operation.local).toBeFalse();
      expect(f.service.localSwitchAction).toBeUndefined();
    }
    expect(clouds).toBe(['cancel', 'unsupported', 'outage'].includes(ending) ? 1 : 2);
    expect(f.service.workflowService.finishBuild).toHaveBeenCalledTimes(1);
    expect(operation.release).toHaveBeenCalledTimes(1);
  });

  it('does not offer cloud compilation to a task that started locally', async () => {
    const f = compileFixture(), notices: any[] = [];
    f.service.noticeService.update = (notice: any) => notices.push(notice);
    const { result } = await f.start();
    f.command.next({ type: 'stdout', data: 'Sketch uses 123 bytes\n' });
    f.command.next({ type: 'close', code: 0 }); f.command.complete(); await result;
    expect(notices.some(notice => notice.onSwitchToCloud)).toBeFalse();
  });

});
