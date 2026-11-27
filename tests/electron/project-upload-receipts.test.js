const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createProjectUploadReceipts } = require('../../electron/project-upload-receipts');

const setup = t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-upload-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const project = path.join(temp, 'test-project');
  const appData = path.join(temp, 'appdata');
  fs.mkdirSync(project);
  return { project, appData, request: { version: 1, requestId: randomUUID() } };
};

test('one real dispatch retains exact completion even after its reply or host is lost', async t => {
  const { project, appData, request } = setup(t);
  const host = createProjectUploadReceipts(appData);
  const resumed = createProjectUploadReceipts(appData);
  const params = { port: '/dev/cu.board', reuseExistingFirmware: true };
  const flight = Promise.withResolvers();
  let runs = 0;
  const upload = host.run(project, request, params, () => { runs++; return flight.promise; });
  const duplicate = () => { assert.fail('Duplicate or status must never dispatch'); };
  assert.equal(resumed.status(project, { uploadRequest: request }).uploadReceipt.state, 'running');
  assert.equal((await resumed.run(project, request, params, duplicate)).uploadOutcome, 'unknown');
  flight.resolve({ operation: 'project_upload', ok: true, uploadResult: { state: 'done' },
    firmwareBuildRequestId: 'build-1', selectedPort: { name: params.port, serialNumber: 'Seeed-1' } });
  const direct = await upload;
  assert.equal(runs, 1);
  assert.equal(direct.uploadOutcome, 'completed');
  assert.equal(direct.uploadReceipt.executorPid, process.pid);
  assert.equal(direct.firmwareBuildRequestId, 'build-1');
  assert.equal(direct.selectedPort.serialNumber, 'Seeed-1');
  assert.deepEqual(resumed.status(project, { uploadRequest: request }), direct);
  assert.deepEqual(await resumed.run(project, request, params, duplicate), direct);
  assert.equal((await resumed.run(project, request, { ...params, port: '/dev/cu.other' }, duplicate)).uploadOutcome, 'unknown');
  assert.equal(resumed.status(project, { uploadRequest: request, port: params.port }).uploadOutcome, 'unknown');
  fs.renameSync(project, project + '-original');
  fs.mkdirSync(project);
  assert.equal(resumed.status(project, { uploadRequest: request }).uploadOutcome, 'unknown');
  assert.equal((await resumed.run(project, request, params, duplicate)).uploadOutcome, 'unknown');
});

test('an unobserved or interrupted renderer upload remains pending while an admission refusal is exact', async t => {
  const { project, appData, request } = setup(t);
  const host = createProjectUploadReceipts(appData);
  assert.equal(host.status(project, { uploadRequest: request }).uploadOutcome, 'unknown');
  const pending = await host.run(project, request, {}, async () => ({ ok: false, errorCode: 'RENDERER_RESPONSE_TIMEOUT' }));
  assert.equal(pending.uploadOutcome, 'unknown');
  assert.equal(host.status(project, { uploadRequest: request }).uploadReceipt.state, 'running');
  const ambiguous = { version: 1, requestId: randomUUID() };
  const ambiguousResult = await host.run(project, ambiguous, {}, async () => ({
    operation: 'project_upload', ok: false, code: 'PREPARED_FIRMWARE_UPLOAD_UNCONFIRMED',
  }));
  assert.equal(ambiguousResult.uploadOutcome, 'unknown');
  assert.equal(host.status(project, { uploadRequest: ambiguous }).uploadReceipt.state, 'running');
  const other = { version: 1, requestId: randomUUID() };
  const refused = await host.run(project, other, {}, async () => ({ ok: false, commandDispatched: false }));
  assert.equal(refused.uploadOutcome, 'not-started');
  assert.equal(host.status(project, { uploadRequest: other }).uploadReceipt.state, 'not-started');
});

test('toolbar receipt is attached to the exact project, renderer and selected device', t => {
  const { project, appData } = setup(t);
  const host = createProjectUploadReceipts(appData);
  const device = { name: '/dev/cu.seeed', vendorId: '2886', serialNumber: 'original-1' };
  const query = { version: 1, since: Date.now() };
  const request = host.beginManual(project, device, 4);
  assert.equal(host.latestManual(project, query).uploadReceipt.requestId, request.requestId);
  assert.deepEqual(host.latestManual(project, query).selectedPort, device);
  assert.equal(host.latestManual(project, { ...query, since: Date.now() + 10000 }), null);
  assert.equal(host.latestManual(project, { ...query, port: device.name }), null);
  assert.equal(host.latestManual(path.dirname(project), query), null);
  assert.equal(host.status(project, { uploadRequest: request }).uploadReceipt.state, 'running');
  host.finishManual(project, request, { state: 'done' }, 5);
  assert.equal(host.status(project, { uploadRequest: request }).uploadOutcome, 'unknown');
  host.finishManual(project, request, { state: 'done', firmwareBackend: 'local', firmwareBuildRequestId: 'verified-10' }, 4);
  const complete = host.status(project, { uploadRequest: request });
  assert.equal(complete.uploadOutcome, 'completed');
  assert.equal(complete.uploadReceipt.source, 'manual');
  assert.deepEqual(complete.selectedPort, device);
  assert.equal(complete.firmwareBuildRequestId, 'verified-10');
  assert.deepEqual(host.latestManual(project, query), complete);
  fs.renameSync(project, project + '-original');
  fs.mkdirSync(project);
  assert.equal(host.latestManual(project, query), null);
});
