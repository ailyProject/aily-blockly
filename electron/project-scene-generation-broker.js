const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_INTENT_BYTES = 256 * 1024;

class ProjectSceneGenerationBrokerError extends Error {
  constructor(message, code = 'SCENE_GENERATION_BROKER_FAILED', details) {
    super(message);
    this.name = 'ProjectSceneGenerationBrokerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Coordinates provider-neutral Project Scene generation.
 *
 * The broker deliberately owns no Scene file, Simulator process, Blockly
 * workspace or model implementation. Product adapters supply one bounded
 * hardware-intent snapshot and one proposal provider; the Simulator remains
 * the only authority that may validate, preview and persist the proposal.
 */
function createProjectSceneGenerationBroker(options = {}) {
  const resolveHardwareIntent = requireFunction(
    options.resolveHardwareIntent,
    'resolveHardwareIntent',
  );
  const requestProposal = requireFunction(
    options.requestProposal,
    'requestProposal',
  );
  const onProposalReady = typeof options.onProposalReady === 'function'
    ? options.onProposalReady
    : async () => {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const timeoutMs = positiveTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pendingByTarget = new Map();
  const pendingByRequestId = new Map();
  let disposed = false;

  function request(value) {
    if (disposed) {
      return Promise.reject(new ProjectSceneGenerationBrokerError(
        'Project Scene generation broker is stopped.',
        'SCENE_GENERATION_BROKER_STOPPED',
      ));
    }

    let generationRequest;
    try {
      generationRequest = validateGenerationRequest(value);
      if (generationRequest.expiresAtUnixMs <= now()) {
        throw new ProjectSceneGenerationBrokerError(
          'Project Scene generation request has expired.',
          'SCENE_GENERATION_REQUEST_EXPIRED',
          { requestId: generationRequest.requestId },
        );
      }
    } catch (error) {
      return Promise.reject(normalizeError(error));
    }

    const existingById = pendingByRequestId.get(generationRequest.requestId);
    if (existingById) {
      if (!sameRequest(existingById.request, generationRequest)) {
        return Promise.reject(new ProjectSceneGenerationBrokerError(
          'Project Scene generation requestId is already bound to another request.',
          'SCENE_GENERATION_REQUEST_ID_CONFLICT',
          { requestId: generationRequest.requestId },
        ));
      }
      return existingById.promise;
    }

    const targetKey = `${generationRequest.projectIdentity}\u0000${generationRequest.sceneId}`;
    const previous = pendingByTarget.get(targetKey);
    if (previous) {
      abortEntry(previous, new ProjectSceneGenerationBrokerError(
        'Project Scene generation request was superseded.',
        'SCENE_GENERATION_REQUEST_SUPERSEDED',
        {
          requestId: previous.request.requestId,
          supersededBy: generationRequest.requestId,
        },
      ));
    }

    const controller = new AbortController();
    const entry = {
      request: generationRequest,
      targetKey,
      controller,
      abortError: null,
      timer: null,
      promise: null,
    };
    entry.promise = run(entry);
    pendingByTarget.set(targetKey, entry);
    pendingByRequestId.set(generationRequest.requestId, entry);
    return entry.promise;
  }

  async function run(entry) {
    entry.timer = setTimeout(() => {
      abortEntry(entry, new ProjectSceneGenerationBrokerError(
        `Project Scene generation timed out after ${timeoutMs} ms.`,
        'SCENE_GENERATION_REQUEST_TIMEOUT',
        { requestId: entry.request.requestId, timeoutMs },
      ));
    }, timeoutMs);

    try {
      const hardwareIntentValue = await resolveHardwareIntent(
        structuredClone(entry.request),
        { signal: entry.controller.signal },
      );
      throwIfAborted(entry);
      const hardwareIntent = validateHardwareIntent(
        hardwareIntentValue,
        entry.request,
      );
      const proposalValue = await requestProposal({
        request: structuredClone(entry.request),
        hardwareIntent: structuredClone(hardwareIntent),
      }, { signal: entry.controller.signal });
      throwIfAborted(entry);
      const proposal = validateProposal(proposalValue, entry.request);
      await onProposalReady({
        request: structuredClone(entry.request),
        hardwareIntent: structuredClone(hardwareIntent),
        proposal: structuredClone(proposal),
      });
      throwIfAborted(entry);
      return Object.freeze({
        schemaVersion: 1,
        kind: 'aily-project-scene-generation-broker-result',
        state: 'proposal-ready',
        requestId: entry.request.requestId,
        projectIdentity: entry.request.projectIdentity,
        sceneId: entry.request.sceneId,
      });
    } catch (error) {
      if (entry.abortError) throw entry.abortError;
      if (entry.controller.signal.aborted) {
        throw new ProjectSceneGenerationBrokerError(
          'Project Scene generation request was cancelled.',
          'SCENE_GENERATION_REQUEST_CANCELLED',
          { requestId: entry.request.requestId },
        );
      }
      throw normalizeError(error);
    } finally {
      if (entry.timer) clearTimeout(entry.timer);
      if (pendingByTarget.get(entry.targetKey) === entry) {
        pendingByTarget.delete(entry.targetKey);
      }
      if (pendingByRequestId.get(entry.request.requestId) === entry) {
        pendingByRequestId.delete(entry.request.requestId);
      }
    }
  }

  function cancel(requestId, reason = 'Project Scene generation request was cancelled.') {
    const normalizedRequestId = requirePortableIdentifier(requestId, 'requestId');
    const entry = pendingByRequestId.get(normalizedRequestId);
    if (!entry) return false;
    abortEntry(entry, new ProjectSceneGenerationBrokerError(
      reason,
      'SCENE_GENERATION_REQUEST_CANCELLED',
      { requestId: normalizedRequestId },
    ));
    return true;
  }

  function status() {
    return Object.freeze({
      state: disposed ? 'stopped' : 'ready',
      pending: [...pendingByRequestId.values()].map((entry) => Object.freeze({
        requestId: entry.request.requestId,
        projectIdentity: entry.request.projectIdentity,
        sceneId: entry.request.sceneId,
      })),
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of [...pendingByRequestId.values()]) {
      abortEntry(entry, new ProjectSceneGenerationBrokerError(
        'Project Scene generation broker is stopped.',
        'SCENE_GENERATION_BROKER_STOPPED',
        { requestId: entry.request.requestId },
      ));
    }
  }

  return Object.freeze({ request, cancel, status, dispose });
}

function abortEntry(entry, error) {
  if (entry.controller.signal.aborted) return;
  entry.abortError = error;
  entry.controller.abort(error);
}

function throwIfAborted(entry) {
  if (!entry.controller.signal.aborted) return;
  throw entry.abortError || new ProjectSceneGenerationBrokerError(
    'Project Scene generation request was cancelled.',
    'SCENE_GENERATION_REQUEST_CANCELLED',
    { requestId: entry.request.requestId },
  );
}

function validateGenerationRequest(value) {
  rejectOversized(value, MAX_REQUEST_BYTES, 'Project Scene generation request');
  const request = requireRecord(value, 'Project Scene generation request');
  requireOnlyKeys(request, [
    'schemaVersion',
    'kind',
    'requestId',
    'projectIdentity',
    'sceneId',
    'reason',
    'base',
    'legacySource',
    'expiresAtUnixMs',
  ], 'Project Scene generation request');
  if (
    request.schemaVersion !== 1
    || request.kind !== 'aily-project-scene-generation-request'
  ) {
    invalid('Project Scene generation request schema identity is unsupported.');
  }
  if (!['missing-scene', 'legacy-detected', 'user-regenerate'].includes(request.reason)) {
    invalid('Project Scene generation request reason is unsupported.');
  }
  const base = requireRecord(request.base, 'Project Scene generation base');
  requireOnlyKeys(
    base,
    ['visualRevision', 'graphSemanticRevision', 'catalogRevision'],
    'Project Scene generation base',
  );
  const legacySource = request.legacySource === null
    ? null
    : validateLegacySource(request.legacySource);
  if ((request.reason === 'legacy-detected') !== (legacySource !== null)) {
    invalid('legacy-detected requests require legacySource and other reasons forbid it.');
  }
  if (!Number.isSafeInteger(request.expiresAtUnixMs) || request.expiresAtUnixMs < 0) {
    invalid('expiresAtUnixMs must be a non-negative safe integer.');
  }
  return structuredClone({
    schemaVersion: 1,
    kind: 'aily-project-scene-generation-request',
    requestId: requirePortableIdentifier(request.requestId, 'requestId'),
    projectIdentity: requirePortableIdentifier(request.projectIdentity, 'projectIdentity'),
    sceneId: requirePortableIdentifier(request.sceneId, 'sceneId'),
    reason: request.reason,
    base: {
      visualRevision: requireSha256(base.visualRevision, 'base.visualRevision'),
      graphSemanticRevision: requireSha256(
        base.graphSemanticRevision,
        'base.graphSemanticRevision',
      ),
      catalogRevision: requireSha256(base.catalogRevision, 'base.catalogRevision'),
    },
    legacySource,
    expiresAtUnixMs: request.expiresAtUnixMs,
  });
}

function validateLegacySource(value) {
  const source = requireRecord(value, 'legacySource');
  requireOnlyKeys(source, ['kind', 'revision', 'bytes'], 'legacySource');
  if (
    source.kind !== 'connection-output-v1'
    || !Number.isSafeInteger(source.bytes)
    || source.bytes < 1
  ) {
    invalid('legacySource is invalid.');
  }
  return {
    kind: 'connection-output-v1',
    revision: requireSha256(source.revision, 'legacySource.revision'),
    bytes: source.bytes,
  };
}

function validateHardwareIntent(value, request) {
  rejectOversized(value, MAX_INTENT_BYTES, 'Project hardware intent snapshot');
  const intent = requireRecord(value, 'Project hardware intent snapshot');
  requireOnlyKeys(intent, [
    'schemaVersion',
    'kind',
    'requestId',
    'projectIdentity',
    'board',
    'source',
    'libraries',
    'hardwareHints',
    'userIntent',
  ], 'Project hardware intent snapshot');
  if (
    intent.schemaVersion !== 1
    || intent.kind !== 'aily-project-hardware-intent-snapshot'
    || intent.requestId !== request.requestId
    || intent.projectIdentity !== request.projectIdentity
  ) {
    invalid('Project hardware intent snapshot does not match its generation request.');
  }
  if (!Array.isArray(intent.libraries) || !Array.isArray(intent.hardwareHints)) {
    invalid('Project hardware intent snapshot collections are invalid.');
  }
  requireRecord(intent.board, 'Project hardware intent board');
  requireRecord(intent.source, 'Project hardware intent source');
  return structuredClone(intent);
}

function validateProposal(value, request) {
  const proposal = requireRecord(value, 'Project Scene proposal');
  if (
    proposal.schemaVersion !== 1
    || proposal.kind !== 'aily-agent-scene-change-proposal'
  ) {
    invalid('Project Scene proposal schema identity is unsupported.');
  }
  const target = requireRecord(proposal.target, 'Project Scene proposal target');
  if (
    target.projectIdentity !== request.projectIdentity
    || target.sceneId !== request.sceneId
  ) {
    invalid('Project Scene proposal target does not match its generation request.');
  }
  return structuredClone(proposal);
}

function sameRequest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  return value;
}

function requireOnlyKeys(value, allowed, label) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) invalid(`${label}.${key} is not allowed.`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) invalid(`${label}.${key} is required.`);
  }
}

function requirePortableIdentifier(value, label) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    invalid(`${label} must be a portable identifier.`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    invalid(`${label} must be a SHA-256 digest.`);
  }
  return value;
}

function rejectOversized(value, maxBytes, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid(`${label} must be JSON serializable.`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    invalid(`${label} exceeds the configured byte limit.`);
  }
}

function requireFunction(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`Project Scene generation broker requires ${label}.`);
  }
  return value;
}

function positiveTimeout(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? Math.round(value) : fallback;
}

function invalid(message) {
  throw new ProjectSceneGenerationBrokerError(
    message,
    'SCENE_GENERATION_PROTOCOL_INVALID',
  );
}

function normalizeError(error) {
  return error instanceof ProjectSceneGenerationBrokerError
    ? error
    : new ProjectSceneGenerationBrokerError(
        error instanceof Error ? error.message : String(error),
      );
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ProjectSceneGenerationBrokerError,
  createProjectSceneGenerationBroker,
  validateGenerationRequest,
};
