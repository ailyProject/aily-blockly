import {
  createProjectDataContainer,
  MAX_PROJECT_DATA_CONTAINER_OVERHEAD,
  parseProjectDataContainer,
  ProjectDataContainerHeader,
} from './project-data-container';
import {
  createDefaultProjectDataCodecRegistry,
  ProjectDataCodecRegistry,
} from './project-data-codec.registry';
import {
  createElectronProjectDataFileSystem,
  ProjectDataFileSystem,
} from './project-data-file-system';
import {
  AilyDataRef,
  AilyDataStorageEncoding,
  areAilyDataRefsEquivalent,
  assertAilyDataRef,
  getAilyDataHash,
  isAilyDataRef,
  ProjectDataError,
  ProjectDataInspection,
  ProjectDataGcResult,
  ProjectDataResourceEntry,
  ProjectDataStatistics,
  ProjectDataValidationIssue,
  ProjectDataValidationResult,
} from './project-data.types';

export interface ProjectDataStoreOptions {
  readonly maxCacheBytes?: number;
}

export interface PutProjectDataRequest<TValue> {
  readonly codec: string;
  readonly storage?: AilyDataStorageEncoding;
  readonly value: TValue;
}

interface CacheEntry {
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly ref: AilyDataRef;
}

const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;
const RESOURCE_ROOT_SEGMENTS = ['assets', 'project-data'] as const;
const RESOURCE_DIRECTORY_PATTERN = /^[a-f0-9]{2}$/;
const RESOURCE_FILE_PATTERN = /^([a-f0-9]{64})\.bin$/;
const MAX_COMPRESSED_STORAGE_OVERHEAD = 1024 * 1024;

export class ProjectDataStore {
  private projectPath = '';
  private projectRoot = '';
  private resourceRoot = '';
  private sessionId = '';
  private readonly pendingReads = new Map<string, Promise<Uint8Array>>();
  private readonly pendingWrites = new Map<string, Promise<AilyDataRef>>();
  private readonly canonicalCache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private readonly maxCacheBytes: number;

  constructor(
    private readonly fileSystem: ProjectDataFileSystem = createElectronProjectDataFileSystem(),
    private readonly codecs: ProjectDataCodecRegistry = createDefaultProjectDataCodecRegistry(),
    options: ProjectDataStoreOptions = {},
  ) {
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
  }

  configure(projectPath: string, sessionId = createSessionId()): void {
    if (!projectPath?.trim()) {
      throw new ProjectDataError('not-configured', 'Project path is required for ProjectDataStore.');
    }
    this.projectPath = projectPath;
    this.projectRoot = this.fileSystem.resolve(projectPath);
    this.resourceRoot = this.fileSystem.resolve(
      this.fileSystem.join(this.projectRoot, ...RESOURCE_ROOT_SEGMENTS),
    );
    this.sessionId = sessionId;
    this.clearCache();
    this.pendingReads.clear();
    this.pendingWrites.clear();
  }

  reset(): void {
    this.projectPath = '';
    this.projectRoot = '';
    this.resourceRoot = '';
    this.sessionId = '';
    this.clearCache();
    this.pendingReads.clear();
    this.pendingWrites.clear();
  }

  isConfigured(): boolean {
    return Boolean(this.projectPath && this.resourceRoot);
  }

  getProjectPath(): string {
    this.assertConfigured();
    return this.projectPath;
  }

  getCodecRegistry(): ProjectDataCodecRegistry {
    return this.codecs;
  }

  async put<TValue>(request: PutProjectDataRequest<TValue>): Promise<AilyDataRef> {
    this.assertConfigured();
    const sessionId = this.sessionId;
    const codec = this.codecs.get<TValue>(request.codec);
    const storage = request.storage ?? 'raw-v1';
    const canonicalBytes = await codec.encode(request.value);
    this.assertSession(sessionId);
    if (canonicalBytes.length > codec.maxRawLength) {
      throw new ProjectDataError('too-large', `Project data exceeds codec limit: ${codec.id}`, {
        rawLength: canonicalBytes.length,
        maxRawLength: codec.maxRawLength,
      });
    }

    const hash = await calculateProjectDataHash(codec.id, storage, canonicalBytes);
    this.assertSession(sessionId);
    const id = `sha256:${hash}` as const;
    const existingWrite = this.pendingWrites.get(id);
    if (existingWrite) return existingWrite;

    const writePromise = this.persistCanonicalBytes({
      id,
      codec: codec.id,
      logicalType: codec.logicalType,
      storage,
      canonicalBytes,
      sessionId,
    });
    this.pendingWrites.set(id, writePromise);
    try {
      return await writePromise;
    } finally {
      if (this.pendingWrites.get(id) === writePromise) this.pendingWrites.delete(id);
    }
  }

  async resolve<TValue>(ref: AilyDataRef): Promise<TValue> {
    assertAilyDataRef(ref);
    const codec = this.codecs.get<TValue>(ref.$ailyData.codec);
    if (codec.logicalType !== ref.$ailyData.logicalType) {
      throw new ProjectDataError('corrupt', 'Project data logical type does not match its codec.', {
        id: ref.$ailyData.id,
      });
    }
    return codec.decode(await this.getCanonicalBytes(ref));
  }

  async getCanonicalBytes(ref: AilyDataRef): Promise<Uint8Array> {
    this.assertConfigured();
    assertAilyDataRef(ref);
    const cached = this.takeFromCache(ref);
    if (cached) return cached.slice();

    const existingRead = this.pendingReads.get(ref.$ailyData.id);
    if (existingRead) return (await existingRead).slice();

    const sessionId = this.sessionId;
    const readPromise = this.readAndValidate(ref, sessionId);
    this.pendingReads.set(ref.$ailyData.id, readPromise);
    try {
      const canonicalBytes = await readPromise;
      return canonicalBytes.slice();
    } finally {
      if (this.pendingReads.get(ref.$ailyData.id) === readPromise) {
        this.pendingReads.delete(ref.$ailyData.id);
      }
    }
  }

  async inspect(ref: AilyDataRef): Promise<ProjectDataInspection> {
    let path = '';
    try {
      assertAilyDataRef(ref);
      path = this.resolveRefPath(ref);
      if (!await this.fileSystem.exists(path)) {
        return { ref, path, exists: false, valid: false, error: 'Resource file is missing.' };
      }
      await this.getCanonicalBytes(ref);
      return { ref, path, exists: true, valid: true };
    } catch (error) {
      return {
        ref,
        path,
        exists: path ? await this.fileSystem.exists(path).catch(() => false) : false,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async validateReferences(refs: readonly AilyDataRef[]): Promise<ProjectDataValidationResult> {
    const issues: ProjectDataValidationIssue[] = [];
    const unique = new Map<string, AilyDataRef>();
    for (const ref of refs) {
      assertAilyDataRef(ref);
      const existing = unique.get(ref.$ailyData.id);
      if (existing && !areAilyDataRefsEquivalent(existing, ref)) {
        throw new ProjectDataError('corrupt', `Conflicting metadata for project data ID: ${ref.$ailyData.id}`);
      }
      unique.set(ref.$ailyData.id, ref);
    }
    await Promise.all([...unique.values()].map(async (ref) => {
      const inspection = await this.inspect(ref);
      if (!inspection.valid) issues.push({ ref, error: inspection.error || 'Unknown project data error.' });
    }));
    return { valid: issues.length === 0, issues };
  }

  collectReferences(value: unknown): AilyDataRef[] {
    const refs = new Map<string, AilyDataRef>();
    const visited = new Set<object>();
    const visit = (current: unknown): void => {
      if (typeof current === 'string' && current.includes('$ailyData') && current.trim().startsWith('{')) {
        try {
          visit(JSON.parse(current));
        } catch (error) {
          throw new ProjectDataError('invalid-ref', 'String containing reserved $ailyData metadata is invalid JSON.', {
            cause: String(error),
          });
        }
        return;
      }
      if (current && typeof current === 'object' && !Array.isArray(current)
        && Object.prototype.hasOwnProperty.call(current, '$ailyData')) {
        assertAilyDataRef(current);
        const existing = refs.get(current.$ailyData.id);
        if (existing && !areAilyDataRefsEquivalent(existing, current)) {
          throw new ProjectDataError('corrupt', `Conflicting metadata for project data ID: ${current.$ailyData.id}`);
        }
        refs.set(current.$ailyData.id, current);
        return;
      }
      if (!current || typeof current !== 'object' || visited.has(current)) return;
      visited.add(current);
      if (Array.isArray(current)) {
        for (const item of current) visit(item);
      } else {
        for (const item of Object.values(current as Record<string, unknown>)) visit(item);
      }
    };
    visit(value);
    return [...refs.values()];
  }

  async flushPending(): Promise<void> {
    await Promise.all([...this.pendingWrites.values()]);
  }

  async exportContainer(ref: AilyDataRef): Promise<Uint8Array> {
    const sessionId = this.sessionId;
    await this.readAndValidate(ref, sessionId);
    this.assertSession(sessionId);
    return this.fileSystem.readBinary(this.resolveRefPath(ref));
  }

  async importContainer(ref: AilyDataRef, containerBytes: Uint8Array): Promise<void> {
    this.assertConfigured();
    assertAilyDataRef(ref);
    this.assertRefWithinCodecLimits(ref);
    if (containerBytes.length > ref.$ailyData.storedLength + MAX_PROJECT_DATA_CONTAINER_OVERHEAD) {
      throw new ProjectDataError('too-large', `Imported project data container exceeds its declared size: ${ref.$ailyData.id}`);
    }
    const sessionId = this.sessionId;
    const parsed = parseProjectDataContainer(containerBytes);
    assertHeaderMatchesRef(parsed.header, ref);
    const canonicalBytes = await decodeStorage(
      ref.$ailyData.storage,
      parsed.storedPayload,
      ref.$ailyData.rawLength,
    );
    this.assertSession(sessionId);
    if (canonicalBytes.length !== ref.$ailyData.rawLength) {
      throw new ProjectDataError('corrupt', `Imported project data raw length mismatch: ${ref.$ailyData.id}`);
    }
    const hash = await calculateProjectDataHash(ref.$ailyData.codec, ref.$ailyData.storage, canonicalBytes);
    this.assertSession(sessionId);
    if (`sha256:${hash}` !== ref.$ailyData.id) {
      throw new ProjectDataError('corrupt', `Imported project data hash mismatch: ${ref.$ailyData.id}`);
    }

    const finalPath = this.resolveRefPath(ref);
    if (await this.fileSystem.exists(finalPath)) {
      await this.readAndValidate(ref, sessionId);
      return;
    }
    await this.fileSystem.mkdir(this.fileSystem.dirname(finalPath));
    await this.assertNoSymbolicLinks(this.fileSystem.dirname(finalPath));
    const tempPath = `${finalPath}.${sessionId}.${createSessionId()}.tmp`;
    this.assertInsideResourceRoot(tempPath);
    try {
      await this.fileSystem.writeBinary(tempPath, containerBytes);
      this.assertSession(sessionId);
      try {
        await this.fileSystem.rename(tempPath, finalPath);
      } catch (error) {
        if (!await this.fileSystem.exists(finalPath)) throw error;
      }
      await this.readAndValidate(ref, sessionId);
    } finally {
      if (await this.fileSystem.exists(tempPath).catch(() => false)) {
        await this.fileSystem.unlink(tempPath).catch(() => undefined);
      }
    }
  }

  async getStatistics(refs: readonly AilyDataRef[]): Promise<ProjectDataStatistics> {
    const referencedIds = new Set(refs.filter(isAilyDataRef).map((ref) => ref.$ailyData.id));
    const resources = await this.listResources(referencedIds);
    return {
      resourceCount: resources.length,
      referencedCount: resources.filter((entry) => entry.referenced).length,
      unreferencedCount: resources.filter((entry) => !entry.referenced).length,
      storedBytes: resources.reduce((total, entry) => total + entry.size, 0),
      unreferencedBytes: resources.filter((entry) => !entry.referenced)
        .reduce((total, entry) => total + entry.size, 0),
      resources,
    };
  }

  async garbageCollect(
    refs: readonly AilyDataRef[],
    options: { readonly gracePeriodMs?: number; readonly dryRun?: boolean; readonly nowMs?: number } = {},
  ): Promise<ProjectDataGcResult> {
    const gracePeriodMs = options.gracePeriodMs ?? 7 * 24 * 60 * 60 * 1000;
    const dryRun = options.dryRun ?? true;
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
      throw new ProjectDataError('invalid-ref', 'GC grace period must be a non-negative finite number.');
    }
    const referencedIds = new Set(refs.filter(isAilyDataRef).map((ref) => ref.$ailyData.id));
    const resources = await this.listResources(referencedIds);
    const candidates = resources.filter((entry) => (
      !entry.referenced && entry.mtimeMs > 0 && nowMs - entry.mtimeMs >= gracePeriodMs
    ));
    let deletedCount = 0;
    let deletedBytes = 0;
    if (!dryRun) {
      for (const entry of candidates) {
        this.assertInsideResourceRoot(entry.path);
        await this.fileSystem.unlink(entry.path);
        this.removeFromCache(entry.id);
        deletedCount++;
        deletedBytes += entry.size;
      }
    }
    return {
      dryRun,
      gracePeriodMs,
      scannedCount: resources.length,
      deletedCount,
      deletedBytes,
      retainedCount: resources.length - (dryRun ? 0 : deletedCount),
      candidates,
    };
  }

  resolveRefPath(ref: AilyDataRef): string {
    this.assertConfigured();
    const hash = getAilyDataHash(ref);
    const candidate = this.fileSystem.resolve(
      this.fileSystem.join(this.resourceRoot, hash.slice(0, 2), `${hash}.bin`),
    );
    this.assertInsideResourceRoot(candidate);
    return candidate;
  }

  private async listResources(referencedIds: ReadonlySet<string>): Promise<ProjectDataResourceEntry[]> {
    this.assertConfigured();
    if (!await this.fileSystem.exists(this.resourceRoot)) return [];
    await this.assertNoSymbolicLinks(this.resourceRoot);
    const output: ProjectDataResourceEntry[] = [];
    const directories = await this.fileSystem.readdir(this.resourceRoot);
    for (const directoryName of directories) {
      if (!RESOURCE_DIRECTORY_PATTERN.test(directoryName)) continue;
      const directoryPath = this.fileSystem.resolve(this.fileSystem.join(this.resourceRoot, directoryName));
      this.assertInsideResourceRoot(directoryPath);
      const directoryStat = await this.fileSystem.stat(directoryPath).catch(() => null);
      if (!directoryStat?.isDirectory || directoryStat.isSymbolicLink) continue;
      for (const fileName of await this.fileSystem.readdir(directoryPath)) {
        const match = RESOURCE_FILE_PATTERN.exec(fileName);
        if (!match || match[1].slice(0, 2) !== directoryName) continue;
        const path = this.fileSystem.resolve(this.fileSystem.join(directoryPath, fileName));
        this.assertInsideResourceRoot(path);
        const stat = await this.fileSystem.stat(path).catch(() => null);
        if (!stat?.isFile || stat.isSymbolicLink) continue;
        const id = `sha256:${match[1]}` as const;
        output.push({
          id,
          path,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          referenced: referencedIds.has(id),
        });
      }
    }
    return output.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async persistCanonicalBytes(input: {
    id: `sha256:${string}`;
    codec: string;
    logicalType: AilyDataRef['$ailyData']['logicalType'];
    storage: AilyDataStorageEncoding;
    canonicalBytes: Uint8Array;
    sessionId: string;
  }): Promise<AilyDataRef> {
    const storedBytes = await encodeStorage(input.storage, input.canonicalBytes);
    this.assertSession(input.sessionId);
    const ref: AilyDataRef = {
      $ailyData: {
        schemaVersion: 1,
        id: input.id,
        logicalType: input.logicalType,
        codec: input.codec,
        storage: input.storage,
        rawLength: input.canonicalBytes.length,
        storedLength: storedBytes.length,
      },
    };
    const header: ProjectDataContainerHeader = { ...ref.$ailyData };
    const container = createProjectDataContainer(header, storedBytes);
    const finalPath = this.resolveRefPath(ref);
    const directory = this.fileSystem.dirname(finalPath);
    await this.fileSystem.mkdir(directory);
    await this.assertNoSymbolicLinks(directory);
    this.assertSession(input.sessionId);

    if (await this.fileSystem.exists(finalPath)) {
      await this.readAndValidate(ref, input.sessionId);
      this.addToCache(ref, input.canonicalBytes);
      return ref;
    }

    const tempPath = `${finalPath}.${input.sessionId}.${createSessionId()}.tmp`;
    this.assertInsideResourceRoot(tempPath);
    try {
      await this.fileSystem.writeBinary(tempPath, container);
      this.assertSession(input.sessionId);
      try {
        await this.fileSystem.rename(tempPath, finalPath);
      } catch (error) {
        if (!await this.fileSystem.exists(finalPath)) throw error;
      }
      await this.readAndValidate(ref, input.sessionId);
      this.addToCache(ref, input.canonicalBytes);
      return ref;
    } catch (error) {
      throw normalizeProjectDataError(error, 'io-error', 'Failed to persist project data resource.');
    } finally {
      if (await this.fileSystem.exists(tempPath).catch(() => false)) {
        await this.fileSystem.unlink(tempPath).catch(() => undefined);
      }
    }
  }

  private async readAndValidate(ref: AilyDataRef, sessionId: string): Promise<Uint8Array> {
    this.assertRefWithinCodecLimits(ref);
    const path = this.resolveRefPath(ref);
    await this.assertNoSymbolicLinks(this.fileSystem.dirname(path));
    if (!await this.fileSystem.exists(path)) {
      throw new ProjectDataError('missing', `Project data resource is missing: ${ref.$ailyData.id}`, { path });
    }
    const stat = await this.fileSystem.stat(path);
    if (!stat.isFile || stat.isSymbolicLink) {
      throw new ProjectDataError('corrupt', `Project data resource is not a regular file: ${ref.$ailyData.id}`);
    }
    if (stat.size > ref.$ailyData.storedLength + MAX_PROJECT_DATA_CONTAINER_OVERHEAD) {
      throw new ProjectDataError('too-large', `Project data container exceeds its declared size: ${ref.$ailyData.id}`);
    }
    const container = parseProjectDataContainer(await this.fileSystem.readBinary(path));
    this.assertSession(sessionId);
    assertHeaderMatchesRef(container.header, ref);
    const canonicalBytes = await decodeStorage(
      ref.$ailyData.storage,
      container.storedPayload,
      ref.$ailyData.rawLength,
    );
    this.assertSession(sessionId);
    if (canonicalBytes.length !== ref.$ailyData.rawLength) {
      throw new ProjectDataError('corrupt', `Project data raw length mismatch: ${ref.$ailyData.id}`);
    }
    const hash = await calculateProjectDataHash(ref.$ailyData.codec, ref.$ailyData.storage, canonicalBytes);
    this.assertSession(sessionId);
    if (`sha256:${hash}` !== ref.$ailyData.id) {
      throw new ProjectDataError('corrupt', `Project data hash mismatch: ${ref.$ailyData.id}`);
    }
    this.addToCache(ref, canonicalBytes);
    return canonicalBytes;
  }

  private assertRefWithinCodecLimits(ref: AilyDataRef): void {
    const codec = this.codecs.get(ref.$ailyData.codec);
    if (codec.logicalType !== ref.$ailyData.logicalType) {
      throw new ProjectDataError('corrupt', 'Project data logical type does not match its codec.', {
        id: ref.$ailyData.id,
      });
    }
    if (ref.$ailyData.rawLength > codec.maxRawLength) {
      throw new ProjectDataError('too-large', `Project data exceeds codec limit: ${codec.id}`, {
        id: ref.$ailyData.id,
        rawLength: ref.$ailyData.rawLength,
        maxRawLength: codec.maxRawLength,
      });
    }
    const maxStoredLength = ref.$ailyData.storage === 'raw-v1'
      ? ref.$ailyData.rawLength
      : codec.maxRawLength + MAX_COMPRESSED_STORAGE_OVERHEAD;
    if (ref.$ailyData.storedLength > maxStoredLength) {
      throw new ProjectDataError('too-large', `Project data stored payload exceeds codec limit: ${codec.id}`, {
        id: ref.$ailyData.id,
        storedLength: ref.$ailyData.storedLength,
        maxStoredLength,
      });
    }
    if (ref.$ailyData.storage === 'raw-v1'
      && ref.$ailyData.storedLength !== ref.$ailyData.rawLength) {
      throw new ProjectDataError('corrupt', `Raw project data length metadata is inconsistent: ${ref.$ailyData.id}`);
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ProjectDataError('not-configured', 'ProjectDataStore has not been configured.');
    }
  }

  private assertSession(sessionId: string): void {
    if (!sessionId || sessionId !== this.sessionId) {
      throw new ProjectDataError('cancelled', 'Project data operation belongs to an inactive project session.');
    }
  }

  private assertInsideResourceRoot(path: string): void {
    const resolved = this.fileSystem.resolve(path);
    const relative = this.fileSystem.relative(this.resourceRoot, resolved);
    if (!relative || relative === '.') return;
    if (relative.startsWith('..') || this.fileSystem.isAbsolute(relative)) {
      throw new ProjectDataError('invalid-ref', 'Resolved project data path escapes the resource root.', {
        path: resolved,
      });
    }
  }

  private async assertNoSymbolicLinks(path: string): Promise<void> {
    this.assertInsideResourceRoot(path);
    const relative = this.fileSystem.relative(this.projectRoot, this.fileSystem.resolve(path));
    let current = this.projectRoot;
    for (const segment of relative.split(/[\\/]+/).filter(Boolean)) {
      current = this.fileSystem.resolve(this.fileSystem.join(current, segment));
      if (!await this.fileSystem.exists(current)) continue;
      const stat = await this.fileSystem.stat(current);
      if (stat.isSymbolicLink) {
        throw new ProjectDataError('invalid-ref', 'Project data path contains a symbolic link.', {
          path: current,
        });
      }
    }
  }

  private takeFromCache(ref: AilyDataRef): Uint8Array | null {
    const id = ref.$ailyData.id;
    const entry = this.canonicalCache.get(id);
    if (!entry) return null;
    if (!areAilyDataRefsEquivalent(entry.ref, ref)) {
      throw new ProjectDataError('corrupt', `Cached project data metadata conflicts with its reference: ${id}`);
    }
    this.canonicalCache.delete(id);
    this.canonicalCache.set(id, entry);
    return entry.bytes;
  }

  private addToCache(ref: AilyDataRef, bytes: Uint8Array): void {
    if (bytes.length > this.maxCacheBytes) return;
    const id = ref.$ailyData.id;
    const previous = this.canonicalCache.get(id);
    if (previous && !areAilyDataRefsEquivalent(previous.ref, ref)) {
      throw new ProjectDataError('corrupt', `Conflicting project data metadata for cache ID: ${id}`);
    }
    if (previous) {
      this.cacheBytes -= previous.size;
      this.canonicalCache.delete(id);
    }
    const copy = bytes.slice();
    this.canonicalCache.set(id, { bytes: copy, size: copy.length, ref });
    this.cacheBytes += copy.length;
    while (this.cacheBytes > this.maxCacheBytes) {
      const oldest = this.canonicalCache.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      this.canonicalCache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].size;
    }
  }

  private removeFromCache(id: string): void {
    const entry = this.canonicalCache.get(id);
    if (!entry) return;
    this.canonicalCache.delete(id);
    this.cacheBytes -= entry.size;
  }

  private clearCache(): void {
    this.canonicalCache.clear();
    this.cacheBytes = 0;
  }
}

export async function calculateProjectDataHash(
  codec: string,
  storage: AilyDataStorageEncoding,
  canonicalBytes: Uint8Array,
): Promise<string> {
  const encoder = new TextEncoder();
  const codecBytes = encoder.encode(codec);
  const storageBytes = encoder.encode(storage);
  const input = new Uint8Array(codecBytes.length + storageBytes.length + canonicalBytes.length + 2);
  let offset = 0;
  input.set(codecBytes, offset);
  offset += codecBytes.length + 1;
  input.set(storageBytes, offset);
  offset += storageBytes.length + 1;
  input.set(canonicalBytes, offset);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encodeStorage(
  storage: AilyDataStorageEncoding,
  canonicalBytes: Uint8Array,
): Promise<Uint8Array> {
  if (storage === 'raw-v1') return canonicalBytes.slice();
  if (storage === 'deflate-raw-v1') return transformCompression(canonicalBytes, true);
  throw new ProjectDataError('unsupported-storage', `Unsupported project data storage: ${storage}`);
}

async function decodeStorage(
  storage: AilyDataStorageEncoding,
  storedBytes: Uint8Array,
  expectedRawLength: number,
): Promise<Uint8Array> {
  if (storage === 'raw-v1') {
    if (storedBytes.length > expectedRawLength) {
      throw new ProjectDataError('too-large', 'Raw project data exceeds its declared length.');
    }
    return storedBytes.slice();
  }
  if (storage === 'deflate-raw-v1') {
    return transformCompression(storedBytes, false, expectedRawLength);
  }
  throw new ProjectDataError('unsupported-storage', `Unsupported project data storage: ${storage}`);
}

async function transformCompression(
  bytes: Uint8Array,
  compress: boolean,
  maxOutputLength?: number,
): Promise<Uint8Array> {
  const StreamClass = compress ? globalThis.CompressionStream : globalThis.DecompressionStream;
  if (typeof StreamClass !== 'function') {
    throw new ProjectDataError('unsupported-storage', 'Compression streams are unavailable in this runtime.');
  }
  try {
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const transform = new StreamClass('deflate-raw' as any);
    const stream = new Blob([input]).stream().pipeThrough(transform as any) as ReadableStream<Uint8Array>;
    if (maxOutputLength === undefined) {
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let outputLength = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value instanceof Uint8Array
        ? result.value
        : new Uint8Array(result.value as ArrayBuffer);
      outputLength += chunk.length;
      if (outputLength > maxOutputLength) {
        await reader.cancel().catch(() => undefined);
        throw new ProjectDataError('too-large', 'Decompressed project data exceeds its declared length.', {
          maxOutputLength,
        });
      }
      chunks.push(chunk);
    }
    const output = new Uint8Array(outputLength);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  } catch (error) {
    throw normalizeProjectDataError(error, 'corrupt', 'Project data compression transform failed.');
  }
}

function assertHeaderMatchesRef(header: ProjectDataContainerHeader, ref: AilyDataRef): void {
  const expected = ref.$ailyData;
  if (header.schemaVersion !== expected.schemaVersion
    || header.id !== expected.id
    || header.logicalType !== expected.logicalType
    || header.codec !== expected.codec
    || header.storage !== expected.storage
    || header.rawLength !== expected.rawLength
    || header.storedLength !== expected.storedLength) {
    throw new ProjectDataError('corrupt', `Project data container does not match its reference: ${expected.id}`);
  }
}

function normalizeProjectDataError(
  error: unknown,
  fallbackCode: 'io-error' | 'corrupt',
  message: string,
): ProjectDataError {
  if (error instanceof ProjectDataError) return error;
  return new ProjectDataError(fallbackCode, message, { cause: String(error) });
}

function createSessionId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
