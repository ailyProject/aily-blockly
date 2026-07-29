const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_REBUILD_RESULT_SCHEMA_VERSION = 1;
const ARTIFACT_MANIFEST_NAME = 'aily-artifact-manifest.json';
const ARTIFACT_MANIFEST_MAX_BYTES = 1024 * 1024;
const MAX_ARTIFACT_FILES = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REJECTED_RESULT_CODES = new Set([
  'adapter-unavailable',
  'project-not-active',
  'reconciliation-required',
  'reconciliation-rejected',
  'build-busy',
  'build-failed',
]);

function createSimulatorProjectRebuildCoordinator(options = {}) {
  const requestProjectRebuild = options.requestProjectRebuild;
  const inspectCandidateArtifact = options.inspectCandidateArtifact
    || inspectProjectArtifact;
  const onStateChanged = options.onStateChanged || (() => undefined);
  const onCandidateReady = options.onCandidateReady || (() => undefined);
  let sequence = 0;
  let current = null;

  function enqueue({ request, projectRoot }) {
    if (!request || typeof projectRoot !== 'string' || projectRoot.length === 0) {
      throw new Error('Project rebuild registration is incomplete.');
    }
    if (typeof requestProjectRebuild !== 'function') {
      return { accepted: false, errorCode: 'host-unavailable' };
    }

    const identity = JSON.stringify(request);
    if (current?.request.requestId === request.requestId) {
      if (current.identity !== identity) {
        return { accepted: false, errorCode: 'request-superseded' };
      }
      if (
        current.state !== 'failed'
        || current.errorCode !== 'reconciliation-required'
      ) {
        return { accepted: true, duplicate: true };
      }
    }

    const ticket = {
      sequence: ++sequence,
      identity,
      projectRoot: path.resolve(projectRoot),
      request: structuredClone(request),
      state: 'requested',
      candidate: null,
      errorCode: null,
    };
    current = ticket;
    emit(ticket);
    void coordinate(ticket);
    return { accepted: true, duplicate: false };
  }

  async function coordinate(ticket) {
    try {
      const baseline = await inspectCandidateArtifact({
        projectRoot: ticket.projectRoot,
        expectedArtifactId: ticket.request.artifactRevision,
        expectedGraphSemanticRevision: null,
      });
      if (!isCurrent(ticket)) return;

      ticket.state = 'coordinating';
      emit(ticket);
      const rawResult = await requestProjectRebuild(
        createRendererRequest(ticket.request),
      );
      if (!isCurrent(ticket)) return;
      const result = validateProjectRebuildResult(rawResult, ticket.request);
      if (result.status === 'rejected') {
        ticket.state = 'failed';
        ticket.errorCode = result.errorCode;
        emit(ticket);
        return;
      }

      ticket.state = 'validating';
      emit(ticket);
      const candidate = await inspectCandidateArtifact({
        projectRoot: ticket.projectRoot,
        expectedArtifactId: result.artifactId,
        expectedGraphSemanticRevision: ticket.request.sceneRevision,
      });
      if (!isCurrent(ticket)) return;
      requireCompatibleTarget(baseline.target, candidate.target);
      requireCompatibleBuildEnvironment(
        baseline.buildEnvironment,
        candidate.buildEnvironment,
      );
      if (candidate.artifactId === baseline.artifactId) {
        throw new CandidateArtifactError(
          'artifact-integrity-failed',
          'Candidate Artifact did not change after graph reconciliation.',
        );
      }

      ticket.state = 'candidate-ready';
      ticket.candidate = {
        artifactId: candidate.artifactId,
        graphSemanticRevision: candidate.graphSemanticRevision,
      };
      ticket.errorCode = null;
      emit(ticket);
      await onCandidateReady({
        request: structuredClone(ticket.request),
        projectRoot: ticket.projectRoot,
        candidate: structuredClone(ticket.candidate),
      });
    } catch (error) {
      if (!isCurrent(ticket)) return;
      ticket.state = 'failed';
      ticket.errorCode = normalizeCoordinatorError(error);
      emit(ticket);
    }
  }

  function status() {
    return current ? publicState(current) : { state: 'idle' };
  }

  function reset() {
    sequence += 1;
    current = null;
    onStateChanged({ state: 'idle' });
  }

  function isCurrent(ticket) {
    return current === ticket && current.sequence === ticket.sequence;
  }

  function emit(ticket) {
    onStateChanged(publicState(ticket));
  }

  return {
    enqueue,
    reset,
    status,
  };
}

function createRendererRequest(request) {
  return {
    schemaVersion: PROJECT_REBUILD_RESULT_SCHEMA_VERSION,
    kind: 'aily-project-simulator-rebuild-request',
    requestId: request.requestId,
    projectIdentity: request.projectIdentity,
    sessionId: request.sessionId,
    sceneId: request.sceneId,
    action: 'reconcile-and-build',
    expectedGraphSemanticRevision: request.sceneRevision,
    sceneDocument: structuredClone(request.sceneDocument),
  };
}

function validateProjectRebuildResult(value, request) {
  requireRecord(value, 'Project rebuild result');
  const allowedKeys = new Set([
    'schemaVersion',
    'kind',
    'requestId',
    'projectIdentity',
    'sessionId',
    'sceneId',
    'status',
    'artifactId',
    'graphSemanticRevision',
    'errorCode',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new CandidateArtifactError(
      'build-failed',
      'Project rebuild result contains unsupported fields.',
    );
  }
  if (
    value.schemaVersion !== PROJECT_REBUILD_RESULT_SCHEMA_VERSION
    || value.kind !== 'aily-project-simulator-rebuild-result'
    || value.requestId !== request.requestId
    || value.projectIdentity !== request.projectIdentity
    || value.sessionId !== request.sessionId
    || value.sceneId !== request.sceneId
    || value.graphSemanticRevision !== request.sceneRevision
  ) {
    throw new CandidateArtifactError(
      'build-failed',
      'Project rebuild result does not match its request scope.',
    );
  }
  if (value.status === 'built') {
    requireSha256(value.artifactId, 'Project rebuild result artifactId');
    if (value.errorCode !== null) {
      throw new CandidateArtifactError(
        'build-failed',
        'Built project rebuild result cannot contain an error.',
      );
    }
  } else if (value.status === 'rejected') {
    if (value.artifactId !== null || !REJECTED_RESULT_CODES.has(value.errorCode)) {
      throw new CandidateArtifactError(
        'build-failed',
        'Rejected project rebuild result is invalid.',
      );
    }
  } else {
    throw new CandidateArtifactError(
      'build-failed',
      'Project rebuild result status is unsupported.',
    );
  }
  return value;
}

async function inspectProjectArtifact({
  projectRoot,
  expectedArtifactId,
  expectedGraphSemanticRevision,
}) {
  requireSha256(expectedArtifactId, 'Expected Artifact id');
  const canonicalProjectRoot = await fs.promises.realpath(projectRoot);
  const buildDirectory = path.join(canonicalProjectRoot, '.build');
  const manifestPath = path.join(buildDirectory, ARTIFACT_MANIFEST_NAME);
  const manifestStat = await requireRegularFile(manifestPath, 'Artifact manifest');
  if (manifestStat.size > ARTIFACT_MANIFEST_MAX_BYTES) {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      'Artifact manifest exceeds its size limit.',
    );
  }
  const canonicalBuildDirectory = await fs.promises.realpath(buildDirectory);
  requireInside(canonicalProjectRoot, canonicalBuildDirectory, 'Artifact directory');
  let manifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      'Artifact manifest is not valid JSON.',
    );
  }
  requireRecord(manifest, 'Artifact manifest');
  if (
    manifest.schemaVersion !== 1
    || manifest.kind !== 'aily-build-artifact'
  ) {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      'Artifact manifest schema is unsupported.',
    );
  }
  requireSha256(manifest.artifactId, 'Artifact manifest artifactId');
  if (manifest.artifactId !== expectedArtifactId) {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      'Artifact identity does not match the build result.',
    );
  }
  requireRecord(manifest.target, 'Artifact target');
  for (const key of ['fqbn', 'architecture', 'boardId']) {
    if (typeof manifest.target[key] !== 'string' || manifest.target[key].length === 0) {
      throw new CandidateArtifactError(
        'artifact-integrity-failed',
        `Artifact target ${key} is invalid.`,
      );
    }
  }
  requireRecord(manifest.build, 'Artifact build');
  requireRecord(manifest.build.source, 'Artifact build source');
  requireSha256(manifest.build.source.sha256, 'Artifact build source sha256');

  const graph = manifest.build.graph;
  if (expectedGraphSemanticRevision !== null) {
    if (
      !graph
      || Object.keys(graph).sort().join('\0')
        !== ['graphSemanticRevision', 'kind', 'schemaVersion'].join('\0')
      || graph.schemaVersion !== 1
      || graph.kind !== 'aily-scene-graph-provenance'
      || graph.graphSemanticRevision !== expectedGraphSemanticRevision
    ) {
      throw new CandidateArtifactError(
        'artifact-incompatible',
        'Candidate Artifact graph provenance does not match the Scene.',
      );
    }
  }

  if (
    !Array.isArray(manifest.files)
    || manifest.files.length === 0
    || manifest.files.length > MAX_ARTIFACT_FILES
  ) {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      'Artifact file list is invalid.',
    );
  }
  const normalizedFiles = [];
  const seenPaths = new Set();
  const seenRoles = new Set();
  for (const [index, descriptor] of manifest.files.entries()) {
    requireRecord(descriptor, `Artifact file ${index}`);
    if (
      typeof descriptor.role !== 'string'
      || !Number.isSafeInteger(descriptor.sizeBytes)
      || descriptor.sizeBytes < 0
    ) {
      throw new CandidateArtifactError(
        'artifact-integrity-failed',
        `Artifact file ${index} metadata is invalid.`,
      );
    }
    requireSha256(descriptor.sha256, `Artifact file ${index} sha256`);
    const relativePath = requireSafeRelativePath(
      descriptor.path,
      `Artifact file ${index} path`,
    );
    if (seenPaths.has(relativePath)) {
      throw new CandidateArtifactError(
        'artifact-integrity-failed',
        'Artifact contains duplicate file paths.',
      );
    }
    seenPaths.add(relativePath);
    seenRoles.add(descriptor.role);
    const filePath = path.resolve(canonicalBuildDirectory, relativePath);
    requireInside(canonicalBuildDirectory, filePath, `Artifact file ${index}`);
    const stat = await requireRegularFile(filePath, `Artifact file ${index}`);
    if (stat.size !== descriptor.sizeBytes) {
      throw new CandidateArtifactError(
        'artifact-integrity-failed',
        `Artifact file ${index} size does not match its manifest.`,
      );
    }
    const sha256 = await sha256File(filePath);
    if (sha256 !== descriptor.sha256) {
      throw new CandidateArtifactError(
        'artifact-integrity-failed',
        `Artifact file ${index} hash does not match its manifest.`,
      );
    }
    normalizedFiles.push({
      role: descriptor.role,
      path: relativePath.replaceAll('\\', '/'),
      sha256,
    });
  }
  for (const requiredRole of [
    'merged-flash',
    'elf',
    'source-map',
    'debug-source',
  ]) {
    if (!seenRoles.has(requiredRole)) {
      throw new CandidateArtifactError(
        'artifact-incompatible',
        `Artifact is missing its required ${requiredRole} file.`,
      );
    }
  }
  const primaryFile = requireSafeRelativePath(
    manifest.primaryFile,
    'Artifact primaryFile',
  ).replaceAll('\\', '/');
  if (
    !seenPaths.has(path.normalize(primaryFile))
    || normalizedFiles.find((file) => file.path === primaryFile)?.role
      !== 'merged-flash'
  ) {
    throw new CandidateArtifactError(
      'artifact-incompatible',
      'Artifact primaryFile must reference the merged flash image.',
    );
  }

  const computedArtifactId = computeArtifactId(manifest, normalizedFiles);
  if (computedArtifactId !== manifest.artifactId) {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      'Artifact id is not derived from the declared build contents.',
    );
  }
  return {
    artifactId: manifest.artifactId,
    graphSemanticRevision: graph?.graphSemanticRevision ?? null,
    target: structuredClone(manifest.target),
    buildEnvironment: manifest.build.environment === undefined
      ? null
      : structuredClone(manifest.build.environment),
  };
}

function computeArtifactId(manifest, files) {
  const hash = crypto.createHash('sha256');
  hash.update(manifest.target.fqbn);
  hash.update('\0');
  hash.update(manifest.build.source.sha256);
  for (const file of files) {
    hash.update('\0');
    hash.update(file.role);
    hash.update('\0');
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.sha256);
  }
  if (manifest.flash?.layout) {
    hash.update('\0esp32-flash-layout\0');
    hash.update(JSON.stringify(manifest.flash.layout));
  }
  if (manifest.build.environment) {
    hash.update('\0esp32-build-environment\0');
    hash.update(JSON.stringify(manifest.build.environment));
  }
  if (manifest.build.graph) {
    hash.update('\0scene-graph-provenance\0');
    hash.update(JSON.stringify(manifest.build.graph));
  }
  return hash.digest('hex');
}

function requireCompatibleTarget(baseline, candidate) {
  for (const key of ['fqbn', 'architecture', 'boardId', 'mcu']) {
    if ((baseline[key] ?? null) !== (candidate[key] ?? null)) {
      throw new CandidateArtifactError(
        'artifact-incompatible',
        `Candidate Artifact target ${key} changed.`,
      );
    }
  }
}

function requireCompatibleBuildEnvironment(baseline, candidate) {
  if (JSON.stringify(baseline) !== JSON.stringify(candidate)) {
    throw new CandidateArtifactError(
      'artifact-incompatible',
      'Candidate Artifact build environment changed.',
    );
  }
}

async function requireRegularFile(filePath, label) {
  const stat = await fs.promises.lstat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new CandidateArtifactError(
      'artifact-unavailable',
      `${label} is not a regular file.`,
    );
  }
  return stat;
}

function requireSafeRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 512
    || path.isAbsolute(value)
    || value.includes('\0')
  ) {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      `${label} is invalid.`,
    );
  }
  const normalized = path.normalize(value);
  if (
    normalized === '..'
    || normalized.startsWith(`..${path.sep}`)
  ) {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      `${label} escapes the Artifact directory.`,
    );
  }
  return normalized;
}

function requireInside(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      `${label} escapes its trusted root.`,
    );
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      `${label} is invalid.`,
    );
  }
  return value;
}

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CandidateArtifactError(
      'artifact-integrity-failed',
      `${label} is invalid.`,
    );
  }
  return value;
}

function normalizeCoordinatorError(error) {
  if (error instanceof CandidateArtifactError) return error.code;
  return 'build-failed';
}

function publicState(ticket) {
  return {
    state: ticket.state,
    requestId: ticket.request.requestId,
    sceneRevision: ticket.request.sceneRevision,
    ...(ticket.candidate ? { candidate: structuredClone(ticket.candidate) } : {}),
    ...(ticket.errorCode ? { errorCode: ticket.errorCode } : {}),
  };
}

class CandidateArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CandidateArtifactError';
    this.code = code;
  }
}

module.exports = {
  ARTIFACT_MANIFEST_MAX_BYTES,
  PROJECT_REBUILD_RESULT_SCHEMA_VERSION,
  CandidateArtifactError,
  computeArtifactId,
  createRendererRequest,
  createSimulatorProjectRebuildCoordinator,
  inspectProjectArtifact,
  validateProjectRebuildResult,
};
