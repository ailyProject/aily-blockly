const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { rootAttachment } = require('./project-file-lock-owner');
const { createProjectRecoveryReceipts } = require('./project-recovery-receipts');

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const terminal = new Set(['completed', 'failed', 'not-started']);

function validRequest(value) {
  return value?.version === 1 && typeof value.requestId === 'string' && uuid.test(value.requestId)
    && Object.keys(value).every(key => key === 'version' || key === 'requestId');
}

const uploadError = (project, code, message, uploadOutcome) => ({
  ok: false, operation: 'project_upload', project, code, message, uploadOutcome,
  ...(uploadOutcome === 'not-started' ? { commandDispatched: false, uploadStarted: false } : {}),
});

function unknown(project, requestId, state = 'unknown') {
  return {
    ...uploadError(project, 'PROJECT_UPLOAD_RESULT_UNCONFIRMED', '原烧录结果待确认，请核对原申请。', 'unknown'),
    ...(requestId ? { uploadReceipt: { version: 1, requestId, project, state } } : {}),
  };
}

function classify(result) {
  if (result?.transportError || result?.uploadOutcome === 'unknown' || result?.code === 'PREPARED_FIRMWARE_UPLOAD_UNCONFIRMED')
    return undefined;
  if (result?.ok === true && result.operation === 'project_upload' && result.uploadResult?.state === 'done') return 'completed';
  if (result?.ok === false && result.commandDispatched === false
    || result?.operation === 'project_upload' && result.uploadStarted === false && result.uploadOutcome === 'not-started') return 'not-started';
  if (result?.operation === 'project_upload' && result.ok === false) return 'failed';
  return undefined;
}

/** A request identity is reserved before any renderer upload. Observation reads
 * this result only and never dispatches to the renderer or selects a port. */
function createProjectUploadReceipts(appDataPath) {
  const receipts = createProjectRecoveryReceipts(appDataPath && path.join(appDataPath, 'upload-receipts'));
  const manual = new Map();
  const pendingManual = new Map();
  const projectKey = project => process.platform === 'win32' ? project.toLowerCase() : project;
  const relevantOptions = params => Object.fromEntries(['port', 'preparedFirmware', 'reuseCloudFirmware', 'reuseExistingFirmware']
    .filter(name => Object.hasOwn(params, name)).map(name => [name, params[name]]));
  const attachment = project => {
    if (typeof project !== 'string' || !path.isAbsolute(project)) throw Error('找不到原烧录所属项目。');
    const found = rootAttachment(project);
    if (!found) throw Error('无法确认原烧录所属项目。');
    return found;
  };
  const observed = (project, requestId, record) => {
    if (!record) return unknown(project, requestId);
    if (record.state === 'running') return unknown(project, requestId, 'running');
    const result = record.result, receipt = result?.uploadReceipt;
    return receipt?.requestId === requestId && receipt.version === 1 && receipt.project === record.project
      && terminal.has(receipt.state) && (result.ok === (receipt.state === 'completed'))
      ? result : unknown(project, requestId);
  };
  const uploadResult = (project, requestId, raw, state, source) => ({
    ...raw, ok: state === 'completed', operation: 'project_upload', project, uploadOutcome: state,
    uploadReceipt: { version: 1, requestId, project, state, executorPid: process.pid, ...source },
  });
  const matchingAttachment = (project, record) =>
    JSON.stringify(attachment(project)) === JSON.stringify(JSON.parse(record.signature).attachment);

  return {
    status(project, params) {
      const request = params?.uploadRequest;
      if (!validRequest(request) || Object.keys(params).length !== 1) return unknown(project);
      try {
        const record = receipts.status(project, request.requestId);
        if (record && !matchingAttachment(project, record))
          return unknown(project, request.requestId);
        return observed(project, request.requestId, record);
      } catch {
        return unknown(project, request.requestId);
      }
    },
    async run(project, request, params, dispatch) {
      if (!validRequest(request))
        return uploadError(project, 'PROJECT_UPLOAD_REQUEST_INVALID', '烧录申请信息无效。', 'not-started');
      const { requestId } = request;
      let admitted, signature;
      try {
        signature = JSON.stringify({ attachment: attachment(project), options: relevantOptions(params) });
        admitted = receipts.begin(project, requestId, signature, null);
      } catch {
        return unknown(project, requestId);
      }
      if (!admitted.created) return observed(project, requestId, admitted);
      let raw;
      try { raw = await dispatch(); } catch { return unknown(project, requestId); }
      const state = classify(raw);
      if (!state) return unknown(project, requestId);
      const result = uploadResult(project, requestId, raw, state);
      try {
        receipts.complete(project, requestId, signature, result);
        return result;
      } catch {
        return unknown(project, requestId);
      }
    },
    beginManual(project, device, rendererGeneration) {
      if (typeof device?.name !== 'string' || !device.name.trim() || device.name.length > 1024) return null;
      const selectedPort = Object.fromEntries(['name', 'type', 'serialNumber', 'vendorId', 'productId', 'pnpId']
        .filter(key => typeof device[key] === 'string' && device[key].length <= 1024)
        .map(key => [key, device[key]]));
      try {
        const requestId = randomUUID(), startedAt = Date.now();
        const signature = JSON.stringify({ attachment: attachment(project), selectedPort, source: 'manual', startedAt });
        const record = receipts.begin(project, requestId, signature, null);
        if (!record.created) return null;
        const original = { project, requestId, signature, selectedPort, startedAt, rendererGeneration };
        manual.set(projectKey(project), original);
        pendingManual.set(requestId, original);
        return { version: 1, requestId };
      } catch {
        return null;
      }
    },
    finishManual(project, request, raw, rendererGeneration) {
      if (!validRequest(request)) return;
      const original = pendingManual.get(request.requestId);
      if (!original || projectKey(project) !== projectKey(original.project) || original.rendererGeneration !== rendererGeneration) return;
      pendingManual.delete(request.requestId);
      const { requestId, signature, selectedPort, startedAt } = original;
      const facts = {
        operation: 'project_upload', selectedPort,
        ok: raw?.state === 'done',
        uploadResult: { state: raw?.state },
        ...(typeof raw?.code === 'string' ? { code: raw.code } : {}),
        ...(raw?.state !== 'done' ? { uploadOutcome: 'unknown' } : {}),
        ...(raw?.notStarted === true ? { commandDispatched: false, uploadStarted: false, uploadOutcome: 'not-started' } : {}),
        ...(['cloud', 'local'].includes(raw?.firmwareBackend) ? { firmwareBackend: raw.firmwareBackend } : {}),
        ...(typeof raw?.firmwareBuildRequestId === 'string' ? { firmwareBuildRequestId: raw.firmwareBuildRequestId } : {}),
      };
      const state = classify(facts);
      if (!state) return;
      try {
        if (!matchingAttachment(project, original)) return;
        receipts.complete(project, requestId, signature,
          uploadResult(project, requestId, facts, state, { source: 'manual', startedAt }));
      } catch { /* Only the original receipt owner can publish an exact outcome. */ }
    },
    latestManual(project, params) {
      const original = typeof project === 'string' ? manual.get(projectKey(project)) : undefined;
      if (!original || params?.version !== 1 || !Number.isSafeInteger(params.since)
        || params.since < 0 || params.since > original.startedAt
        || Object.keys(params).some(key => !['version', 'since'].includes(key))) return null;
      try {
        if (!matchingAttachment(project, original)) return null;
        const { requestId, startedAt, selectedPort } = original;
        const result = observed(project, requestId, receipts.status(project, requestId));
        return {
          ...result, selectedPort,
          uploadReceipt: { ...result.uploadReceipt, source: 'manual', startedAt, executorPid: process.pid },
        };
      } catch {
        return null;
      }
    },
  };
}

module.exports = { createProjectUploadReceipts };
