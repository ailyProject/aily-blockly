import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function assertPhysicalCandidateMode(checkpoint, ref, { prepared = false } = {}) {
  assert.ok(checkpoint && checkpoint.candidateRefs);
  assert.deepEqual(checkpoint.candidateRefs['project.abs'], ref);
  if (prepared) assert.ok(checkpoint.candidateSourceDescriptors && typeof checkpoint.candidateSourceDescriptors === 'object');
  // The production descriptor contract stores only virtual:true. No key means
  // physical; never invent a serialized virtual:false/sourceMode wire field.
  assert.equal(checkpoint.candidateSourceDescriptors?.['project.abs'], undefined);
  return { mode: 'physical', descriptorEncoding: 'no-virtual-key', ref };
}

/** Actual persisted acceptance ObjectRef, not a UI success or current-head guess. */
export async function readCandidateAcceptanceEvidence({ project, checkpoint, snapshot, requestId, ref, expectedOutput }) {
  const publication = checkpoint.candidatePublications?.[requestId];
  assert.equal(publication?.version, 1); assert.equal(publication.kind, 'abs_apply');
  assert.equal(publication.requestId, requestId); assert.deepEqual(publication.ref, ref);
  assert.equal(publication.owner.sessionId, snapshot.sessionId);
  assert.ok(snapshot.entries.some(entry => entry.id === publication.owner.branchId && entry.type === 'message' && entry.message.role === 'user'));
  const object = async reference => {
    assert.match(reference?.hash ?? '', /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(reference.bytes) && reference.bytes > 0 && reference.bytes <= 128 * 1024 * 1024);
    let directory = project;
    for (const part of ['.workspace-history', 'objects', reference.hash.slice(0, 2)]) {
      directory = path.join(directory, part); const stat = await fs.lstat(directory); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    }
    const filename = path.join(directory, reference.hash + '.blob'), stat = await fs.lstat(filename);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    const bytes = await fs.readFile(filename); assert.equal(bytes.length, reference.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.hash);
    const text = bytes.toString('utf8'); assert.deepEqual(Buffer.from(text), bytes); return JSON.parse(text);
  };
  const validation = await object(publication.validation), result = await object(publication.acceptance);
  assert.equal(validation.requestId, requestId); assert.deepEqual(validation.workingCandidate, ref);
  assert.equal(result.ok, true); assert.equal(result.operation, 'abs_apply'); assert.equal(result.publication.status, 'COMMITTED');
  assert.equal(result.receipt.requestId, requestId); assert.deepEqual(result.receipt.workingCandidate, ref);
  assert.equal(result.receipt.validation.ok, true); assert.equal(result.receipt.validation.scope, 'complete-generation');
  assert.equal(result.receipt.workspaceRevision, validation.workspaceRevision);
  assert.equal(result.receipt.libraryRuntimeFingerprint, validation.libraryRuntimeFingerprint);
  assert.deepEqual(result.receipt.output, expectedOutput);
  return { requestId, ref, acceptance: publication.acceptance, validation: publication.validation, result };
}

export function createCandidateColdGates() {
  const plans = [
    [0, 1, 'load-candidate-tools'], [0, 2, 'read-Working-before-A'], [0, 3, 'edit-private-A'],
    [1, 0, 'cold-original-observed'], [1, 1, 'read-A-after-cold'], [1, 2, 'edit-B-after-cold'],
    [1, 3, 'apply-ABC-after-cold'],
  ];
  const gates = new Map(plans.map(([turn, step, id]) => {
    let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {}); return [id, { turn, step, id, promise, resolve, reject, waiting: false, released: false }];
  }));
  let cancelled;
  return {
    async wait({ turn, step, previousResult }) {
      const gate = [...gates.values()].find(value => value.turn === turn && value.step === step);
      if (!gate) return;
      if (gate.id !== 'cold-original-observed') assert.equal(previousResult?.toolCallId ?? previousResult?.tool_call_id, gate.id);
      if (cancelled) throw cancelled;
      assert.equal(gate.waiting, false); gate.waiting = true; await gate.promise;
    },
    has: id => gates.has(id),
    release(id) {
      const gate = gates.get(id); assert.ok(gate); assert.equal(cancelled, undefined); assert.equal(gate.released, false);
      gate.released = true; gate.resolve();
    },
    cancel(error) { if (cancelled) return; cancelled = error; for (const gate of gates.values()) if (!gate.released) gate.reject(error); },
    snapshot: () => [...gates.values()].map(({ turn, step, id, waiting, released }) => ({ turn, step, id, waiting, released })),
  };
}

export function assertCandidateColdDispatches(first, cold, originalRequestId, nextRequestId) {
  assert.ok(originalRequestId && nextRequestId && originalRequestId !== nextRequestId);
  const writes = [...first.commands, ...cold.commands].filter(value => value.operation === 'abs_apply');
  assert.deepEqual(writes.map(value => value.requestId), [originalRequestId, nextRequestId], 'Old apply once, fresh B apply once, no replay');
  assert.equal(first.commands.filter(value => value.operation === 'abs_recovery' && value.action === 'candidate_capture').length, 1);
  const captures = cold.commands.filter(value => value.operation === 'abs_recovery' && value.action === 'candidate_capture');
  assert.equal(captures.length, 1, 'Accepted A closes its old candidate; the next Core read captures actual Working AC once');
  assert.ok(cold.commands.some(value => value.operation === 'abs_recovery' && value.action === 'observe_apply' && value.requestId === originalRequestId));
  const accepted = cold.terminals.find(value => value.operation === 'abs_recovery' && value.action === 'observe_apply'
    && value.requestId === originalRequestId && value.ok === true && value.applicationObservation?.current === true);
  assert.ok(accepted && Number.isFinite(accepted.at) && Number.isFinite(captures[0].at) && accepted.at <= captures[0].at,
    'Do not recapture/rebase before the exact original application was actually accepted');
}

/** Installed only inside the exact owned packaged Main. This is an additional
 * passive listener: it never edits auth, request, dispatch, response or facts. */
export function installCandidateColdAudit(_electron, configuration) {
  const config = typeof configuration === 'string' ? JSON.parse(configuration) : configuration;
  const proc = globalThis.process, http = proc.getBuiltinModule('http'), fs = proc.getBuiltinModule('fs'),
    path = proc.getBuiltinModule('path'), { Buffer } = proc.getBuiltinModule('buffer');
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (proc.pid !== config.pid || proc.env.AILY_APPDATA_PATH !== config.appData || !path.isAbsolute(config.project)
    || !same(fs.realpathSync(config.project), config.project) || !/[/\\]aily-project[/\\]dev-tests[/\\]/i.test(config.project))
    throw Error('Candidate audit requires exact owned physical Main/project');
  if (globalThis.__ailyR3CandidateColdAudit) throw Error('Candidate audit already installed');
  const servers = proc._getActiveHandles().filter(value => value instanceof http.Server && value.address()?.port === config.port);
  if (servers.length !== 1) throw Error('Expected the actual owned CLI server');
  const state = { commands: [], terminals: [], handlerReplaced: false, resultFabricated: false };
  const listener = (request, response) => {
    if (request.method !== 'POST' || request.url !== '/command') return;
    let chunks = [], bytes = 0, command;
    request.on('data', chunk => { bytes += chunk.length; if (bytes <= 8 * 1024 * 1024) chunks.push(chunk); else chunks = []; });
    request.once('end', () => {
      if (!chunks.length) return; let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { return; }
      if (body.action !== 'blockly-live-operation' || !same(body.path, config.project)) return;
      const params = body.params ?? {};
      if (!['abs_validate', 'abs_apply', 'abs_recovery', 'abs_projection'].includes(body.operation)) return;
      command = { operation: body.operation, action: params.action, requestId: params.requestId, at: Date.now(),
        ref: params.workingCandidate ?? params.validation?.workingCandidate,
        flags: Object.fromEntries(['reuseCurrent', 'synchronize', 'publish', 'initialize', 'save'].filter(key => typeof params[key] === 'boolean').map(key => [key, params[key]])) };
      state.commands.push(command);
    });
    const originalEnd = response.end;
    response.end = function (...args) {
      if (command && (typeof args[0] === 'string' || Buffer.isBuffer(args[0]))) {
        try { const body = JSON.parse(args[0]); state.terminals.push({ ...command, at: Date.now(),
          ok: body.ok, code: body.code, publication: body.publication, requiresReload: body.requiresReload,
          receipt: body.receipt, applicationObservation: body.applicationObservation }); } catch {}
      }
      return originalEnd.apply(this, args);
    };
  };
  servers[0].on('request', listener);
  globalThis.__ailyR3CandidateColdAudit = { snapshot: () => JSON.parse(JSON.stringify(state)),
    restore: () => { servers[0].removeListener('request', listener); } };
  return { available: true, port: config.port, passive: true };
}
