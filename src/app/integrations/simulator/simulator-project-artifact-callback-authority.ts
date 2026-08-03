import {
  SimulatorHostArtifactChunkError,
  SimulatorHostProviderOperationError,
  SIMULATOR_SUBAPP_CONTROL_MAX_CONNECTION_GRAPH_BYTES,
  createPortableRandomId,
  validateProjectSceneNetworkDescriptorV2,
  validateSimulationArtifact,
  type ProjectSceneNetworkDescriptorV2,
  type SimulationArtifact,
  type SimulatorHostArtifactChunk,
  type SimulatorProjectHostProviderAdapterOptions,
  type SimulatorSubappHostArtifactChunkRequestV1,
  type SimulatorSubappHostArtifactDescriptorV1,
  type SimulatorSubappHostProjectArtifactReadV1,
  type SimulatorSubappHostProjectContextReadV1,
  type SimulatorSubappHostProjectContextSnapshotV1,
  type SimulatorSubappHostProjectLegacySceneInspectV1,
  type SimulatorSubappHostProjectLegacySceneSnapshotV1,
  type SimulatorSubappHostProjectSceneReadV1,
  type SimulatorSubappHostProjectSceneReadResultV1,
  type SimulatorSubappHostProjectSceneWriteV1,
} from '@aily-project/simulator-host-sdk';

const EMPTY_STORAGE_REVISION = '0'.repeat(64);
const DEFAULT_ARTIFACT_REFERENCE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ARTIFACT_REFERENCES = 16;
const MAX_SCENE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface SimulatorProjectArtifactFileStat {
  size: number;
  isFile: boolean;
  isSymbolicLink: boolean;
}

/**
 * This is deliberately a narrow, injectable filesystem boundary. The concrete
 * Electron implementation must keep atomic replacement and realpath checks in
 * the trusted Host; neither a Runtime request nor an iframe supplies a path.
 */
export interface SimulatorProjectArtifactFilePort {
  join(...segments: string[]): string;
  resolve(...segments: string[]): string;
  relative(from: string, to: string): string;
  readFile(filePath: string, signal: AbortSignal): Promise<Uint8Array>;
  writeFileAtomic(
    filePath: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
  lstat(
    filePath: string,
    signal: AbortSignal,
  ): Promise<SimulatorProjectArtifactFileStat>;
  realpath(filePath: string, signal: AbortSignal): Promise<string>;
}

export interface SimulatorProjectArtifactCallbackAuthorityOptions {
  projectRoot: string;
  projectIdentity: string;
  workspaceIdentity: string;
  sceneId?: string;
  files: SimulatorProjectArtifactFilePort;
  now?: () => number;
  artifactReferenceTtlMs?: number;
  maxArtifactReferences?: number;
  createArtifactReference?: () => string;
  createSceneCommitId?: () => string;
}

interface StoredSceneHeadV1 {
  schemaVersion: 1;
  kind: 'aily-blockly-simulator-project-scene-head';
  commitId: string;
  descriptor: ProjectSceneNetworkDescriptorV2;
}

interface ArtifactReference {
  projectIdentity: string;
  artifactReference: string;
  artifactRevision: string;
  artifact: SimulationArtifact;
  expiresAtUnixMs: number;
  buildRootRealPath: string;
  files: ReadonlyMap<string, ArtifactReferenceFile>;
}

interface ArtifactReferenceFile {
  readonly filePath: string;
  readonly sizeBytes: number;
  bytesPromise: Promise<Uint8Array> | null;
}

/**
 * Project-scoped callback authority used behind the framework-neutral Host
 * SDK. It owns only Host project persistence and Artifact handles. It does not
 * launch or control the Simulator, QEMU, GDB, a Scene session, or an iframe.
 */
export class SimulatorProjectArtifactCallbackAuthority {
  readonly projectIdentity: string;
  readonly workspaceIdentity: string;
  readonly sceneId: string;
  readonly callbacks: Pick<
    SimulatorProjectHostProviderAdapterOptions,
    | 'readContext'
    | 'readScene'
    | 'writeScene'
    | 'inspectLegacyScene'
    | 'readArtifact'
    | 'readArtifactChunk'
  >;

  private readonly projectRoot: string;
  private readonly sceneFilePath: string;
  private readonly legacyConnectionGraphFilePath: string;
  private readonly buildRoot: string;
  private readonly manifestFilePath: string;
  private readonly files: SimulatorProjectArtifactFilePort;
  private readonly now: () => number;
  private readonly artifactReferenceTtlMs: number;
  private readonly maxArtifactReferences: number;
  private readonly createArtifactReference: () => string;
  private readonly createSceneCommitId: () => string;
  private readonly artifactReferences = new Map<string, ArtifactReference>();
  private operationTail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: SimulatorProjectArtifactCallbackAuthorityOptions) {
    this.files = requireFilePort(options.files);
    this.projectRoot = this.files.resolve(
      requireNonEmpty(options.projectRoot, 'projectRoot'),
    );
    this.projectIdentity = requirePortableIdentifier(
      options.projectIdentity,
      'projectIdentity',
    );
    this.workspaceIdentity = requirePortableIdentifier(
      options.workspaceIdentity,
      'workspaceIdentity',
    );
    this.sceneId = requirePortableIdentifier(options.sceneId ?? 'main', 'sceneId');
    this.sceneFilePath = this.files.join(
      this.projectRoot,
      '.aily',
      'simulator',
      'scene-network-v2.json',
    );
    this.legacyConnectionGraphFilePath = this.files.join(
      this.projectRoot,
      'connection_output.json',
    );
    this.buildRoot = this.files.join(this.projectRoot, '.build');
    this.manifestFilePath = this.files.join(
      this.buildRoot,
      'aily-artifact-manifest.json',
    );
    this.now = options.now ?? Date.now;
    this.artifactReferenceTtlMs = requireIntegerInRange(
      options.artifactReferenceTtlMs ?? DEFAULT_ARTIFACT_REFERENCE_TTL_MS,
      1_000,
      10 * 60_000,
      'artifactReferenceTtlMs',
    );
    this.maxArtifactReferences = requireIntegerInRange(
      options.maxArtifactReferences ?? DEFAULT_MAX_ARTIFACT_REFERENCES,
      1,
      128,
      'maxArtifactReferences',
    );
    this.createArtifactReference = options.createArtifactReference
      ?? (() => createPortableRandomId('host-artifact-v1'));
    this.createSceneCommitId = options.createSceneCommitId
      ?? (() => createPortableRandomId('scene-commit-v1'));
    this.callbacks = Object.freeze({
      readContext: (
        request: SimulatorSubappHostProjectContextReadV1,
        signal: AbortSignal,
      ) => this.readContext(request, signal),
      readScene: (
        request: SimulatorSubappHostProjectSceneReadV1,
        signal: AbortSignal,
      ) => this.readScene(request, signal),
      writeScene: (
        request: SimulatorSubappHostProjectSceneWriteV1,
        signal: AbortSignal,
      ) => this.writeScene(request, signal),
      inspectLegacyScene: (
        request: SimulatorSubappHostProjectLegacySceneInspectV1,
        signal: AbortSignal,
      ) => this.inspectLegacyScene(request, signal),
      readArtifact: (
        request: SimulatorSubappHostProjectArtifactReadV1,
        signal: AbortSignal,
      ) => this.readArtifact(request, signal),
      readArtifactChunk: (
        request: SimulatorSubappHostArtifactChunkRequestV1,
        signal: AbortSignal,
      ) => this.readArtifactChunk(request, signal),
    });
  }

  snapshot(): Readonly<{
    closed: boolean;
    projectIdentity: string;
    sceneId: string;
    activeArtifactReferences: number;
  }> {
    this.pruneArtifactReferences();
    return Object.freeze({
      closed: this.closed,
      projectIdentity: this.projectIdentity,
      sceneId: this.sceneId,
      activeArtifactReferences: this.artifactReferences.size,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.artifactReferences.clear();
  }

  private async readContext(
    request: SimulatorSubappHostProjectContextReadV1,
    signal: AbortSignal,
  ): Promise<SimulatorSubappHostProjectContextSnapshotV1> {
    if (request.projectIdentity !== null) {
      this.requireProject(request.projectIdentity);
    }
    this.requireActive(signal);
    const [, artifact] = await Promise.all([
      this.readStoredScene(signal, true),
      this.readManifest(signal, true),
    ]);
    this.requireActive(signal);
    return {
      schemaVersion: 1,
      kind: 'aily-simulator-host-project-context-snapshot',
      projectIdentity: this.projectIdentity,
      workspaceIdentity: this.workspaceIdentity,
      activeSceneId: this.sceneId,
      activeArtifactRevision: artifact?.artifactId ?? null,
    };
  }

  private async readScene(
    request: SimulatorSubappHostProjectSceneReadV1,
    signal: AbortSignal,
  ): Promise<SimulatorSubappHostProjectSceneReadResultV1> {
    this.requireSceneScope(request.projectIdentity, request.sceneId);
    this.requireActive(signal);
    const scene = await this.readStoredScene(signal, true);
    if (!scene) {
      return {
        schemaVersion: 1,
        kind: 'aily-simulator-host-project-scene-missing',
        projectIdentity: this.projectIdentity,
        sceneId: this.sceneId,
      };
    }
    return structuredClone(scene.descriptor);
  }

  private async inspectLegacyScene(
    request: SimulatorSubappHostProjectLegacySceneInspectV1,
    signal: AbortSignal,
  ): Promise<SimulatorSubappHostProjectLegacySceneSnapshotV1> {
    this.requireSceneScope(request.projectIdentity, request.sceneId);
    const bytes = await this.readRegularFile(
      this.legacyConnectionGraphFilePath,
      SIMULATOR_SUBAPP_CONTROL_MAX_CONNECTION_GRAPH_BYTES,
      signal,
      true,
    );
    return {
      schemaVersion: 1,
      kind: 'aily-simulator-host-project-legacy-scene-snapshot',
      projectIdentity: this.projectIdentity,
      sceneId: this.sceneId,
      legacySource: bytes
        ? {
            kind: 'connection-output-v1',
            revision: await digestBytes(bytes),
            bytes: bytes.byteLength,
          }
        : null,
    };
  }

  private writeScene(
    request: SimulatorSubappHostProjectSceneWriteV1,
    signal: AbortSignal,
  ): Promise<ProjectSceneNetworkDescriptorV2> {
    this.requireSceneScope(request.projectIdentity, request.sceneId);
    return this.enqueue(async () => {
      this.requireActive(signal);
      const input = await validateProjectSceneNetworkDescriptorV2(
        structuredClone(request.descriptor),
      );
      if (
        input.projectIdentity !== this.projectIdentity
        || input.sceneId !== this.sceneId
        || input.storageRevision !== request.expectedStorageRevision
        || input.runtimeAttachment !== null
      ) {
        throw new SimulatorHostProviderOperationError('invalid-request');
      }
      const current = await this.readStoredScene(signal, true);
      const currentRevision = current?.descriptor.storageRevision
        ?? EMPTY_STORAGE_REVISION;
      if (currentRevision !== request.expectedStorageRevision) {
        throw new SimulatorHostProviderOperationError('conflict');
      }
      const commitId = requirePortableIdentifier(
        this.createSceneCommitId(),
        'scene commitId',
      );
      const nextStorageRevision = await digestJson({
        schemaVersion: 1,
        kind: 'aily-blockly-simulator-project-scene-revision',
        commitId,
        projectIdentity: this.projectIdentity,
        sceneId: this.sceneId,
        document: input.document,
        artifactAlignment: input.artifactAlignment,
      });
      if (nextStorageRevision === currentRevision) {
        throw new SimulatorHostProviderOperationError('conflict');
      }
      const descriptor = await validateProjectSceneNetworkDescriptorV2({
        ...structuredClone(input),
        storageRevision: nextStorageRevision,
        runtimeAttachment: null,
      });
      const stored: StoredSceneHeadV1 = {
        schemaVersion: 1,
        kind: 'aily-blockly-simulator-project-scene-head',
        commitId,
        descriptor,
      };
      const bytes = new TextEncoder().encode(`${JSON.stringify(stored, null, 2)}\n`);
      if (bytes.byteLength > MAX_SCENE_BYTES) {
        throw new SimulatorHostProviderOperationError('invalid-request');
      }
      await this.files.writeFileAtomic(this.sceneFilePath, bytes, signal);
      this.requireActive(signal);
      return structuredClone(descriptor);
    });
  }

  private async readArtifact(
    request: SimulatorSubappHostProjectArtifactReadV1,
    signal: AbortSignal,
  ): Promise<SimulatorSubappHostArtifactDescriptorV1> {
    this.requireProject(request.projectIdentity);
    this.requireActive(signal);
    const artifact = await this.readManifest(signal, false);
    if (!artifact) {
      throw new SimulatorHostProviderOperationError(
        'operation-failed',
        'Project Artifact manifest is not available.',
      );
    }
    const artifactRevision = artifact.artifactId;
    if (
      request.artifactRevision !== null
      && request.artifactRevision !== artifactRevision
    ) {
      throw new SimulatorHostProviderOperationError('conflict');
    }
    const reference = await this.createReference(artifact, signal);
    return descriptorFromReference(reference);
  }

  private async readArtifactChunk(
    request: SimulatorSubappHostArtifactChunkRequestV1,
    signal: AbortSignal,
  ): Promise<SimulatorHostArtifactChunk> {
    this.requireActive(signal);
    this.requireProject(request.projectIdentity);
    this.pruneArtifactReferences();
    const reference = this.artifactReferences.get(request.artifactReference);
    if (!reference) {
      throw new SimulatorHostArtifactChunkError('reference-not-found');
    }
    if (reference.expiresAtUnixMs <= this.requireNow()) {
      this.artifactReferences.delete(reference.artifactReference);
      throw new SimulatorHostArtifactChunkError('reference-expired');
    }
    if (
      reference.projectIdentity !== request.projectIdentity
      || reference.artifactRevision !== request.artifactRevision
    ) {
      throw new SimulatorHostArtifactChunkError('reference-not-found');
    }
    const file = reference.files.get(request.path);
    if (!file) throw new SimulatorHostArtifactChunkError('file-not-found');
    if (request.offsetBytes < 0 || request.offsetBytes >= file.sizeBytes) {
      throw new SimulatorHostArtifactChunkError('range-invalid');
    }
    const bytesPromise = file.bytesPromise
      ?? this.files.readFile(file.filePath, signal);
    file.bytesPromise = bytesPromise;
    let bytes: Uint8Array;
    try {
      bytes = await bytesPromise;
    } catch (error) {
      if (file.bytesPromise === bytesPromise) file.bytesPromise = null;
      throw error;
    }
    this.requireActive(signal);
    if (bytes.byteLength !== file.sizeBytes) {
      if (file.bytesPromise === bytesPromise) file.bytesPromise = null;
      throw new SimulatorHostArtifactChunkError('transfer-failed');
    }
    const end = Math.min(
      request.offsetBytes + request.maxBytes,
      file.sizeBytes,
    );
    const data = bytes.slice(request.offsetBytes, end);
    if (data.byteLength < 1) {
      throw new SimulatorHostArtifactChunkError('range-invalid');
    }
    if (end === file.sizeBytes && file.bytesPromise === bytesPromise) {
      file.bytesPromise = null;
    }
    return {
      data,
      eof: end === file.sizeBytes,
    };
  }

  private async readStoredScene(
    signal: AbortSignal,
    allowMissing: boolean,
  ): Promise<StoredSceneHeadV1 | null> {
    const bytes = await this.readRegularFile(
      this.sceneFilePath,
      MAX_SCENE_BYTES,
      signal,
      allowMissing,
    );
    if (!bytes) return null;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    const record = asRecord(value);
    if (
      !record
      || exactKeys(record) !== exactKeys({
        schemaVersion: 1,
        kind: '',
        commitId: '',
        descriptor: null,
      })
      || record['schemaVersion'] !== 1
      || record['kind'] !== 'aily-blockly-simulator-project-scene-head'
    ) {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    const commitId = requirePortableIdentifier(record['commitId'], 'scene commitId');
    const descriptor = await validateProjectSceneNetworkDescriptorV2(
      record['descriptor'],
    );
    if (
      descriptor.projectIdentity !== this.projectIdentity
      || descriptor.sceneId !== this.sceneId
      || descriptor.runtimeAttachment !== null
    ) {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    const expectedRevision = await digestJson({
      schemaVersion: 1,
      kind: 'aily-blockly-simulator-project-scene-revision',
      commitId,
      projectIdentity: this.projectIdentity,
      sceneId: this.sceneId,
      document: descriptor.document,
      artifactAlignment: descriptor.artifactAlignment,
    });
    if (descriptor.storageRevision !== expectedRevision) {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    return {
      schemaVersion: 1,
      kind: 'aily-blockly-simulator-project-scene-head',
      commitId,
      descriptor,
    };
  }

  private async readManifest(
    signal: AbortSignal,
    allowMissing: boolean,
  ): Promise<SimulationArtifact | null> {
    const bytes = await this.readRegularFile(
      this.manifestFilePath,
      MAX_MANIFEST_BYTES,
      signal,
      allowMissing,
    );
    if (!bytes) return null;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    return validateSimulationArtifact(value);
  }

  private async createReference(
    artifact: SimulationArtifact,
    signal: AbortSignal,
  ): Promise<ArtifactReference> {
    const buildRootRealPath = await this.files.realpath(this.buildRoot, signal);
    const fileEntries = new Map<string, ArtifactReferenceFile>();
    for (const file of artifact.files) {
      const relativePath = requirePortableArtifactPath(file.path);
      const filePath = this.files.resolve(
        this.buildRoot,
        ...relativePath.split('/'),
      );
      const fileRealPath = await this.files.realpath(filePath, signal);
      if (!isInside(this.files, buildRootRealPath, fileRealPath)) {
        throw new SimulatorHostProviderOperationError('operation-failed');
      }
      const stat = await this.files.lstat(fileRealPath, signal);
      if (
        stat.isSymbolicLink
        || !stat.isFile
        || stat.size !== file.sizeBytes
      ) {
        throw new SimulatorHostProviderOperationError('operation-failed');
      }
      fileEntries.set(relativePath, {
        filePath: fileRealPath,
        sizeBytes: file.sizeBytes,
        bytesPromise: null,
      });
    }
    const now = this.requireNow();
    const artifactReference = requireArtifactReference(
      this.createArtifactReference(),
    );
    const reference: ArtifactReference = {
      projectIdentity: this.projectIdentity,
      artifactReference,
      artifactRevision: artifact.artifactId,
      artifact: structuredClone(artifact),
      expiresAtUnixMs: now + this.artifactReferenceTtlMs,
      buildRootRealPath,
      files: fileEntries,
    };
    this.pruneArtifactReferences();
    while (this.artifactReferences.size >= this.maxArtifactReferences) {
      const oldest = this.artifactReferences.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.artifactReferences.delete(oldest);
    }
    this.artifactReferences.set(artifactReference, reference);
    return reference;
  }

  private async readRegularFile(
    filePath: string,
    maxBytes: number,
    signal: AbortSignal,
    allowMissing: boolean,
  ): Promise<Uint8Array | null> {
    this.requireActive(signal);
    let stat: SimulatorProjectArtifactFileStat;
    try {
      stat = await this.files.lstat(filePath, signal);
    } catch (error) {
      if (allowMissing && isMissingFileError(error)) return null;
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    if (
      stat.isSymbolicLink
      || !stat.isFile
      || stat.size < 1
      || stat.size > maxBytes
    ) {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    const projectRootRealPath = await this.files.realpath(
      this.projectRoot,
      signal,
    );
    const fileRealPath = await this.files.realpath(filePath, signal);
    if (!isInside(this.files, projectRootRealPath, fileRealPath)) {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    const bytes = await this.files.readFile(fileRealPath, signal);
    this.requireActive(signal);
    if (bytes.byteLength !== stat.size || bytes.byteLength > maxBytes) {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    return bytes;
  }

  private requireProject(projectIdentity: string): void {
    if (projectIdentity !== this.projectIdentity) {
      throw new SimulatorHostProviderOperationError('conflict');
    }
  }

  private requireSceneScope(projectIdentity: string, sceneId: string): void {
    this.requireProject(projectIdentity);
    if (sceneId !== this.sceneId) {
      throw new SimulatorHostProviderOperationError('conflict');
    }
  }

  private requireActive(signal: AbortSignal): void {
    if (this.closed || signal.aborted) {
      throw new SimulatorHostProviderOperationError('cancelled');
    }
  }

  private requireNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Project Artifact authority clock is invalid.');
    }
    return value;
  }

  private pruneArtifactReferences(): void {
    const now = this.requireNow();
    for (const [reference, value] of this.artifactReferences) {
      if (value.expiresAtUnixMs <= now) {
        this.artifactReferences.delete(reference);
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function simulatorEmptyProjectSceneStorageRevision(): string {
  return EMPTY_STORAGE_REVISION;
}

function descriptorFromReference(
  reference: ArtifactReference,
): SimulatorSubappHostArtifactDescriptorV1 {
  return {
    schemaVersion: 1,
    kind: 'aily-simulator-host-artifact-descriptor',
    projectIdentity: reference.projectIdentity,
    artifactReference: reference.artifactReference,
    artifactRevision: reference.artifactRevision,
    artifact: structuredClone(reference.artifact),
    fileCount: reference.artifact.files.length,
    totalSizeBytes: reference.artifact.files.reduce(
      (total, file) => total + file.sizeBytes,
      0,
    ),
    expiresAtUnixMs: reference.expiresAtUnixMs,
  };
}

function requireFilePort(
  value: SimulatorProjectArtifactFilePort,
): SimulatorProjectArtifactFilePort {
  if (
    !value
    || typeof value.join !== 'function'
    || typeof value.resolve !== 'function'
    || typeof value.relative !== 'function'
    || typeof value.readFile !== 'function'
    || typeof value.writeFileAtomic !== 'function'
    || typeof value.lstat !== 'function'
    || typeof value.realpath !== 'function'
  ) {
    throw new TypeError('Project Artifact filesystem port is invalid.');
  }
  return value;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length < 1) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function requirePortableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireArtifactReference(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^host-artifact-v1-[a-f0-9]{64}$/u.test(value)
  ) {
    throw new TypeError('Artifact reference factory returned an invalid value.');
  }
  return value;
}

function requireIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be in ${minimum}..${maximum}.`);
  }
  return value;
}

function requirePortableArtifactPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 1_024
    || value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:/u.test(value)
  ) {
    throw new SimulatorHostProviderOperationError('operation-failed');
  }
  const segments = value.split('/');
  if (
    segments.some((segment) => (
      segment.length < 1 || segment === '.' || segment === '..'
    ))
  ) {
    throw new SimulatorHostProviderOperationError('operation-failed');
  }
  return segments.join('/');
}

function isInside(
  files: Pick<SimulatorProjectArtifactFilePort, 'relative'>,
  rootPath: string,
  childPath: string,
): boolean {
  const relative = files.relative(rootPath, childPath);
  return relative === ''
    || (
      relative !== '..'
      && !relative.startsWith(`..\\`)
      && !relative.startsWith('../')
      && !/^[A-Za-z]:/u.test(relative)
    );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join('\0');
}

function isMissingFileError(error: unknown): boolean {
  // Errors crossing Electron's preload/renderer boundary are not guaranteed to
  // preserve the renderer realm's Error prototype. Treat the stable Node error
  // code as the authority so a legitimately missing first Scene/Artifact file
  // remains distinguishable from an actual filesystem failure.
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

async function digestJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  return digestBytes(bytes);
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Value is not serializable.');
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
