import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { rejectAbsLiveRequest, rejectAbsRuntime } from './abs-live-protocol';
import { readAbsSyntax } from './abs-syntax';

describe('ABS live protocol admission', () => {
  const fingerprint = 'a'.repeat(64), hash = `sha256:${fingerprint}`;
  function request() {
    const workingCandidate = { version: 1 as const, id: '11111111-1111-1111-1111-111111111111', revisionHash: fingerprint };
    const validation = { version: 2, requestId: '01234567-89ab-cdef',
      base: { generation: 'base', scope: { projectKey: '/a', pageId: 'main' }, abiHash: hash, absHash: hash, mapHash: hash },
      candidate: { hash, bytes: 20 }, workingCandidate, workspaceRevision: 1, libraryRuntimeFingerprint: fingerprint,
      validation: { ok: true, scope: 'prepared-generation' } };
    return { version: 2, requestId: validation.requestId, workingCandidate, validation, abs: '# ABS Schema: 2\ntext("test")' };
  }
  function bridge() {
    const service: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    service.projectService = { currentProjectPath: '/a',
      isProjectTransitionInProgress: jasmine.createSpy('transition').and.returnValue(false),
      ensureBlocklyLibraryRuntimeReady: jasmine.createSpy('runtimeLoad').and.resolveTo(),
      getBlocklyLibraryRuntimeFingerprint: jasmine.createSpy('fingerprint').and.resolveTo(fingerprint) };
    service.aiOperations = { setActive: jasmine.createSpy('ownership') };
    service.electronService = { readFile: jasmine.createSpy('readFile') };
    service.absGenerationTools = { execute: jasmine.createSpy('publish').and.resolveTo({ ok: true }) };
    service.ngZone = { runOutsideAngular: (fn: () => unknown) => fn() };
    service.emitLiveOperationProgress = jasmine.createSpy('progress');
    service.readAbsSource = jasmine.createSpy('source').and.returnValue(request().abs);
    service.executeOperation = (payload: any) => service.executeAbsApply(payload.params);
    // Exercise native wire admission after the transport's publication owner
    // has been admitted, without mocking the unrelated outer UI owner scope.
    service.execute = (payload: any) => service.executeAdmittedOperation(payload);
    return service;
  }

  for (const scenario of [
    { name: 'old protocol', input: () => ({}), code: 'ABS_PROTOCOL_REQUIRED' },
    { name: 'invalid request id', input: () => ({ ...request(), requestId: '' }), code: 'ABS_REQUEST_INVALID' },
    { name: 'missing receipt', input: () => ({ ...request(), validation: undefined }), reason: 'missing-validation-receipt' },
    { name: 'empty receipt', input: () => ({ ...request(), validation: {} }), reason: 'invalid-validation-receipt' },
    { name: 'old receipt', input: () => { const r: any = request(); r.validation.version = 1; return r; }, reason: 'invalid-validation-receipt' },
    { name: 'mismatched request', input: () => { const r = request(); r.validation.requestId += '-other'; return r; }, reason: 'invalid-validation-receipt' },
    { name: 'missing fingerprint', input: () => { const r: any = request(); delete r.validation.libraryRuntimeFingerprint; return r; }, reason: 'invalid-runtime-fingerprint' },
    { name: 'invalid fingerprint', input: () => { const r = request(); r.validation.libraryRuntimeFingerprint = ''; return r; }, reason: 'invalid-runtime-fingerprint' },
    { name: 'empty source', input: () => ({ ...request(), abs: '  ' }), reason: 'invalid-abs-source' },
    { name: 'ambiguous source', input: () => ({ ...request(), absPath: '/draft.abs' }), reason: 'invalid-abs-source' },
  ]) {
    it(`rejects ${scenario.name} before any lifecycle, source or runtime action`, async () => {
      const service = bridge();
      const result = await service.execute({ operation: 'abs_apply', params: scenario.input() });
      expect(result.code).toBe(scenario.code ?? 'ABS_REQUEST_INVALID');
      if (scenario.reason) expect(result.diagnostic.reason).toBe(scenario.reason);
      expect(result.publication.status).toBe('NOT_COMMITTED');
      expect(service.projectService.isProjectTransitionInProgress).not.toHaveBeenCalled();
      expect(service.projectService.getBlocklyLibraryRuntimeFingerprint).not.toHaveBeenCalled();
      expect(service.projectService.ensureBlocklyLibraryRuntimeReady).not.toHaveBeenCalled();
      expect(service.aiOperations.setActive).not.toHaveBeenCalled();
      expect(service.readAbsSource).not.toHaveBeenCalled();
      expect(service.absGenerationTools.execute).not.toHaveBeenCalled();
    });
  }

  for (const operation of ['abi_add', 'abi_delete', 'abi_connect', 'abi_set_field', 'abi_move', 'abs_validate', 'abs_projection', 'abs_recovery']) {
    it(`rejects obsolete ${operation} before accessing the project`, async () => {
      const service = bridge();
      const result = await service.execute({ operation, params: {} });
      expect(result.code).toBe('ABS_PROTOCOL_REQUIRED');
      expect(result.publication.status).toBe('NOT_COMMITTED');
      expect(service.aiOperations.setActive).not.toHaveBeenCalled();
      expect(service.absGenerationTools.execute).not.toHaveBeenCalled();
    });
  }

  it('does not mistake block capability query version 1 for an obsolete generation request', () => {
    expect(rejectAbsLiveRequest('abs_capabilities', { version: 1, type: 'text' })).toBeNull();
    expect(rejectAbsLiveRequest('project_save', {})).toBeNull();
  });

  it('routes start, observation and explicit Stop with the same bound recovery request ID', () => {
    const requestId = 'call_af82707268bf40a6b25f9b45';
    for (const action of [
      { action: 'recover_project' },
      { action: 'recover_project', observe: true },
      { action: 'cancel_project' },
    ]) {
      expect(rejectAbsLiveRequest('abs_recovery', { version: 2, requestId, ...action })).toBeNull();
      expect(rejectAbsLiveRequest('abs_recovery', { version: 2, requestId: '../other', ...action })?.code)
        .toBe('ABS_REQUEST_INVALID');
      expect(rejectAbsLiveRequest('abs_recovery', { version: 1, requestId, ...action })?.code)
        .toBe('ABS_PROTOCOL_REQUIRED');
    }
    expect(rejectAbsLiveRequest('abs_apply', { ...request(), requestId })?.code).toBe('ABS_REQUEST_INVALID');
  });

  it('allows only the exact current Blockly attachment to request empty lock maintenance', async () => {
    const service = bridge();
    service.executeOperation = BlocklyLiveOperationBridgeService.prototype['executeOperation'];
    service.projectService.projectViewRevision = 1;
    service.projectService.captureCurrentProjectGuard = () => () => true;
    service.projectService.getProjectMode = () => 'blockly';
    service.electronService.currentRendererGeneration = 1;
    const project = '/a', attachment = { version: 1, root: project, identity: { dev: '1', ino: '2', birthtimeNs: '3' } };
    const identity = { version: 2, action: 'retire_empty_project_lock', requestId: 'retire-lock-wire-proof' };
    const marker = { ino: '4', birthtimeNs: '5' };
    const params = { ...identity, attachment, marker };
    const retire = jasmine.createSpy('retire').and.resolveTo({ ok: true, value: true });
    const open = jasmine.createSpy('open').and.resolveTo({ attachment, read() {}, withLock() { throw new Error('Unexpected writer'); },
      retireEmptyProjectFileLockResult: retire });
    const saved = { path: window['path'], fs: window['fs'] };
    try {
      window['path'] = { isAbsolute: (value: string) => value.startsWith('/') };
      window['fs'] = { projectSyncStorageVersion: 2, openProjectSyncStorage: open };
      const call = (fields: Record<string, unknown> = {}) => service.execute({ operation: 'abs_recovery', path: project,
        rendererGeneration: 1, originalAdmissionAttachment: attachment, params, ...fields });
      expect((await call({ params: { ...params, observe: true } })).code).toBe('ABS_REQUEST_INVALID');
      expect((await call({ params: identity })).code).toBe('ABS_REQUEST_INVALID');
      expect((await call({ path: 'relative' })).code).toBe('ABS_REQUEST_INVALID');
      expect((await call({ originalAdmissionAttachment: undefined })).code).toBe('PROJECT_ADMISSION_CONTEXT_STALE');
      expect((await call({ originalAdmissionAttachment: { ...attachment, identity: { ...attachment.identity, ino: '9' } } })).code)
        .toBe('PROJECT_ADMISSION_CONTEXT_STALE');
      expect(retire).not.toHaveBeenCalled();
      const result = await call();
      expect(result).toEqual({ ok: true, operation: 'abs_recovery', project, receipt: identity, retired: true });
      expect(retire).toHaveBeenCalledTimes(1);
      expect(retire).toHaveBeenCalledWith({ attachment, marker });
      open.and.callFake(async () => {
        service.projectService.projectViewRevision = 2;
        return { attachment, read() {}, withLock() {}, retireEmptyProjectFileLockResult: retire };
      });
      expect((await call()).code).toBe('PROJECT_ADMISSION_CONTEXT_STALE');
      expect(retire).toHaveBeenCalledTimes(1);
    } finally {
      window['path'] = saved.path;
      window['fs'] = saved.fs;
    }
  });

  it('only passes a complete lock proof from its original current physical project to storage', async () => {
    const service = bridge();
    service.executeOperation = BlocklyLiveOperationBridgeService.prototype['executeOperation'];
    service.projectService.projectViewRevision = 1;
    service.projectService.captureCurrentProjectGuard = () => () => true;
    service.projectService.getProjectMode = () => 'blockly';
    service.electronService.currentRendererGeneration = 1;
    const project = '/a', attachment = { version: 1, root: project, identity: { dev: '1', ino: '2', birthtimeNs: '3' } };
    const identity = { version: 2, action: 'retire_project_file_lock', requestId: 'retire-lock-wire-proof' };
    const marker = { token: '00000000-0000-4000-8000-000000000abc', sha256: 'sha256:' + '1'.repeat(64), ino: '4', birthtimeNs: '5' };
    const params = { ...identity, attachment, marker };
    const retire = jasmine.createSpy('retire').and.resolveTo({ ok: true, value: true });
    const open = jasmine.createSpy('open').and.resolveTo({ attachment, read() {}, withLock() { throw new Error('Unexpected writer'); },
      retireProjectFileLockResult: retire });
    const saved = { path: window['path'], fs: window['fs'] };
    try {
      window['path'] = { isAbsolute: (value: string) => value.startsWith('/') };
      window['fs'] = { projectSyncStorageVersion: 2, openProjectSyncStorage: open };
      const call = (fields: Record<string, unknown> = {}) => service.execute({ operation: 'abs_recovery', path: project,
        rendererGeneration: 1, originalAdmissionAttachment: attachment, params, ...fields });
      expect((await call({ params: identity })).code).toBe('ABS_REQUEST_INVALID');
      expect((await call({ originalAdmissionAttachment: undefined })).code).toBe('PROJECT_ADMISSION_CONTEXT_STALE');
      expect((await call({ params: { ...params, attachment: { ...attachment, identity: { ...attachment.identity, ino: '9' } } } })).code)
        .toBe('PROJECT_ADMISSION_CONTEXT_STALE');
      expect(retire).not.toHaveBeenCalled();
      expect(await call()).toEqual({ ok: true, operation: 'abs_recovery', project, receipt: identity, retired: true });
      expect(retire).toHaveBeenCalledOnceWith({ attachment, marker });
    } finally {
      window['path'] = saved.path;
      window['fs'] = saved.fs;
    }
  });

  it('retires base-only apply and old baseline mutations before touching the coordinator', async () => {
    const service = bridge(), old: any = request();
    delete old.workingCandidate; delete old.validation.workingCandidate;
    const result = await service.execute({ operation: 'abs_apply', params: old });
    expect(result.code).toBe('ABS_PROTOCOL_REQUIRED');
    expect(service.aiOperations.setActive).not.toHaveBeenCalled();
    expect(service.readAbsSource).not.toHaveBeenCalled();
    expect(service.absGenerationTools.execute).not.toHaveBeenCalled();
    for (const action of ['preserve_candidate', 'repair', 'refresh', 'resolve', 'reopen', 'prepare_native', 'abandon']) {
      const rejected = rejectAbsLiveRequest('abs_recovery', { version: 2, requestId: old.requestId, action });
      expect(rejected!.code).toBe('ABS_PROTOCOL_REQUIRED');
    }
    for (const action of ['inspect', 'read_candidate', 'read_repair', 'read_draft', 'recover_runtime', 'recover'])
      expect(rejectAbsLiveRequest('abs_recovery', { version: 2, requestId: old.requestId, action })).toBeNull();
  });

  it('identifies an obsolete MCP caller separately from the ABS source schema', () => {
    for (const version of [undefined, 1, '2', false, { version: 2 }]) {
      const result = rejectAbsLiveRequest('abs_validate', { version, abs: '# ABS Schema: 2\ntext("draft")' });
      expect(result!.code).toBe('ABS_PROTOCOL_REQUIRED');
      expect(result!.diagnostic!.reason).toBe('generation-protocol-version');
      expect(result!.diagnostic!.field).toBe('version');
      expect(result!.diagnostic!.allowedValues).toEqual([2]);
      expect(result!.diagnostic!.received).toBe(typeof version === 'object' || version === undefined ? null : version);
      expect(result!.publication.status).toBe('NOT_COMMITTED');
      expect(result!.recovery).toContain('MCP service');
      expect(result!.recovery).toContain('Restarting Blockly alone');
      expect(result!.message).toContain('not an ABS source syntax error');
    }
  });

  for (const current of [null, 'b'.repeat(64)]) {
    it(`distinguishes runtime ${current ? 'change' : 'unavailability'} without reading or applying ABS`, async () => {
      const service = bridge(); service.projectService.getBlocklyLibraryRuntimeFingerprint.and.resolveTo(current);
      const result = await service.execute({ operation: 'abs_apply', params: request() });
      expect(result.code).toBe(current ? 'ABS_RUNTIME_CONTRACT_STALE' : 'ABS_RUNTIME_NOT_READY');
      expect(result.application.status).toBe('NOT_STARTED');
      expect(result.publication.status).toBe('NOT_COMMITTED');
      expect(service.readAbsSource).not.toHaveBeenCalled();
      expect(service.absGenerationTools.execute).not.toHaveBeenCalled();
      expect(service.projectService.ensureBlocklyLibraryRuntimeReady).not.toHaveBeenCalled();
      expect(service.aiOperations.setActive.calls.mostRecent().args[1]).toBeFalse();
    });
  }

  it('passes a valid candidate to the existing publisher exactly once without rebuilding the runtime', async () => {
    const service = bridge(), params = request();
    expect((await service.execute({ operation: 'abs_apply', params })).ok).toBeTrue();
    expect(service.absGenerationTools.execute).toHaveBeenCalledOnceWith('abs_apply', params, params.abs, jasmine.any(Function),
      undefined, undefined, { markApplyWriter: undefined });
    expect(service.projectService.ensureBlocklyLibraryRuntimeReady).not.toHaveBeenCalled();
    expect(rejectAbsRuntime('abs_validate', fingerprint, fingerprint)).toBeNull();
  });

  it('input I/O failure before publication is not an uncertain commit', async () => {
    const service = bridge(); service.readAbsSource.and.throwError('Candidate file no longer exists');
    const result = await service.execute({ operation: 'abs_apply', params: request() });
    expect(result.publication.status).toBe('NOT_COMMITTED');
    expect(result.message).toContain('file no longer exists');
    expect(service.absGenerationTools.execute).not.toHaveBeenCalled();
  });

  it('the shared wire adapter rejects an invalid receipt as not committed without entering the coordinator', async () => {
    const sync = { applyGeneration: jasmine.createSpy('apply') };
    const result: any = await new AbsGenerationToolsService(sync as any).execute('abs_apply',
      { ...request(), validation: {} }, request().abs);
    expect(result.code).toBe('ABS_REQUEST_INVALID');
    expect(result.publication.status).toBe('NOT_COMMITTED');
    expect(sync.applyGeneration).not.toHaveBeenCalled();
  });

  it('diagnoses the text schema separately and preserves the old draft', () => {
    const source = '# Project Data Schema: 1 (external-only)\ntext("old draft")';
    try { readAbsSyntax(source); fail('expected schema rejection'); }
    catch (error) {
      expect((error as any).code).toBe('ABS_SCHEMA_UNSUPPORTED');
      expect((error as any).diagnostic.reason).toBe('abs-schema-header');
      expect((error as any).diagnostic.hint).toContain('Retain');
    }
  });
});
