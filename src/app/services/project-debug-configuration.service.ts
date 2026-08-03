import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

export const PROJECT_DEBUG_CONFIGURATION_FILE = 'aily-debug.json';
export const PROJECT_DEBUG_CONFIGURATION_SCHEMA_VERSION = 1 as const;
export const PROJECT_ARTIFACT_MANIFEST_PATH =
  '.build/aily-artifact-manifest.json';

const MAX_CONFIGURATION_BYTES = 1024 * 1024;
const MAX_ARTIFACT_MANIFEST_BYTES = 4 * 1024 * 1024;
const SOURCE_MAP_REVISION_PATTERN = /^[a-f0-9]{64}$/;

export interface ProjectBlockBreakpointIntent {
  blockId: string;
  sourceMapRevision: string;
  enabled: boolean;
}

export interface ProjectDebugConfiguration {
  schemaVersion: typeof PROJECT_DEBUG_CONFIGURATION_SCHEMA_VERSION;
  kind: 'aily-project-debug-configuration';
  breakpoints: ProjectBlockBreakpointIntent[];
}

export interface ProjectDebugConfigurationState {
  projectPath: string;
  configuration: ProjectDebugConfiguration;
  sourceMapRevision: string;
  artifactSourcePath: string;
  artifactSourceSha256: string;
  workspaceSourceSha256: string;
  buildConsistency: ProjectBuildConsistency;
  buildConsistencyError: string;
  configurationError: string;
  sourceMapError: string;
}

export type ProjectBuildConsistency =
  | 'artifact-unavailable'
  | 'workspace-unknown'
  | 'checking'
  | 'current'
  | 'dirty';

export type ProjectBreakpointMarkerState =
  | 'enabled'
  | 'disabled'
  | 'stale-enabled'
  | 'stale-disabled'
  | 'workspace-dirty-enabled'
  | 'workspace-dirty-disabled'
  | 'workspace-unknown-enabled'
  | 'workspace-unknown-disabled'
  | 'revision-unknown-enabled'
  | 'revision-unknown-disabled';

export interface ProjectSelectedDebugTarget {
  projectPath: string;
  blockId: string;
}

@Injectable({
  providedIn: 'root',
})
export class ProjectDebugConfigurationService {
  private workspaceHashGeneration = 0;
  private readonly selectedDebugTargetByProject = new Map<string, string>();
  private debugTargetCaptureSuppressionDepth = 0;
  private readonly stateSubject =
    new BehaviorSubject<ProjectDebugConfigurationState>(
      createEmptyProjectDebugConfigurationState(),
    );
  private readonly selectedDebugTargetSubject =
    new Subject<ProjectSelectedDebugTarget>();

  readonly state$ = this.stateSubject.asObservable();
  readonly selectedDebugTarget$ =
    this.selectedDebugTargetSubject.asObservable();

  get snapshot(): ProjectDebugConfigurationState {
    return cloneProjectDebugConfigurationState(this.stateSubject.value);
  }

  rememberSelectedDebugTarget(projectPath: string, blockId: string): void {
    if (
      this.debugTargetCaptureSuppressionDepth > 0
      || !projectPath
      || !blockId
    ) {
      return;
    }
    if (
      blockId.length > 256
      || /[\u0000-\u001f\u007f]/.test(blockId)
    ) {
      throw new Error('Blockly 调试目标 blockId 无效。');
    }
    this.selectedDebugTargetByProject.set(projectPath, blockId);
    this.selectedDebugTargetSubject.next({ projectPath, blockId });
  }

  getSelectedDebugTarget(projectPath: string): string {
    return projectPath
      ? this.selectedDebugTargetByProject.get(projectPath) || ''
      : '';
  }

  withoutSelectedDebugTargetCapture<T>(operation: () => T): T {
    this.debugTargetCaptureSuppressionDepth += 1;
    try {
      return operation();
    } finally {
      this.debugTargetCaptureSuppressionDepth -= 1;
    }
  }

  refresh(projectPath: string): ProjectDebugConfigurationState {
    if (!projectPath) {
      const empty = createEmptyProjectDebugConfigurationState();
      this.stateSubject.next(empty);
      return cloneProjectDebugConfigurationState(empty);
    }

    let configuration = createEmptyProjectDebugConfiguration();
    let configurationError = '';
    try {
      configuration = this.readConfigurationFile(projectPath);
    } catch (error) {
      configurationError = normalizeError(error);
    }

    const artifact = this.readArtifactState(projectPath);
    const previous = this.stateSubject.value.projectPath === projectPath
      ? this.stateSubject.value
      : null;
    const workspaceSourceSha256 = previous?.workspaceSourceSha256 || '';
    const buildConsistency = (
      previous?.buildConsistency === 'dirty'
      && !workspaceSourceSha256
      && !!artifact.sourceSha256
      && !!artifact.revision
    )
      ? 'dirty'
      : deriveProjectBuildConsistency(
          artifact.revision,
          artifact.sourceSha256,
          workspaceSourceSha256,
        );
    const state: ProjectDebugConfigurationState = {
      projectPath,
      configuration,
      sourceMapRevision: artifact.revision,
      artifactSourcePath: artifact.sourcePath,
      artifactSourceSha256: artifact.sourceSha256,
      workspaceSourceSha256,
      buildConsistency,
      buildConsistencyError: artifact.consistencyError,
      configurationError,
      sourceMapError: artifact.error,
    };
    this.stateSubject.next(cloneProjectDebugConfigurationState(state));
    return cloneProjectDebugConfigurationState(state);
  }

  read(projectPath: string): ProjectDebugConfiguration {
    const state = this.refresh(projectPath);
    if (state.configurationError) {
      throw new Error(state.configurationError);
    }
    return cloneProjectDebugConfiguration(state.configuration);
  }

  requireCurrentSourceMapRevision(projectPath: string): string {
    const state = this.refresh(projectPath);
    if (state.sourceMapRevision) return state.sourceMapRevision;
    if (state.sourceMapError) throw new Error(state.sourceMapError);
    throw new Error(
      `未找到 ${PROJECT_ARTIFACT_MANIFEST_PATH} 中的 Blockly source-map，`
      + '请先使用最新 aily-builder 编译项目。',
    );
  }

  requireBindableSourceMapRevision(projectPath: string): string {
    const state = this.refresh(projectPath);
    if (
      state.sourceMapRevision
      && state.buildConsistency === 'current'
    ) {
      return state.sourceMapRevision;
    }
    if (state.sourceMapError) throw new Error(state.sourceMapError);
    if (state.buildConsistencyError) {
      throw new Error(state.buildConsistencyError);
    }
    if (state.buildConsistency === 'dirty') {
      throw new Error(
        '当前 Blockly 工作区尚未进入最近 Artifact，请重新编译后再绑定断点。',
      );
    }
    if (
      state.buildConsistency === 'checking'
      || state.buildConsistency === 'workspace-unknown'
    ) {
      throw new Error(
        '正在核对当前 Blockly 工作区与最近 Artifact，请稍后重试。',
      );
    }
    return this.requireCurrentSourceMapRevision(projectPath);
  }

  markWorkspaceDirty(projectPath: string): ProjectDebugConfigurationState {
    this.workspaceHashGeneration += 1;
    if (!projectPath) {
      const empty = createEmptyProjectDebugConfigurationState();
      this.stateSubject.next(empty);
      return cloneProjectDebugConfigurationState(empty);
    }
    const current = this.stateSubject.value.projectPath === projectPath
      ? this.stateSubject.value
      : this.refresh(projectPath);
    const state: ProjectDebugConfigurationState = {
      ...current,
      workspaceSourceSha256: '',
      buildConsistency: (
        current.sourceMapRevision
        && current.artifactSourceSha256
      )
        ? 'dirty'
        : 'artifact-unavailable',
    };
    this.stateSubject.next(cloneProjectDebugConfigurationState(state));
    return cloneProjectDebugConfigurationState(state);
  }

  async updateWorkspaceGeneratedCode(
    projectPath: string,
    code: string,
    options: { refreshArtifact?: boolean } = {},
  ): Promise<ProjectDebugConfigurationState> {
    const generation = ++this.workspaceHashGeneration;
    if (!projectPath) {
      const empty = createEmptyProjectDebugConfigurationState();
      this.stateSubject.next(empty);
      return cloneProjectDebugConfigurationState(empty);
    }

    let current = (
      this.stateSubject.value.projectPath === projectPath
      && !options.refreshArtifact
    )
      ? this.stateSubject.value
      : this.refresh(projectPath);
    current = {
      ...current,
      buildConsistency: (
        current.sourceMapRevision
        && current.artifactSourceSha256
      )
        ? 'checking'
        : 'artifact-unavailable',
      buildConsistencyError: current.buildConsistencyError,
    };
    this.stateSubject.next(cloneProjectDebugConfigurationState(current));

    try {
      const workspaceSourceSha256 = await sha256ProjectSource(code);
      if (
        generation !== this.workspaceHashGeneration
        || this.stateSubject.value.projectPath !== projectPath
      ) {
        return this.snapshot;
      }
      const latest = this.stateSubject.value;
      const state: ProjectDebugConfigurationState = {
        ...latest,
        workspaceSourceSha256,
        buildConsistency: deriveProjectBuildConsistency(
          latest.sourceMapRevision,
          latest.artifactSourceSha256,
          workspaceSourceSha256,
        ),
      };
      this.stateSubject.next(cloneProjectDebugConfigurationState(state));
      return cloneProjectDebugConfigurationState(state);
    } catch (error) {
      if (
        generation !== this.workspaceHashGeneration
        || this.stateSubject.value.projectPath !== projectPath
      ) {
        return this.snapshot;
      }
      const state: ProjectDebugConfigurationState = {
        ...this.stateSubject.value,
        workspaceSourceSha256: '',
        buildConsistency: 'workspace-unknown',
        buildConsistencyError:
          `无法计算当前 Blockly 源码 SHA-256：${normalizeError(error)}`,
      };
      this.stateSubject.next(cloneProjectDebugConfigurationState(state));
      return cloneProjectDebugConfigurationState(state);
    }
  }

  setCurrentSourceMapRevision(
    projectPath: string,
    sourceMapRevision: string,
  ): ProjectDebugConfigurationState {
    const normalizedRevision = sourceMapRevision.toLowerCase();
    if (!SOURCE_MAP_REVISION_PATTERN.test(normalizedRevision)) {
      throw new Error('Blockly source-map revision 必须是 64 位 SHA-256。');
    }
    const current = this.stateSubject.value.projectPath === projectPath
      ? this.stateSubject.value
      : this.refresh(projectPath);
    const state: ProjectDebugConfigurationState = {
      ...current,
      projectPath,
      sourceMapRevision: normalizedRevision,
      buildConsistency: deriveProjectBuildConsistency(
        normalizedRevision,
        current.artifactSourceSha256,
        current.workspaceSourceSha256,
      ),
      sourceMapError: '',
    };
    this.stateSubject.next(cloneProjectDebugConfigurationState(state));
    return cloneProjectDebugConfigurationState(state);
  }

  upsertBreakpoint(
    projectPath: string,
    breakpoint: ProjectBlockBreakpointIntent,
  ): ProjectDebugConfiguration {
    return this.upsertBreakpoints(projectPath, [breakpoint]);
  }

  upsertBreakpoints(
    projectPath: string,
    breakpoints: ProjectBlockBreakpointIntent[],
  ): ProjectDebugConfiguration {
    const configuration = this.readConfigurationForMutation(projectPath);
    const byBlockId = new Map(
      configuration.breakpoints.map((breakpoint) => [
        breakpoint.blockId,
        breakpoint,
      ]),
    );
    for (const breakpoint of breakpoints) {
      byBlockId.set(breakpoint.blockId, { ...breakpoint });
    }
    configuration.breakpoints = [...byBlockId.values()];
    return this.write(projectPath, configuration);
  }

  setBreakpointEnabled(
    projectPath: string,
    blockId: string,
    enabled: boolean,
  ): ProjectDebugConfiguration {
    const configuration = this.readConfigurationForMutation(projectPath);
    const breakpoint = configuration.breakpoints.find(
      (item) => item.blockId === blockId,
    );
    if (!breakpoint) {
      throw new Error(`项目断点 ${blockId} 不存在。`);
    }
    breakpoint.enabled = enabled;
    return this.write(projectPath, configuration);
  }

  removeBreakpoint(
    projectPath: string,
    blockId: string,
  ): ProjectDebugConfiguration {
    return this.removeBreakpoints(projectPath, [blockId]);
  }

  removeBreakpoints(
    projectPath: string,
    blockIds: Iterable<string>,
  ): ProjectDebugConfiguration {
    const configuration = this.readConfigurationForMutation(projectPath);
    const removedIds = new Set(blockIds);
    configuration.breakpoints = configuration.breakpoints.filter(
      (item) => !removedIds.has(item.blockId),
    );
    return this.write(projectPath, configuration);
  }

  private readConfigurationForMutation(
    projectPath: string,
  ): ProjectDebugConfiguration {
    if (!projectPath) {
      throw new Error('请先打开一个 Blockly 项目。');
    }
    if (!this.hasLocalProjectFileSystem()) {
      throw new Error('项目断点编辑仅支持 Aily Blockly 桌面版。');
    }
    return this.readConfigurationFile(projectPath);
  }

  private readConfigurationFile(
    projectPath: string,
  ): ProjectDebugConfiguration {
    const empty = createEmptyProjectDebugConfiguration();
    if (!projectPath || !this.hasLocalProjectFileSystem()) return empty;
    const filePath = this.configurationFilePath(projectPath);
    if (!window['fs'].existsSync(filePath)) return empty;
    const raw = window['fs'].readFileSync(filePath, 'utf8');
    if (typeof raw !== 'string' || raw.length > MAX_CONFIGURATION_BYTES) {
      throw new Error(
        `${PROJECT_DEBUG_CONFIGURATION_FILE} 超出大小限制。`,
      );
    }
    return normalizeProjectDebugConfiguration(JSON.parse(raw));
  }

  private write(
    projectPath: string,
    configuration: ProjectDebugConfiguration,
  ): ProjectDebugConfiguration {
    if (!projectPath) {
      throw new Error('请先打开一个 Blockly 项目。');
    }
    const normalized = normalizeProjectDebugConfiguration(configuration);
    normalized.breakpoints.sort(
      (left, right) => left.blockId.localeCompare(right.blockId),
    );
    window['fs'].writeFileSync(
      this.configurationFilePath(projectPath),
      `${JSON.stringify(normalized, null, 2)}\n`,
      'utf8',
    );

    const artifact = this.readArtifactState(projectPath);
    const previous = this.stateSubject.value.projectPath === projectPath
      ? this.stateSubject.value
      : null;
    const workspaceSourceSha256 = previous?.workspaceSourceSha256 || '';
    const buildConsistency = (
      previous?.buildConsistency === 'dirty'
      && !workspaceSourceSha256
      && !!artifact.sourceSha256
      && !!artifact.revision
    )
      ? 'dirty'
      : deriveProjectBuildConsistency(
          artifact.revision,
          artifact.sourceSha256,
          workspaceSourceSha256,
        );
    this.stateSubject.next({
      projectPath,
      configuration: cloneProjectDebugConfiguration(normalized),
      sourceMapRevision: artifact.revision,
      artifactSourcePath: artifact.sourcePath,
      artifactSourceSha256: artifact.sourceSha256,
      workspaceSourceSha256,
      buildConsistency,
      buildConsistencyError: artifact.consistencyError,
      configurationError: '',
      sourceMapError: artifact.error,
    });
    return cloneProjectDebugConfiguration(normalized);
  }

  private readArtifactState(
    projectPath: string,
  ): {
    revision: string;
    sourcePath: string;
    sourceSha256: string;
    error: string;
    consistencyError: string;
  } {
    if (!this.hasLocalProjectFileSystem()) {
      return {
        revision: '',
        sourcePath: '',
        sourceSha256: '',
        error: '',
        consistencyError: '',
      };
    }
    const manifestPath = window['path'].join(
      projectPath,
      ...PROJECT_ARTIFACT_MANIFEST_PATH.split('/'),
    );
    if (!window['fs'].existsSync(manifestPath)) {
      return {
        revision: '',
        sourcePath: '',
        sourceSha256: '',
        error: '',
        consistencyError: '',
      };
    }

    try {
      const raw = window['fs'].readFileSync(manifestPath, 'utf8');
      if (typeof raw !== 'string' || raw.length > MAX_ARTIFACT_MANIFEST_BYTES) {
        throw new Error('Artifact manifest 超出大小限制。');
      }
      const artifact = JSON.parse(raw) as unknown;
      if (!isRecord(artifact) || !Array.isArray(artifact['files'])) {
        throw new Error('Artifact manifest 缺少 files。');
      }
      const build = isRecord(artifact['build']) ? artifact['build'] : null;
      const source = isRecord(build?.['source']) ? build['source'] : null;
      const sourcePath = normalizePortableArtifactPath(source?.['path']);
      const rawSourceSha256 = source?.['sha256'];
      let sourceSha256 = '';
      let consistencyError = '';
      if (typeof rawSourceSha256 === 'string') {
        sourceSha256 = rawSourceSha256.toLowerCase();
        if (!SOURCE_MAP_REVISION_PATTERN.test(sourceSha256)) {
          sourceSha256 = '';
          consistencyError =
            'Artifact build.source.sha256 无效，无法确认当前工作区是否已编译。';
        }
      } else {
        consistencyError =
          'Artifact 缺少 build.source.sha256，无法确认当前工作区是否已编译。';
      }
      const debug = isRecord(artifact['debug']) ? artifact['debug'] : null;
      const sourceMapPath = typeof debug?.['sourceMapPath'] === 'string'
        ? normalizeArtifactPath(debug['sourceMapPath'])
        : '';
      const descriptor = artifact['files'].find((file) => {
        if (!isRecord(file) || file['role'] !== 'source-map') return false;
        return !sourceMapPath
          || (
            typeof file['path'] === 'string'
            && normalizeArtifactPath(file['path']) === sourceMapPath
          );
      });
      if (!isRecord(descriptor) || typeof descriptor['sha256'] !== 'string') {
        return {
          revision: '',
          sourcePath,
          sourceSha256,
          error: '',
          consistencyError,
        };
      }
      const revision = descriptor['sha256'].toLowerCase();
      if (!SOURCE_MAP_REVISION_PATTERN.test(revision)) {
        throw new Error('Artifact source-map sha256 无效。');
      }
      return {
        revision,
        sourcePath,
        sourceSha256,
        error: '',
        consistencyError,
      };
    } catch (error) {
      return {
        revision: '',
        sourcePath: '',
        sourceSha256: '',
        error: `${PROJECT_ARTIFACT_MANIFEST_PATH} 无效：${normalizeError(error)}`,
        consistencyError: '',
      };
    }
  }

  private configurationFilePath(projectPath: string): string {
    return window['path'].join(
      projectPath,
      PROJECT_DEBUG_CONFIGURATION_FILE,
    );
  }

  private hasLocalProjectFileSystem(): boolean {
    return typeof window['fs']?.existsSync === 'function'
      && typeof window['fs']?.readFileSync === 'function'
      && typeof window['fs']?.writeFileSync === 'function'
      && typeof window['path']?.join === 'function';
  }
}

export function createEmptyProjectDebugConfiguration():
  ProjectDebugConfiguration {
  return {
    schemaVersion: PROJECT_DEBUG_CONFIGURATION_SCHEMA_VERSION,
    kind: 'aily-project-debug-configuration',
    breakpoints: [],
  };
}

export function createEmptyProjectDebugConfigurationState():
  ProjectDebugConfigurationState {
  return {
    projectPath: '',
    configuration: createEmptyProjectDebugConfiguration(),
    sourceMapRevision: '',
    artifactSourcePath: '',
    artifactSourceSha256: '',
    workspaceSourceSha256: '',
    buildConsistency: 'artifact-unavailable',
    buildConsistencyError: '',
    configurationError: '',
    sourceMapError: '',
  };
}

export function getProjectBreakpointMarkerState(
  breakpoint: ProjectBlockBreakpointIntent,
  currentSourceMapRevision: string,
  buildConsistency: ProjectBuildConsistency = 'current',
): ProjectBreakpointMarkerState {
  if (!currentSourceMapRevision) {
    return breakpoint.enabled
      ? 'revision-unknown-enabled'
      : 'revision-unknown-disabled';
  }
  if (breakpoint.sourceMapRevision !== currentSourceMapRevision) {
    return breakpoint.enabled ? 'stale-enabled' : 'stale-disabled';
  }
  if (buildConsistency === 'dirty') {
    return breakpoint.enabled
      ? 'workspace-dirty-enabled'
      : 'workspace-dirty-disabled';
  }
  if (buildConsistency !== 'current') {
    return breakpoint.enabled
      ? 'workspace-unknown-enabled'
      : 'workspace-unknown-disabled';
  }
  return breakpoint.enabled ? 'enabled' : 'disabled';
}

export function deriveProjectBuildConsistency(
  sourceMapRevision: string,
  artifactSourceSha256: string,
  workspaceSourceSha256: string,
): ProjectBuildConsistency {
  if (!sourceMapRevision || !artifactSourceSha256) {
    return 'artifact-unavailable';
  }
  if (!workspaceSourceSha256) {
    return 'workspace-unknown';
  }
  return artifactSourceSha256 === workspaceSourceSha256
    ? 'current'
    : 'dirty';
}

export async function sha256ProjectSource(source: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('当前运行环境不支持 Web Crypto。');
  }
  const bytes = new TextEncoder().encode(source);
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeProjectDebugConfiguration(
  value: unknown,
): ProjectDebugConfiguration {
  if (!isRecord(value)) {
    throw new Error(
      `${PROJECT_DEBUG_CONFIGURATION_FILE} 必须是 JSON 对象。`,
    );
  }
  if (
    value['schemaVersion'] !== PROJECT_DEBUG_CONFIGURATION_SCHEMA_VERSION
    || value['kind'] !== 'aily-project-debug-configuration'
    || !Array.isArray(value['breakpoints'])
    || value['breakpoints'].length > 256
  ) {
    throw new Error(
      `${PROJECT_DEBUG_CONFIGURATION_FILE} 协议版本或结构无效。`,
    );
  }
  const blockIds = new Set<string>();
  const breakpoints = value['breakpoints'].map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`项目断点 ${index + 1} 不是对象。`);
    }
    const blockId = raw['blockId'];
    const sourceMapRevision = raw['sourceMapRevision'];
    const enabled = raw['enabled'];
    if (
      typeof blockId !== 'string'
      || blockId.length === 0
      || blockId.length > 256
      || /[\u0000-\u001f\u007f]/.test(blockId)
      || blockIds.has(blockId)
    ) {
      throw new Error(
        `项目断点 ${index + 1} 的 blockId 无效或重复。`,
      );
    }
    if (
      typeof sourceMapRevision !== 'string'
      || !SOURCE_MAP_REVISION_PATTERN.test(sourceMapRevision)
    ) {
      throw new Error(
        `项目断点 ${blockId} 的 source-map revision 无效。`,
      );
    }
    if (typeof enabled !== 'boolean') {
      throw new Error(`项目断点 ${blockId} 的 enabled 必须是布尔值。`);
    }
    blockIds.add(blockId);
    return { blockId, sourceMapRevision, enabled };
  });
  return {
    schemaVersion: PROJECT_DEBUG_CONFIGURATION_SCHEMA_VERSION,
    kind: 'aily-project-debug-configuration',
    breakpoints,
  };
}

function cloneProjectDebugConfiguration(
  configuration: ProjectDebugConfiguration,
): ProjectDebugConfiguration {
  return {
    ...configuration,
    breakpoints: configuration.breakpoints.map((breakpoint) => ({
      ...breakpoint,
    })),
  };
}

function cloneProjectDebugConfigurationState(
  state: ProjectDebugConfigurationState,
): ProjectDebugConfigurationState {
  return {
    ...state,
    configuration: cloneProjectDebugConfiguration(state.configuration),
  };
}

function normalizeArtifactPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function normalizePortableArtifactPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = normalizeArtifactPath(value.trim()).replace(/^\.\//u, '');
  if (
    !normalized
    || normalized.length > 512
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.split('/').some((segment) => segment === '..')
  ) {
    return '';
  }
  return normalized;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
