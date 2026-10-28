'use strict';
const path = require('node:path');
const { createProjectRecoveryReceipts } = require('./project-recovery-receipts');
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const fail = message => Object.assign(new Error(message), { code: 'PROJECT_REPAIR_HANDOFF_INVALID' });
const ID = /^[A-Za-z0-9_-]{8,96}$/;

/** A repair child retains its exact source view. Publishing a second target
 * never authorizes that child to navigate away from its native target. */
function repairForkPolicy(record, params, currentProject, pid = process.pid) {
  if (!params || Object.keys(params).some(key => !['sourceProject', 'project'].includes(key))
    || !path.isAbsolute(params.sourceProject || '') || !path.isAbsolute(params.project || '')
    || same(params.sourceProject, params.project)) throw fail('The fork policy requires an absolute source and a distinct absolute target.');
  if (!record) return { version: 1, sourceProject: params.sourceProject, project: params.project, activation: 'same-host' };
  if (!same(params.sourceProject, currentProject) || !same(record.project, params.sourceProject)
    || record.hostPid !== pid) throw fail('The repair child no longer owns the exact current source view.');
  return { version: 1, sourceProject: params.sourceProject, project: params.project, activation: 'deferred',
    reason: 'isolated-repair-host', sourceHostPid: pid, ownerHostPid: record.parentHostPid };
}

/** Native-to-native handoff. Only the owner's authenticated child record can
 * select a receipt store; neither renderer nor Agent can supply an AppData path. */
function createRepairHandoffController({ continuation, environments, pid = process.pid }) {
  const result = (params, sourceEnvironment, observed, observationOnly = false) => {
    const environment = observed.repairEnvironment, snapshot = observed.recoveryContinuation;
    if (observed.ok !== true || snapshot?.scope !== 'native-durable-repair-lineage'
      || environment?.version !== 2 || environment.parentHostPid !== pid || snapshot.ownerHostPid !== pid
      || !same(environment.project, params.project) || !same(environment.sourceProject, params.sourceProject)
      || environment.requestId !== params.requestId || snapshot.requestId !== params.requestId
      || !same(snapshot.project, params.project) || !same(snapshot.sourceProject, params.sourceProject)
      || snapshot.lineageId !== environment.lineageId || snapshot.epoch !== environment.epoch
      || snapshot.hostCodeIdentity !== environment.hostCodeIdentity || !/^sha256:[a-f0-9]{64}$/.test(snapshot.currentAbiHash || '')) {
      throw fail('The current exact target lineage could not be observed under this native owner.');
    }
    return { ok: true, operation: 'project_repair_handoff_prepare', project: params.project, sourceProject: params.sourceProject,
      requestId: params.requestId, ...(observationOnly ? { observationOnly: true, recoveryContinuation: snapshot } : {}),
      repairEnvironment: environment, handoffVerification: {
        version: 1, scope: 'native-saved-target-handoff', project: params.project, sourceProject: params.sourceProject,
        requestId: params.requestId, sourceHostPid: sourceEnvironment.hostPid, ownerHostPid: pid,
        sourceEnvironmentId: sourceEnvironment.environmentId, sourceLineageId: sourceEnvironment.lineageId, sourceEpoch: sourceEnvironment.epoch,
        lineageId: environment.lineageId, epoch: environment.epoch, currentAbiHash: snapshot.currentAbiHash,
        hostCodeIdentity: environment.hostCodeIdentity, ...(observationOnly ? { observationOnly: true } : {}),
        sourceGuardReleased: false, originalWorkspaceRebound: false } };
  };
  return { async prepare(params) {
    try {
      if (params?.version !== 1 || Object.keys(params).some(key => !['version', 'project', 'sourceProject', 'requestId', 'sourceEnvironment'].includes(key))
        || !path.isAbsolute(params.project || '') || !path.isAbsolute(params.sourceProject || '')
        || same(params.project, params.sourceProject) || !ID.test(params.requestId || '')) throw fail('Handoff requires an exact saved target and original fork request.');
      const expected = params.sourceEnvironment;
      if (expected?.version !== 2 || !same(expected.project, params.sourceProject)
        || !Number.isSafeInteger(expected.epoch) || expected.epoch < 1) throw fail('The source must be this native owner’s current authenticated repair epoch.');
      const existing = await continuation.handoffTarget({ project: params.project, sourceProject: params.sourceProject, requestId: params.requestId });
      if (existing && existing.observation.repairEnvironment?.epoch > 0) {
        const origin = existing.sourceEnvironment, observed = existing.observation;
        if (!origin || origin.version !== 2 || !same(origin.project, params.sourceProject)
          || !Number.isSafeInteger(origin.epoch) || origin.epoch < 1) throw fail('The existing target has no native delegated source ancestry.');
        // This is C's own current snapshot, not a claim that B is still alive
        // or that C still equals the old immutable fork primary.
        if (observed.ok !== true) return { ...observed, operation: 'project_repair_handoff_prepare',
          sourceProject: params.sourceProject, requestId: params.requestId, observationOnly: true,
          nextAction: { tool: 'project_recover', input: { project: params.project, action: 'inspect_environment' } } };
        return result(params, origin, observed, true);
      }
      if (expected.parentHostPid !== pid) throw fail('First handoff requires the current native owner of the live source.');
      const sourceRecord = await continuation.authenticatedSource(expected);
      const store = createProjectRecoveryReceipts(sourceRecord.privateAppData);
      const receipt = store.status(params.sourceProject, params.requestId);
      if (receipt?.state !== 'completed' || receipt.result?.projectSaved !== true || receipt.result.activated === true
        || !same(receipt.result.sourceProject, params.sourceProject) || !same(receipt.result.project, params.project)
        || receipt.result.recoverySource?.complete !== true || store.abiHash(params.project) !== receipt.targetAbiHash) throw fail('The target differs from the authenticated child’s completed fork receipt.');
      await environments.prepareDelegated({ sourceRecord, sourceEnvironment: expected, sourceProject: params.sourceProject,
        project: params.project, requestId: params.requestId });
      const observed = await continuation.inspect({ version: 1, project: params.project });
      const environment = observed.repairEnvironment;
      if (observed.ok !== true || environment?.version !== 2 || environment.epoch !== 0 || environment.hostPid
        || environment.parentHostPid !== pid || !same(environment.project, params.project)
        || !same(environment.sourceProject, params.sourceProject) || environment.requestId !== params.requestId
        || observed.recoveryContinuation?.currentAbiHash !== receipt.targetAbiHash) throw fail('A fresh prepared target lineage was not confirmed; no source view was replaced.');
      await continuation.authenticatedSource(expected);
      return result(params, expected, observed);
    } catch (error) {
      return { ok: false, operation: 'project_repair_handoff_prepare', project: params?.project, sourceProject: params?.sourceProject,
        requestId: params?.requestId, code: error.code || 'PROJECT_REPAIR_HANDOFF_FAILED', message: error.message,
        sourceGuardReleased: false, originalWorkspaceRebound: false };
    }
  } };
}
module.exports = { createRepairHandoffController, repairForkPolicy };
