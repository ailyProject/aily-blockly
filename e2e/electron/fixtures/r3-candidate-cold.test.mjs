import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createCandidateColdGates, assertCandidateColdDispatches, installCandidateColdAudit,
  assertPhysicalCandidateMode, readCandidateAcceptanceEvidence } from './r3-candidate-cold.mjs';

test('provider gate uses only exact previous result and one external release', async () => {
  const gates = createCandidateColdGates(); let completed = false;
  const pending = gates.wait({ turn: 0, step: 2, previousResult: { toolCallId: 'read-Working-before-A' } }).then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  gates.release('read-Working-before-A'); await pending; assert.equal(completed, true);
  assert.throws(() => gates.release('read-Working-before-A'));
  await assert.rejects(gates.wait({ turn: 0, step: 3, previousResult: { toolCallId: 'foreign-edit' } }));
});

test('cold first provider waits for independent original-ID observation, never an observer call inside provider', async () => {
  const gates = createCandidateColdGates(); let completed = false;
  const pending = gates.wait({ turn: 1, step: 0 }).then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  gates.release('cold-original-observed'); await pending; assert.equal(completed, true);
});

test('failed qualification rejects waiting provider instead of releasing business tools', async () => {
  const gates = createCandidateColdGates(), pending = gates.wait({ turn: 1, step: 0 });
  gates.cancel(Error('actual original observation failed'));
  await assert.rejects(pending, /actual original observation failed/);
  assert.throws(() => gates.release('cold-original-observed'));
});

test('accepted transition oracle requires one new Working capture after original readonly completion and rejects replay', () => {
  const first = { commands: [{ operation: 'abs_recovery', action: 'candidate_capture' }, { operation: 'abs_apply', requestId: 'A' }] };
  const cold = { commands: [{ operation: 'abs_recovery', action: 'observe_apply', requestId: 'A' },
    { operation: 'abs_recovery', action: 'candidate_capture', at: 20 }, { operation: 'abs_apply', requestId: 'B' }],
  terminals: [{ operation: 'abs_recovery', action: 'observe_apply', requestId: 'A', ok: true, at: 10, applicationObservation: { current: true } }] };
  assertCandidateColdDispatches(first, cold, 'A', 'B');
  assert.throws(() => assertCandidateColdDispatches(first, { ...cold, commands: [...cold.commands, { operation: 'abs_apply', requestId: 'A' }] }, 'A', 'B'));
  assert.throws(() => assertCandidateColdDispatches(first, { ...cold, commands: [...cold.commands, { operation: 'abs_recovery', action: 'candidate_capture' }] }, 'A', 'B'));
  assert.throws(() => assertCandidateColdDispatches(first, { ...cold, commands: [cold.commands[1], cold.commands[2]] }, 'A', 'B'));
  assert.throws(() => assertCandidateColdDispatches(first, { ...cold, terminals: [{ ...cold.terminals[0], at: 30 }] }, 'A', 'B'));
});

test('passive actual HTTP witness preserves flat replies/auth/app_info and omits body text', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-candidate-passive-')),
    project = path.join(directory, 'aily-project/dev-tests/project');
  fs.mkdirSync(project, { recursive: true });
  const received = [], token = 'controlled-http-only-secret', server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); received.push(body);
    assert.equal(request.headers.authorization, 'Bearer ' + token);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body.action === 'app_info' ? { ok: true, mode: 'blockly' }
      : { ok: true, operation: body.operation, publication: { status: 'COMMITTED' }, receipt: { requestId: body.params.requestId } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = vm.createContext({ process: { pid: process.pid, env: { AILY_APPDATA_PATH: directory },
    getBuiltinModule: name => ({ http, fs, path, buffer: { Buffer } })[name], _getActiveHandles: () => [server] } });
  const install = vm.runInContext('(' + installCandidateColdAudit.toString() + ')', context);
  install(undefined, { pid: process.pid, appData: directory, project, port: server.address().port });
  t.after(async () => { context.__ailyR3CandidateColdAudit.restore(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const send = async body => { const response = await fetch('http://127.0.0.1:' + server.address().port + '/command',
    { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return response.json(); };
  assert.deepEqual(await send({ action: 'app_info' }), { ok: true, mode: 'blockly' });
  const body = { action: 'blockly-live-operation', path: project, operation: 'abs_apply',
    params: { requestId: 'original-A', abs: 'unlogged source text', workingCandidate: { id: 'candidate-A', revisionHash: 'exact' } } };
  assert.deepEqual(await send(body), { ok: true, operation: 'abs_apply', publication: { status: 'COMMITTED' }, receipt: { requestId: 'original-A' } });
  const snapshot = context.__ailyR3CandidateColdAudit.snapshot();
  assert.equal(snapshot.commands.length, 1); assert.equal(snapshot.terminals.length, 1);
  assert.equal(snapshot.commands[0].requestId, 'original-A'); assert.equal(snapshot.terminals[0].receipt.requestId, 'original-A');
  assert.deepEqual(received, [{ action: 'app_info' }, body]);
  assert.equal(JSON.stringify(snapshot).includes(token), false); assert.equal(JSON.stringify(snapshot).includes('unlogged source text'), false);
});

test('physical source-mode oracle follows the actual virtual-only descriptor contract and rejects virtual/foreign refs', () => {
  const ref = { version: 1, id: 'same', revisionHash: 'a'.repeat(64) }, checkpoint = { candidateRefs: { 'project.abs': ref }, candidateSourceDescriptors: {} };
  assert.equal(assertPhysicalCandidateMode(checkpoint, ref, { prepared: true }).mode, 'physical');
  assert.throws(() => assertPhysicalCandidateMode({ ...checkpoint, candidateSourceDescriptors: { 'project.abs': { virtual: true } } }, ref));
  assert.throws(() => assertPhysicalCandidateMode({ candidateRefs: checkpoint.candidateRefs }, ref, { prepared: true }));
  assert.throws(() => assertPhysicalCandidateMode(checkpoint, { ...ref, revisionHash: 'b'.repeat(64) }));
});

test('accepted-fact oracle requires actual immutable full-result/validation references in the unified map', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-candidate-fact-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const put = value => { const bytes = Buffer.from(JSON.stringify(value)), hash = createHash('sha256').update(bytes).digest('hex'),
    directory = path.join(project, '.workspace-history/objects', hash.slice(0, 2)), filename = path.join(directory, hash + '.blob');
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(filename, bytes); return { hash, bytes: bytes.length }; };
  // Controlled parser inputs only; this test does not prove native publication.
  const ref = { version: 1, id: 'original-candidate', revisionHash: 'a'.repeat(64) }, requestId = 'original-request',
    validation = { requestId, workingCandidate: ref, workspaceRevision: 4, libraryRuntimeFingerprint: 'b'.repeat(64) },
    expectedOutput = { binding: { generation: 'G1' }, absBytes: 7 },
    result = { ok: true, operation: 'abs_apply', publication: { status: 'COMMITTED' }, receipt: {
      ...validation, validation: { ok: true, scope: 'complete-generation' }, output: expectedOutput } },
    publication = { version: 1, kind: 'abs_apply', requestId, ref, owner: { sessionId: 'session', branchId: 'user' },
      validation: put(validation), acceptance: put(result) },
    checkpoint = { candidatePublications: { [requestId]: publication } },
    snapshot = { sessionId: 'session', entries: [{ type: 'message', id: 'user', message: { role: 'user' } }] },
    input = { project, checkpoint, snapshot, requestId, ref, expectedOutput };
  assert.deepEqual((await readCandidateAcceptanceEvidence(input)).result, result);
  await assert.rejects(readCandidateAcceptanceEvidence({ ...input, checkpoint: { pendingCandidatePublications: checkpoint.candidatePublications } }));
  await assert.rejects(readCandidateAcceptanceEvidence({ ...input, ref: { ...ref, id: 'later-B' } }));
  await assert.rejects(readCandidateAcceptanceEvidence({ ...input, expectedOutput: { ...expectedOutput, absBytes: 8 } }));
  const factFile = path.join(project, '.workspace-history/objects', publication.acceptance.hash.slice(0, 2), publication.acceptance.hash + '.blob');
  fs.writeFileSync(factFile, 'corrupt'); await assert.rejects(readCandidateAcceptanceEvidence(input));
});
