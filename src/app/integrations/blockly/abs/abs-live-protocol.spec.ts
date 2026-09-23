import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { rejectAbsLiveRequest, rejectAbsRuntime } from './abs-live-protocol';
import { readAbsSyntax } from './abs-syntax';

describe('ABS live protocol admission', () => {
  const fingerprint = 'a'.repeat(64), hash = `sha256:${fingerprint}`;
  function request() {
    const validation = { version: 2, requestId: '01234567-89ab-cdef',
      base: { generation: 'base', scope: { projectKey: '/a', pageId: 'main' }, abiHash: hash, absHash: hash, mapHash: hash },
      candidate: { hash, bytes: 20 }, workspaceRevision: 1, libraryRuntimeFingerprint: fingerprint,
      validation: { ok: true, scope: 'prepared-generation' } };
    return { version: 2, requestId: validation.requestId, validation, abs: '# ABS Schema: 2\ntext("test")' };
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

  for (const current of [null, 'b'.repeat(64)]) {
    it(`distinguishes runtime ${current ? 'change' : 'unavailability'} without reading or applying ABS`, async () => {
      const service = bridge(); service.projectService.getBlocklyLibraryRuntimeFingerprint.and.resolveTo(current);
      const result = await service.execute({ operation: 'abs_apply', params: request() });
      expect(result.code).toBe(current ? 'ABS_RUNTIME_CONTRACT_STALE' : 'ABS_RUNTIME_NOT_READY');
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
    expect(service.absGenerationTools.execute).toHaveBeenCalledOnceWith('abs_apply', params, params.abs, jasmine.any(Function));
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
