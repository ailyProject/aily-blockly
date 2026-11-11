import { AbsPrecheckFailure } from './abs-precheck';
import { AbsComposeFailure } from './abs-compose';
import { Injectable } from '@angular/core';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';
import { assertGenerationCandidate, assertGenerationRequest, readGenerationApplyValidation } from './abs-generation-protocol';
import { AbsSyncError } from './abs-state';
import { absJson } from './abs-identity-map';
import { serializeAbsFailure } from './abs-diagnostics';
import { AbsApplicationFailure } from './abs-application-failure';
import { AbsCandidateJournal, assertCandidateArchiveRequest } from './abs-candidate-journal';
import { openAbsHostStorage } from './abs-host-storage';
import { rejectAbsLiveRequest } from './abs-live-protocol';
import type { MediaImportTarget } from '../project-media-target';

/** Wire adaptation only. Preparation, leases, publication and recovery belong to the coordinator. */
@Injectable({ providedIn: 'root' })
export class AbsGenerationToolsService {
  constructor(private readonly sync: AbsWorkspaceSyncService) {}

  capabilities(input: Record<string, any>) { return this.sync.describeCapabilities(input); }
  captureMediaImportTarget(target: MediaImportTarget) { return this.sync.captureMediaImportTarget(target); }
  observeApplication(requestId: string) { return this.sync.observeApplication(requestId); }

  async candidateBackup(project: string, input: Record<string, any>, assertCurrent: () => void) {
    try {
      assertGenerationRequest(input); assertCandidateArchiveRequest(input); assertCurrent();
      const journal = new AbsCandidateJournal(await openAbsHostStorage(project, assertCurrent), project, assertCurrent);
      const result = await journal.read(input['recordHash']);
      return { ok: true, operation: 'abs_recovery', project, candidateApplied: false, ...result,
        receipt: { version: 2, requestId: input['requestId'], action: input['action'], candidateApplied: false } };
    } catch (error) { return { ok: false, operation: 'abs_recovery', project, candidateApplied: false, ...serializeAbsFailure(error) }; }
  }

  assertNativeRecoveryCurrent(input: Record<string, any>) {
    this.sync.assertNativeRecoveryCurrent(input['token'], input['requestId']);
  }

  assertNativeRecoveryRequest(input: Record<string, any>) {
    this.sync.assertNativeRecoveryRequest(input['token'], input['requestId']);
  }

  async blockState(input: Record<string, unknown>) {
    try { return { ...await this.sync.setBlockState(input), operation: 'blocks_set_state' }; }
    catch (error) {
      return { ok: false, operation: 'blocks_set_state', ...serializeAbsFailure(error),
        ...(error instanceof AbsApplicationFailure ? { publication: { status: 'NOT_COMMITTED' },
          application: { status: error.applicationStatus } } : {}),
        ...((error as any)?.publication ? { publication: (error as any).publication } : {}),
        ...((error as any)?.application ? { application: (error as any).application } : {}),
        ...((error as any)?.projectSaved !== undefined ? { projectSaved: (error as any).projectSaved,
          generatedCodePublished: (error as any).generatedCodePublished === true, partial: (error as any).partial === true } : {}) };
    }
  }

  authoring(operation: 'abs_compose' | 'abs_precheck', input: Record<string, any>) {
    try { return this.sync.authoring(operation, input); }
    catch (error) {
      return { ok: false, operation, ...serializeAbsFailure(error),
        ...(error instanceof AbsComposeFailure ? { composeDiagnostics: error.composeDiagnostics } : {}) };
    }
  }

  async execute(operation: string, input: Record<string, any>, source?: string, onProgress?: (blocks: number, batches: number) => void,
    activateRecovery?: (path: string, assertCurrent: () => void) => Promise<{ project: string; activated: boolean }>, requestedProject?: string,
    archiveContext?: { project: string; assertCurrent: () => void; prepareRuntime?: () => Promise<void> }) {
    const rejected = rejectAbsLiveRequest(operation, input);
    if (rejected) return rejected;
    let applyStarted = false;
    try {
      const { abs, absPath, ...wire } = input;
      let params: Record<string, any> = JSON.parse(absJson(wire));
      assertGenerationRequest(params);
      if (operation === 'abs_recovery') {
        const reply = { operation, receipt: { version: 2, requestId: params.requestId, action: params['action'] } };
        if (params['action'] === 'candidate_capture') return { ...reply, ok: true, candidateApplied: false,
          capture: await this.sync.captureWorkingCandidate() };
        if (params['action'] === 'candidate_legacy_capture') return { ...reply, ok: true, candidateApplied: false,
          capture: await this.sync.captureLegacyCandidate(params['legacy']) };
        if (params['originalTargetPid'] !== undefined
          && (!Number.isSafeInteger(params['originalTargetPid']) || params['originalTargetPid'] < 1)) {
          throw new AbsSyncError('ABS_REQUEST_INVALID', 'Original executor PID must identify a positive process.');
        }
        if (params['action'] === 'history_inspect') return { ...reply, ...await this.sync.inspectHistoryProgram() };
        if (params['action'] === 'restore_program_map') return { ...reply, ...await this.sync.restoreProgramMap(params['observation']) };
        if (params['action'] === 'history_publish') return { ...reply, ...await this.sync.publishHistoryProgram(params) };
        if (params['action'] === 'history_observe') return { ...reply, ...await this.sync.observeHistoryProgram(params, params['originalTargetPid']) };
        if (params['action'] === 'observe_state') return { ...reply, ...await this.sync.observeBlockState(params['state'], params['originalTargetPid']) };
        if (params['action'] === 'history_begin') return { ...reply, ok: true, ...await this.sync.beginHistoryNavigation() };
        if (['history_seal', 'history_release'].includes(params['action']) && typeof params['token'] === 'string') {
          if (params['action'] === 'history_seal') await this.sync.sealHistoryNavigation(params['token']);
          else this.sync.releaseHistoryNavigation(params['token']);
          return { ...reply, ok: true };
        }
        if (params['action'] === 'inspect') {
          const runtimeRecovery = await this.sync.inspectLibraryRuntimeRecovery?.();
          if (runtimeRecovery && !runtimeRecovery.ready) return { ...reply, ok: true, project: runtimeRecovery.project, pending: null,
            diagnostics: { runtimeRecovery }, requiresReload: false };
          return { ...reply, ok: true, ...await this.sync.inspectGeneration(), requiresReload: false };
        }
        if (params['action'] === 'recover_runtime' && typeof params['token'] === 'string'
          && /^sha256:[a-f0-9]{64}$/.test(params['token'])
          && (params['observe'] === undefined || typeof params['observe'] === 'boolean')
          && params['authority'] === undefined && params['generation'] === undefined) {
          const result = await this.sync.recoverLibraryRuntime(params['token'], params.requestId, params['observe'] === true);
          const receipt = { ...reply.receipt, token: params['token'], candidateApplied: false,
            ...(params['observe'] === true ? { observe: true } : {}) };
          if (result.status === 'completed' && result.value) return {
            ...reply, ok: true, project: result.value.project, recoveryState: result.status, requiresReload: false,
            runtimeRecovery: result.value, receipt, runtimeRecoveredNow: result.freshCompletion === true,
          };
          return { ...reply, ok: false, project: result.value?.project ?? requestedProject,
            recoveryState: result.status, requiresReload: false, receipt,
            ...(result.value ? { runtimeRecovery: result.value } : {}),
            ...(result.failure ?? result.value?.failure ?? { code: result.status === 'running' ? 'PROJECT_RUNTIME_RECOVERY_PENDING' : 'PROJECT_RUNTIME_RECOVERY_STALE',
              message: 'Observe the exact original runtime recovery; no ABS candidate was applied.' }),
          };
        }
        if (params['action'] === 'prepare_native' && typeof params['token'] === 'string'
          && /^sha256:[a-f0-9]{64}$/.test(params['token'])
          && (params['observe'] === undefined || typeof params['observe'] === 'boolean')
          && params['authority'] === undefined && params['generation'] === undefined) {
          const result = await this.sync.prepareNativeCandidate(params['token'], params.requestId, params['observe'] === true);
          const receipt = { ...reply.receipt, token: params['token'], candidateApplied: false,
            ...(params['observe'] === true ? { observe: true } : {}) };
          if (result.status === 'completed' && result.value) {
            return { ...reply, ok: true, recoveryState: result.status, requiresReload: false,
              project: result.value.base.scope.projectKey,
              receipt: { ...receipt, prepared: { ...result.value, validation: { ok: true, scope: 'prepared-generation' } } } };
          }
          const nativeFailure = await this.sync.describeNativeCandidateFailure();
          return { ...reply, ok: false, recoveryState: result.status, requiresReload: false, receipt,
            ...(result.failure ?? { code: result.status === 'running' ? 'ABS_NATIVE_RECOVERY_PENDING' : 'ABS_NATIVE_RECOVERY_STALE',
              message: 'Observe this exact recovery request; no candidate was applied.' }),
            ...(nativeFailure ? { nativeCandidateFailure: nativeFailure } : {}) };
        }
        if (params['action'] === 'resolve' && ['keep_view', 'replace_view'].includes(params['choice'])
          && typeof params['token'] === 'string' && /^sha256:[a-f0-9]{64}$/.test(params['token'])
          && (params['observe'] === undefined || typeof params['observe'] === 'boolean')
          && params['authority'] === undefined && params['generation'] === undefined) {
          const result = await this.sync.resolveViewConflict(params['choice'], params['token'], params['observe'] === true);
          const ok = result.publication.status === 'COMMITTED' && !result.requiresReload && !!result.evidence && !!result.recoveryArchive;
          return { ...reply, ...result, ok, project: result.evidence?.binding.scope.projectKey ?? requestedProject,
            receipt: { ...reply.receipt, token: params['token'], choice: params['choice'],
              ...(params['observe'] === true ? { observe: true } : {}),
              source: { kind: params['choice'] === 'keep_view' ? 'workspace' : 'saved-abi', abiHash: result.inputAbiHash },
              inputAbiHash: result.inputAbiHash, output: result.evidence, recoveryArchive: result.recoveryArchive,
              candidateApplied: false } };
        }
        if (params['action'] === 'read_repair' && typeof params['generation'] === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(params['generation'])) {
          return { ...reply, ok: true, ...await this.sync.readRepair(params['generation']), requiresReload: false };
        }
        if (params['action'] === 'read_draft' && typeof params['generation'] === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(params['generation'])) {
          return { ...reply, ok: true, draft: await this.sync.readArchivedDraft(params['generation']), requiresReload: false };
        }
        if (params['action'] === 'recover') {
          const publication = await this.sync.recoverGeneration(params['generation'], params['token']);
          return { ...reply, ok: !publication || publication.status === 'COMMITTED' || publication.status === 'NOT_COMMITTED',
            publication, requiresReload: publication !== null,
            ...(params['token'] !== undefined ? { receipt: { ...reply.receipt,
              journal: { action: 'recover', token: params['token'], generation: params['generation'] } } } : {}) };
        }
        throw new AbsSyncError('ABS_REQUEST_INVALID', 'Inspect or read the exact retained record. Recovery uses the current automatic project recovery path.');
      }
      if (typeof source !== 'string' || !source.trim()) throw new AbsSyncError('ABS_REQUEST_INVALID', 'Candidate source is empty.');
      if (operation === 'abs_validate') {
        assertGenerationCandidate(params);
        if (params['workingCandidate']) params = await this.sync.bindWorkingCandidate(source, params as any);
        if (archiveContext) {
          await archiveContext.prepareRuntime?.();
          archiveContext.assertCurrent();
        }
        const { syntaxAdvice, ...prepared } = await this.sync.validateGeneration(source, params as any);
        return { ok: true, operation, project: prepared.base.scope.projectKey, syntaxAdvice,
          receipt: { ...prepared, validation: { ok: true, scope: 'prepared-generation' } } };
      }
      if (operation !== 'abs_apply') throw new AbsSyncError('ABS_REQUEST_INVALID', 'Unknown ABS generation operation.');
      const validation = readGenerationApplyValidation(params);
      applyStarted = true;
      const result = await this.sync.applyGeneration(source, validation.base.generation, { chunk: params['chunk'] === true, onProgress }, validation);
      const ok = result.publication.status === 'COMMITTED' && !result.requiresReload && result.appliedRevision !== undefined && !!result.evidence;
      return { ...result, ok, operation, project: validation.base.scope.projectKey,
        ...(ok ? { receipt: { ...validation, output: result.evidence,
          ...(result.historyBase ? { historyBase: { hash: result.historyBase.hash, inputAbsHash: result.historyBase.inputAbsHash } } : {}),
          appliedRevision: result.appliedRevision, validation: { ok: true, scope: 'complete-generation' } } } : {}) };
    } catch (error) {
      if (typeof (error as any)?.code === 'string' && /^LIBRARY_/.test((error as any).code)) throw error;
      const failure = serializeAbsFailure(error);
      const nativeFailure = ['abs_validate', 'abs_apply'].includes(operation) && /^ABS_(NATIVE_|RUNTIME_|GENERATION_FAILED$)/.test(failure.code)
        ? await this.sync.describeNativeCandidateFailure(source) : undefined;
      return { ok: false, operation, ...failure,
        ...(nativeFailure ? { nativeCandidateFailure: nativeFailure } : {}),
        ...(operation === 'abs_recovery' && input['action'] === 'resolve' ? {
          ...(requestedProject ? { project: requestedProject } : {}),
          publication: { status: error instanceof AbsApplicationFailure && input['observe'] !== true ? 'NOT_COMMITTED' : 'UNKNOWN' },
          ...(error instanceof AbsApplicationFailure ? { application: { status: error.applicationStatus } } : {}),
          receipt: { version: 2, requestId: input['requestId'], action: 'resolve', token: input['token'], choice: input['choice'],
            ...(input['observe'] === true ? { observe: true } : {}) },
          requiresReload: false, observation: { resultKnown: error instanceof AbsApplicationFailure, operationCancelled: false },
        } : {}),
        ...(operation === 'abs_recovery' && ['ABS_REPAIR_OUTCOME_UNKNOWN', 'ABS_JOURNAL_REOPEN_UNKNOWN'].includes(failure.code) ? {
          publication: { status: 'UNKNOWN' }, requiresReload: false,
          observation: { resultKnown: false, operationCancelled: false },
        } : {}),
        ...(error instanceof AbsPrecheckFailure ? { precheck: error.precheck } : {}),
        ...(operation === 'abs_apply' ? {
          publication: { status: !applyStarted || error instanceof AbsApplicationFailure ? 'NOT_COMMITTED' : 'UNKNOWN' },
          application: { status: error instanceof AbsApplicationFailure ? error.applicationStatus : applyStarted ? 'UNKNOWN' : 'NOT_STARTED' },
        } : {}),
        ...(failure.diagnostic?.hint ? { recovery: failure.diagnostic.hint } : (error as any)?.code === 'ABS_IDENTITY_AMBIGUOUS' ? {
          recovery: 'Identity evidence is ambiguous. Keep the current generation and unapplied draft. Changing field values or querying block_info cannot repair identity. Do not add IDs to ABS, discard the map or force export over the draft.',
        } : {}),
        ...(source && failure.range ? { location: {
          line: source.slice(0, failure.range.start).split('\n').length,
          column: failure.range.start - source.lastIndexOf('\n', failure.range.start - 1),
        } } : {}) };
    }
  }
}
