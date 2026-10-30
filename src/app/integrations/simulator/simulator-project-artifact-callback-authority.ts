import { readSimulatorLegacyCircuit } from './simulator-legacy-circuit-reader';

import {
  SimulatorHostArtifactChunkError,
  SimulatorHostProviderOperationError,
  createPortableRandomId,
  type SimulatorHostArtifactChunk,
  type SimulatorProjectHostProviderAdapterOptions,
} from '@aily-project/simulator-host-sdk';

import {
  createProjectSceneHeadV1,
  encodeProjectSceneHeadV1,
  validateProjectSceneHeadV1,
  validateProjectSceneNetworkDescriptorV2,
  type ProjectSceneHeadV1,
  type ProjectSceneNetworkDescriptorV2,
} from '@aily-project/simulator-protocol/scene';

import {
  validateSimulationArtifact,
  type SimulationArtifact,
} from '@aily-project/simulator-protocol/artifact';

import { validateSimulatorSubappHostArtifactDescriptorV1 } from '@aily-project/simulator-protocol/host';

import type {
  SimulatorSubappHostArtifactChunkRequestV1,
  SimulatorSubappHostArtifactDescriptorV1,
  SimulatorSubappHostProjectArtifactReadV1,
  SimulatorSubappHostProjectContextReadV1,
  SimulatorSubappHostProjectContextSnapshotV1,
  SimulatorSubappHostProjectSceneReadV1,
  SimulatorSubappHostProjectSceneReadResultV1,
  SimulatorSubappHostProjectSceneWriteV1,
} from '@aily-project/simulator-protocol/host';

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

  replaceFileAtomic(
    projectRoot: string,
    relativePath: string,
    expectedBytes: Uint8Array | null,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<boolean>;

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

  readWorkspaceSource?: (signal: AbortSignal) => Promise<{
    sha256: string;

    isCurrent(): boolean;
  } | null>;
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

interface StoredScene { head: ProjectSceneHeadV1; bytes: Uint8Array }

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
    | 'readArtifact'
    | 'readArtifactChunk'
  >;

  private readonly projectRoot: string;
  private readonly sceneFilePath: string;
  private readonly buildRoot: string;
  private readonly manifestFilePath: string;
  private readonly files: SimulatorProjectArtifactFilePort;

  private readonly now: () => number;
  private readonly artifactReferenceTtlMs: number;
  private readonly maxArtifactReferences: number;

  private readonly createArtifactReference: () => string;
  private readonly createSceneCommitId: () => string;
  private readonly readWorkspaceSource: NonNullable<SimulatorProjectArtifactCallbackAuthorityOptions['readWorkspaceSource']>;
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

    this.readWorkspaceSource = options.readWorkspaceSource
      ?? (async () => null);

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

  hasArtifactReference(reference: string): boolean {
    return this.artifactReferences.has(reference);
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;

    this.artifactReferences.clear();
  }

  /** Local capability over this exact issued reference, never a wire claim or
   * a renewed lease. Cached verified bytes still require its original TTL. */
  captureArtifactReadValidity(descriptor: SimulatorSubappHostArtifactDescriptorV1): Readonly<{ requireCurrent(): void }> {
    const value = validateSimulatorSubappHostArtifactDescriptorV1(descriptor);
    const reference = this.artifactReferences.get(value.artifactReference);

    if (!reference || value.projectIdentity !== this.projectIdentity
      || value.artifactRevision !== reference.artifactRevision
      || value.expiresAtUnixMs !== reference.expiresAtUnixMs
      || value.fileCount !== reference.artifact.files.length
      || value.totalSizeBytes !== reference.artifact.files.reduce((total, file) => total + file.sizeBytes, 0)
      || JSON.stringify(value.artifact) !== JSON.stringify(reference.artifact)) {
      throw new SimulatorHostArtifactChunkError('reference-not-found');
    }

    const requireCurrent = () => {
      if (this.closed) throw new SimulatorHostProviderOperationError('cancelled');
      if (reference.expiresAtUnixMs <= this.requireNow()) throw new SimulatorHostArtifactChunkError('reference-expired');

      if (this.artifactReferences.get(reference.artifactReference) !== reference) {
        throw new SimulatorHostArtifactChunkError('reference-not-found');
      }
    };

    requireCurrent();

    return Object.freeze({ requireCurrent });
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
      this.readStoredScene(signal, true).catch((error: unknown) => {
        logProjectArtifactReadFailure('context-scene', error);

        throw error;
      }),
      this.readManifest(signal, true).catch((error: unknown) => {
        logProjectArtifactReadFailure('context-manifest', error);

        throw error;
      }),
    ]);

    this.requireActive(signal);

    const source = await this.readWorkspaceSource(signal);
    const currentArtifact = await this.readManifest(signal, true);

    this.requireActive(signal);

    // A build can finish while source hashing awaits. Never authorize an old
    // identity observed before that build; this is a bounded request recheck,
    // not an atomic snapshot or a new persistent authority.
    const activeArtifactRevision = artifact?.artifactId === currentArtifact?.artifactId
      ? currentArtifact?.artifactId ?? null
      : null;

    return {
      schemaVersion: 1,
      kind: 'aily-simulator-host-project-context-snapshot',
      projectIdentity: this.projectIdentity,
      workspaceIdentity: this.workspaceIdentity,
      activeSceneId: this.sceneId,
      activeArtifactRevision,
      workspaceSourceSha256: source?.isCurrent() ? source.sha256 : null,
    };
  }

  private async readScene(
    request: SimulatorSubappHostProjectSceneReadV1,
    signal: AbortSignal,
  ): Promise<SimulatorSubappHostProjectSceneReadResultV1> {
    this.requireSceneScope(request.projectIdentity, request.sceneId);
    this.requireActive(signal);

    const scene = await this.readStoredScene(signal, true, true);

    if (!scene) {
      return {
        schemaVersion: 1,
        kind: 'aily-simulator-host-project-scene-missing',
        projectIdentity: this.projectIdentity,
        sceneId: this.sceneId,
      };
    }

    return structuredClone(scene.head.descriptor);
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

      const current = await this.readStoredScene(signal, true, true);

      const currentRevision = current?.head.descriptor.storageRevision
        ?? EMPTY_STORAGE_REVISION;

      if (currentRevision !== request.expectedStorageRevision) {
        throw new SimulatorHostProviderOperationError('conflict');
      }

      const commitId = requirePortableIdentifier(
        this.createSceneCommitId(),
        'scene commitId',
      );

      const stored = await createProjectSceneHeadV1({ commitId, descriptor: input });
      const descriptor = stored.descriptor;

      if (descriptor.storageRevision === currentRevision) {
        throw new SimulatorHostProviderOperationError('conflict');
      }

      const bytes = encodeProjectSceneHeadV1(stored);

      if (bytes.byteLength > MAX_SCENE_BYTES) {
        throw new SimulatorHostProviderOperationError('invalid-request');
      }

      const replaced = await this.files.replaceFileAtomic(this.projectRoot,
        '.aily/simulator/scene-network-v2.json', current?.bytes ?? null, bytes, signal);

      this.requireActive(signal);

      if (!replaced) throw new SimulatorHostProviderOperationError('conflict');

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
    importLegacy = false,
  ): Promise<StoredScene | null> {
    const bytes = await this.readRegularFile(
      this.sceneFilePath,
      MAX_SCENE_BYTES,
      signal,
      allowMissing,
    );

    if (!bytes) {
      if (!importLegacy) return null;

      const document = await readSimulatorLegacyCircuit({
        projectRoot: this.projectRoot, sceneId: this.sceneId, files: this.files,
      }, signal);

      this.requireActive(signal);

      if (!document) return null;

      const head = await createProjectSceneHeadV1({
        commitId: `connection-import-${document.visualRevision}`,
        descriptor: {
          schemaVersion: 1, kind: 'aily-project-scene-network-descriptor',
          projectIdentity: this.projectIdentity, sceneId: this.sceneId,
          storageRevision: EMPTY_STORAGE_REVISION, document,
          runtimeAttachment: null, artifactAlignment: 'detached',
        },
      });

      // Opening an old diagram is read-only. The first edit publishes V2 with create-only CAS.
      return { head, bytes: null };
    }

    let value: unknown;

    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }

    try {
      const head = await validateProjectSceneHeadV1(value, {
        projectIdentity: this.projectIdentity,
        sceneId: this.sceneId,
      });

      return { head, bytes };
    } catch {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
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
    || typeof value.replaceFileAtomic !== 'function'
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

function logProjectArtifactReadFailure(stage: string, error: unknown): void {
  const record = error !== null && typeof error === 'object'
    ? error as { name?: unknown; code?: unknown }
    : null;

  console.error('[SimulatorHost][ProjectArtifactReadFailed]', JSON.stringify({
    stage,
    errorName: typeof record?.name === 'string'
      ? record.name.slice(0, 80)
      : null,
    errorCode: typeof record?.code === 'string'
      ? record.code.slice(0, 80)
      : null,
    rendererRealmError: error instanceof Error,
  }));
}
