import { createDefaultProjectDataCodecRegistry, ProjectDataCodecRegistry } from './project-data-codec.registry';
import { MAX_PROJECT_DATA_CONTAINER_OVERHEAD } from './project-data-container';
import { createElectronProjectDataFileSystem } from './project-data-file-system';
import { ProjectDataStore, PutProjectDataRequest } from './project-data-store';
import {
  AilyDataRef,
  areAilyDataRefsEquivalent,
  isAilyDataRef,
  ProjectDataClipboardBundle,
  ProjectDataError,
  ProjectDataGcResult,
  ProjectDataStatistics,
} from './project-data.types';

const MAX_CLIPBOARD_BUNDLE_RESOURCES = 1024;
const MAX_CLIPBOARD_BUNDLE_BASE64_LENGTH = 256 * 1024 * 1024;

interface PreparedValueEntry {
  readonly ref: AilyDataRef;
  readonly value: unknown;
  readonly size: number;
}

class ProjectDataRuntime {
  private store: ProjectDataStore | null = null;
  private sessionId = '';
  private readonly preparedValues = new Map<string, PreparedValueEntry>();
  private readonly pendingMutations = new Set<Promise<unknown>>();
  private clipboardRefs: AilyDataRef[] = [];
  private preparedBytes = 0;
  private readonly maxPreparedBytes = 128 * 1024 * 1024;
  private readonly codecs: ProjectDataCodecRegistry = createDefaultProjectDataCodecRegistry();

  configure(projectPath: string): void {
    this.sessionId = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.store = new ProjectDataStore(createElectronProjectDataFileSystem(), this.codecs);
    this.store.configure(projectPath, this.sessionId);
    this.clipboardRefs = [];
    this.clearPrepared();
  }

  reset(): void {
    this.store?.reset();
    this.store = null;
    this.sessionId = '';
    this.pendingMutations.clear();
    this.clipboardRefs = [];
    this.clearPrepared();
  }

  isConfigured(): boolean {
    return Boolean(this.store?.isConfigured());
  }

  getCodecRegistry(): ProjectDataCodecRegistry {
    return this.codecs;
  }

  getStore(): ProjectDataStore {
    if (!this.store) {
      throw new ProjectDataError('not-configured', 'ProjectDataRuntime is not configured for a project.');
    }
    return this.store;
  }

  async put<TValue>(request: PutProjectDataRequest<TValue>): Promise<AilyDataRef> {
    const ref = await this.getStore().put(request);
    this.setPrepared(ref, await this.getStore().resolve<TValue>(ref));
    return ref;
  }

  /**
   * Register an asynchronous field mutation that must finish before the
   * workspace is serialized or code generation starts.
   */
  trackMutation<TValue>(operation: Promise<TValue>): Promise<TValue> {
    this.pendingMutations.add(operation);
    operation.finally(() => this.pendingMutations.delete(operation)).catch(() => undefined);
    return operation;
  }

  async flushPending(): Promise<void> {
    while (this.pendingMutations.size > 0) {
      await Promise.all([...this.pendingMutations]);
    }
    await this.getStore().flushPending();
  }

  async resolve<TValue>(ref: AilyDataRef): Promise<TValue> {
    const cached = this.takePrepared<TValue>(ref);
    if (cached !== undefined) return cached;
    const value = await this.getStore().resolve<TValue>(ref);
    this.setPrepared(ref, value);
    return value;
  }

  async prepare(refs: readonly AilyDataRef[]): Promise<void> {
    const unique = new Map<string, AilyDataRef>();
    for (const ref of refs) {
      const existing = unique.get(ref.$ailyData.id);
      if (existing && !areAilyDataRefsEquivalent(existing, ref)) {
        throw new ProjectDataError('corrupt', `Conflicting metadata for project data ID: ${ref.$ailyData.id}`);
      }
      unique.set(ref.$ailyData.id, ref);
    }
    const requiredBytes = [...unique.values()].reduce((total, ref) => total + ref.$ailyData.rawLength, 0);
    if (requiredBytes > this.maxPreparedBytes) {
      throw new ProjectDataError('too-large', 'Code generation project data exceeds the prepared cache limit.', {
        requiredBytes,
        maxPreparedBytes: this.maxPreparedBytes,
      });
    }
    for (const ref of unique.values()) {
      this.takePrepared(ref);
    }
    await Promise.all([...unique.values()].map(async (ref) => {
      if (!this.preparedValues.has(ref.$ailyData.id)) {
        await this.resolve(ref);
      }
    }));
  }

  async prepareValue(value: unknown): Promise<void> {
    await this.prepare(this.getStore().collectReferences(value));
  }

  async exportClipboardBundle(value: unknown): Promise<ProjectDataClipboardBundle> {
    await this.flushPending();
    const refs = this.getStore().collectReferences(value);
    this.clipboardRefs = refs;
    const resources = await Promise.all(refs.map(async (ref) => ({
      ref,
      containerBase64: bytesToBase64(await this.getStore().exportContainer(ref)),
    })));
    return { schemaVersion: 1, resources };
  }

  async importClipboardBundle(bundle: unknown, requiredValue?: unknown): Promise<void> {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw new ProjectDataError('invalid-ref', 'Clipboard project data bundle is invalid.');
    }
    const candidate = bundle as Partial<ProjectDataClipboardBundle>;
    if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.resources)) {
      throw new ProjectDataError('invalid-ref', 'Clipboard project data bundle schema is unsupported.');
    }
    if (candidate.resources.length > MAX_CLIPBOARD_BUNDLE_RESOURCES) {
      throw new ProjectDataError('too-large', 'Clipboard project data bundle contains too many resources.');
    }
    const requiredRefs = requiredValue === undefined
      ? []
      : this.getStore().collectReferences(requiredValue);
    const requiredIds = new Set(requiredRefs.map((ref) => ref.$ailyData.id));
    const requiredRefsById = new Map(requiredRefs.map((ref) => [ref.$ailyData.id, ref]));
    const suppliedIds = new Set<string>();
    let totalBase64Length = 0;
    for (const resource of candidate.resources) {
      if (!resource || !isAilyDataRef(resource.ref) || typeof resource.containerBase64 !== 'string') {
        throw new ProjectDataError('invalid-ref', 'Clipboard project data resource is invalid.');
      }
      if (requiredValue !== undefined && !requiredIds.has(resource.ref.$ailyData.id)) continue;
      const requiredRef = requiredRefsById.get(resource.ref.$ailyData.id);
      if (requiredRef && !areAilyDataRefsEquivalent(requiredRef, resource.ref)) {
        throw new ProjectDataError('corrupt', 'Clipboard resource metadata does not match the pasted field reference.', {
          id: resource.ref.$ailyData.id,
        });
      }
      if (suppliedIds.has(resource.ref.$ailyData.id)) continue;
      const maximumContainerLength = resource.ref.$ailyData.storedLength
        + MAX_PROJECT_DATA_CONTAINER_OVERHEAD;
      const maximumBase64Length = Math.ceil(maximumContainerLength / 3) * 4;
      if (resource.containerBase64.length > maximumBase64Length) {
        throw new ProjectDataError('too-large', 'Clipboard project data container exceeds its declared size.', {
          id: resource.ref.$ailyData.id,
        });
      }
      totalBase64Length += resource.containerBase64.length;
      if (totalBase64Length > MAX_CLIPBOARD_BUNDLE_BASE64_LENGTH) {
        throw new ProjectDataError('too-large', 'Clipboard project data bundle exceeds the import limit.');
      }
      suppliedIds.add(resource.ref.$ailyData.id);
      await this.getStore().importContainer(resource.ref, base64ToBytes(resource.containerBase64));
    }
    const missingBundleIds = [...requiredIds].filter((id) => !suppliedIds.has(id));
    if (missingBundleIds.length > 0) {
      const locallyAvailable = await this.getStore().validateReferences(
        requiredRefs.filter((ref) => missingBundleIds.includes(ref.$ailyData.id)),
      );
      if (!locallyAvailable.valid) {
        throw new ProjectDataError(
          'missing',
          `Clipboard bundle is missing ${locallyAvailable.issues.length} required project data resource(s).`,
          { ids: locallyAvailable.issues.map((issue) => issue.ref.$ailyData.id) },
        );
      }
    }
  }

  async getStatistics(rootValues: readonly unknown[]): Promise<ProjectDataStatistics> {
    const refs = this.collectRootReferences(rootValues);
    return this.getStore().getStatistics(refs);
  }

  async garbageCollect(
    rootValues: readonly unknown[],
    options?: { readonly gracePeriodMs?: number; readonly dryRun?: boolean; readonly nowMs?: number },
  ): Promise<ProjectDataGcResult> {
    await this.flushPending();
    return this.getStore().garbageCollect(this.collectRootReferences(rootValues), options);
  }

  getPrepared<TValue>(ref: AilyDataRef): TValue {
    const value = this.takePrepared<TValue>(ref);
    if (value === undefined) {
      throw new ProjectDataError('not-configured', `Project data has not been prepared: ${ref.$ailyData.id}`);
    }
    return value;
  }

  clearPrepared(ref?: AilyDataRef): void {
    if (ref) {
      const entry = this.preparedValues.get(ref.$ailyData.id);
      if (entry) this.preparedBytes -= entry.size;
      this.preparedValues.delete(ref.$ailyData.id);
    } else {
      this.preparedValues.clear();
      this.preparedBytes = 0;
    }
  }

  getPreparedFieldPayload<TValue>(block: any, fieldName: string): TValue {
    let fieldState = block?.getFieldValue?.(fieldName);
    if (typeof fieldState === 'string') {
      try {
        fieldState = JSON.parse(fieldState);
      } catch {
        throw new ProjectDataError('invalid-ref', `Field ${fieldName} does not contain valid JSON state.`);
      }
    }
    const refs = isAilyDataRef(fieldState)
      ? [fieldState]
      : this.getStore().collectReferences(fieldState);
    if (refs.length !== 1) {
      throw new ProjectDataError(
        'invalid-ref',
        `Field ${fieldName} must contain exactly one project data reference; received ${refs.length}.`,
      );
    }
    return this.getPrepared<TValue>(refs[0]);
  }

  private takePrepared<TValue>(ref: AilyDataRef): TValue | undefined {
    const entry = this.preparedValues.get(ref.$ailyData.id);
    if (!entry) return undefined;
    if (!areAilyDataRefsEquivalent(entry.ref, ref)) {
      throw new ProjectDataError('corrupt', `Prepared project data metadata conflicts with its reference: ${ref.$ailyData.id}`);
    }
    this.preparedValues.delete(ref.$ailyData.id);
    this.preparedValues.set(ref.$ailyData.id, entry);
    return entry.value as TValue;
  }

  private setPrepared(ref: AilyDataRef, value: unknown): void {
    const previous = this.preparedValues.get(ref.$ailyData.id);
    if (previous) {
      if (!areAilyDataRefsEquivalent(previous.ref, ref)) {
        throw new ProjectDataError('corrupt', `Conflicting prepared project data metadata: ${ref.$ailyData.id}`);
      }
      this.preparedBytes -= previous.size;
      this.preparedValues.delete(ref.$ailyData.id);
    }
    const size = ref.$ailyData.rawLength;
    this.preparedValues.set(ref.$ailyData.id, { ref, value, size });
    this.preparedBytes += size;
    while (this.preparedBytes > this.maxPreparedBytes) {
      const oldest = this.preparedValues.entries().next().value as [string, PreparedValueEntry] | undefined;
      if (!oldest) break;
      this.preparedValues.delete(oldest[0]);
      this.preparedBytes -= oldest[1].size;
    }
  }

  private collectRootReferences(values: readonly unknown[]): AilyDataRef[] {
    const refs = new Map<string, AilyDataRef>();
    for (const ref of this.clipboardRefs) {
      refs.set(ref.$ailyData.id, ref);
    }
    for (const value of values) {
      for (const ref of this.getStore().collectReferences(value)) {
        refs.set(ref.$ailyData.id, ref);
      }
    }
    return [...refs.values()];
  }
}

export const projectDataRuntime = new ProjectDataRuntime();

Object.defineProperty(globalThis, 'ailyProjectData', {
  configurable: true,
  value: Object.freeze({
    isDataRef: isAilyDataRef,
    getPrepared: <TValue>(ref: AilyDataRef) => projectDataRuntime.getPrepared<TValue>(ref),
    getPreparedFieldPayload: <TValue>(block: any, fieldName: string) => (
      projectDataRuntime.getPreparedFieldPayload<TValue>(block, fieldName)
    ),
  }),
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new ProjectDataError('corrupt', 'Clipboard project data resource is not valid Base64.', {
      cause: String(error),
    });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
