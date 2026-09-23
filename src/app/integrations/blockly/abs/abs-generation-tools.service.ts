import { Injectable } from '@angular/core';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';
import { assertGenerationCandidate, assertGenerationProjectionRequest, assertGenerationRequest, readGenerationApplyValidation } from './abs-generation-protocol';
import { AbsSyncError } from './abs-state';
import { absJson } from './abs-identity-map';
import { serializeAbsFailure } from './abs-diagnostics';

/** Wire adaptation only. Preparation, leases, publication and recovery belong to the coordinator. */
@Injectable({ providedIn: 'root' })
export class AbsGenerationToolsService {
  constructor(private readonly sync: AbsWorkspaceSyncService) {}

  capabilities(input: Record<string, any>) { return this.sync.describeCapabilities(input); }

  async execute(operation: string, input: Record<string, any>, source?: string, onProgress?: (blocks: number, batches: number) => void) {
    let applyStarted = false;
    try {
      const { abs, absPath, ...wire } = input;
      const params: Record<string, any> = JSON.parse(absJson(wire));
      assertGenerationRequest(params);
      if (operation === 'abs_projection') {
        assertGenerationProjectionRequest(params);
        const result = await this.sync.exportGeneration({ initialize: params['initialize'], publish: params['publish'], expectedAbiHash: params['expectedAbiHash'], rebind: params['rebind'], reuseCurrent: params['reuseCurrent'], synchronize: params['synchronize'] });
        const ok = !!result.evidence && (params['publish'] === false || result.publication.status === 'COMMITTED');
        return { ...result, ok, operation, project: result.evidence?.binding.scope.projectKey,
          ...(ok ? { receipt: { version: 2, requestId: params.requestId, base: result.evidence!.binding,
            output: result.evidence, persisted: params['publish'] !== false, ...(params['rebind'] ? { rebind: params['rebind'] } : {}),
            ...(params['synchronize'] ? { synchronized: true, inputAbiHash: params['expectedAbiHash'] } : {}),
            validation: { ok: true, scope: 'generation-projection' } } } : {}) };
      }
      if (operation === 'abs_recovery') {
        const reply = { operation, receipt: { version: 2, requestId: params.requestId, action: params['action'] } };
        if (params['action'] === 'inspect') return { ...reply, ok: true, ...await this.sync.inspectGeneration(), requiresReload: false };
        if (params['action'] === 'refresh' && typeof params['token'] === 'string' && /^sha256:[a-f0-9]{64}$/.test(params['token'])) {
          const result = await this.sync.exportGeneration({ preserveDraft: params['token'] });
          const ok = result.publication.status === 'COMMITTED' && !!result.evidence && !!result.draftArchive;
          return { ...reply, ...result, ok, receipt: { ...reply.receipt, token: params['token'], output: result.evidence } };
        }
        if (params['action'] === 'read_draft' && typeof params['generation'] === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(params['generation'])) {
          return { ...reply, ok: true, draft: await this.sync.readArchivedDraft(params['generation']), requiresReload: false };
        }
        if (params['action'] === 'recover') {
          const publication = await this.sync.recoverGeneration();
          return { ...reply, ok: !publication || publication.status === 'COMMITTED' || publication.status === 'NOT_COMMITTED',
            publication, requiresReload: publication !== null };
        }
        if (params['action'] === 'abandon' && typeof params['generation'] === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(params['generation'])) {
          await this.sync.abandonGeneration(params['generation']);
          return { ...reply, ok: true, requiresReload: true };
        }
        throw new AbsSyncError('ABS_REQUEST_INVALID', 'Recovery requires inspect, recover, abandon/read_draft with a generation, or refresh with an inspection token.');
      }
      if (typeof source !== 'string' || !source.trim()) throw new AbsSyncError('ABS_REQUEST_INVALID', 'Candidate source is empty.');
      if (operation === 'abs_validate') {
        assertGenerationCandidate(params);
        const { syntaxAdvice, ...prepared } = await this.sync.validateGeneration(source, params);
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
          appliedRevision: result.appliedRevision, validation: { ok: true, scope: 'complete-generation' } } } : {}) };
    } catch (error) {
      const failure = serializeAbsFailure(error);
      return { ok: false, operation, ...failure,
        ...(operation === 'abs_apply' ? { publication: { status: applyStarted ? 'UNKNOWN' : 'NOT_COMMITTED' } } : {}),
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
