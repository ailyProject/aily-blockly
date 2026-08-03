import type {
  DebugSourceLocation,
  SimulatorEditorHostProviderAdapterOptions,
  SimulatorSubappDebugLocationHintEvent,
  SimulatorSubappHostEditorSourceLocationRevealV1,
} from '@aily-project/simulator-host-sdk';

import type {
  SimulatorActiveProjectBindingPort,
} from './simulator-build-execution-port';

const SOURCE_MAP_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_LAUNCH_SCOPES = 32;

export interface SimulatorBlocklyEditorSourceState {
  readonly sourceMapRevision: string;
  readonly sourcePath: string;
  readonly workspaceCurrent: boolean;
}

export interface SimulatorBlocklyEditorSourcePort {
  readState(projectRoot: string): SimulatorBlocklyEditorSourceState;
  resolveBlockIdByGeneratedLine(line: number): string | null;
}

export interface SimulatorBlocklyEditorViewPort {
  hasBlock(blockId: string): boolean;
  showDebugBlock(projectRoot: string, blockId: string, focus: boolean): void;
  clearDebugBlock(projectRoot: string): void;
}

export interface SimulatorBlocklyEditorCallbackAuthorityOptions {
  projectRoot: string;
  projectIdentity: string;
  sceneId?: string;
  activeProject: SimulatorActiveProjectBindingPort;
  source: SimulatorBlocklyEditorSourcePort;
  view: SimulatorBlocklyEditorViewPort;
  maxLaunchScopes?: number;
}

interface LaunchScopeState {
  identity: string;
  lastSequence: number;
}

interface MarkerOwner {
  launchId: string;
  identity: string;
}

/**
 * Project-scoped Blockly implementation of the Host SDK Editor callbacks.
 * It consumes portable locations only and never controls Simulator/GDB.
 */
export class SimulatorBlocklyEditorCallbackAuthority {
  readonly callbacks: SimulatorEditorHostProviderAdapterOptions;

  private readonly projectRoot: string;
  private readonly projectIdentity: string;
  private readonly sceneId: string;
  private readonly activeProject: SimulatorActiveProjectBindingPort;
  private readonly source: SimulatorBlocklyEditorSourcePort;
  private readonly view: SimulatorBlocklyEditorViewPort;
  private readonly maxLaunchScopes: number;
  private readonly launchScopes = new Map<string, LaunchScopeState>();
  private markerOwner: MarkerOwner | null = null;
  private closed = false;

  constructor(options: SimulatorBlocklyEditorCallbackAuthorityOptions) {
    this.projectRoot = requireNonEmpty(options.projectRoot, 'projectRoot');
    this.projectIdentity = requirePortableIdentifier(
      options.projectIdentity,
      'projectIdentity',
    );
    this.sceneId = requirePortableIdentifier(options.sceneId ?? 'main', 'sceneId');
    if (
      !options.activeProject
      || typeof options.activeProject.readActiveBinding !== 'function'
      || typeof options.activeProject.isSameProjectRoot !== 'function'
    ) {
      throw new TypeError('Editor active Project binding port is invalid.');
    }
    if (
      !options.source
      || typeof options.source.readState !== 'function'
      || typeof options.source.resolveBlockIdByGeneratedLine !== 'function'
    ) {
      throw new TypeError('Editor source port is invalid.');
    }
    if (
      !options.view
      || typeof options.view.hasBlock !== 'function'
      || typeof options.view.showDebugBlock !== 'function'
      || typeof options.view.clearDebugBlock !== 'function'
    ) {
      throw new TypeError('Editor view port is invalid.');
    }
    const maxLaunchScopes = options.maxLaunchScopes ?? MAX_LAUNCH_SCOPES;
    if (
      !Number.isSafeInteger(maxLaunchScopes)
      || maxLaunchScopes < 1
      || maxLaunchScopes > 256
    ) {
      throw new RangeError('Editor launch scope limit must be in 1..256.');
    }
    this.activeProject = options.activeProject;
    this.source = options.source;
    this.view = options.view;
    this.maxLaunchScopes = maxLaunchScopes;
    this.callbacks = Object.freeze({
      publishDebugLocation: (event) => this.publishDebugLocation(event),
      revealSourceLocation: (request) => this.revealSourceLocation(request),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.launchScopes.clear();
    this.clearMarker();
  }

  clearDebugMarker(): void {
    if (!this.closed) this.clearMarker();
  }

  private publishDebugLocation(
    event: SimulatorSubappDebugLocationHintEvent,
  ): 'applied' | 'ignored' {
    if (this.closed || !this.isActiveBlocklyProject()) {
      this.clearMarker();
      return 'ignored';
    }
    if (event.sceneId !== this.sceneId) return 'ignored';
    const identity = locationScopeIdentity(event);
    let scope = this.launchScopes.get(event.launchId);
    if (!scope) {
      if (this.launchScopes.size >= this.maxLaunchScopes) return 'ignored';
      scope = { identity, lastSequence: 0 };
      this.launchScopes.set(event.launchId, scope);
    } else if (scope.identity !== identity) {
      this.clearMarkerOwnedBy(event.launchId);
      scope.identity = identity;
      scope.lastSequence = 0;
    }
    if (event.sequence <= scope.lastSequence) return 'ignored';
    scope.lastSequence = event.sequence;

    if (event.status === 'clear') {
      this.clearMarkerOwnedBy(event.launchId);
      return 'applied';
    }
    const sourceState = this.readCurrentSourceState();
    if (
      !sourceState
      || !sourceState.workspaceCurrent
      || !event.sourceMapRevision
      || event.sourceMapRevision !== sourceState.sourceMapRevision
    ) {
      this.clearMarkerOwnedBy(event.launchId);
      return 'ignored';
    }
    const blockId = this.selectMappedBlock(event);
    if (!blockId) {
      this.clearMarkerOwnedBy(event.launchId);
      return 'ignored';
    }
    this.view.showDebugBlock(this.projectRoot, blockId, true);
    this.markerOwner = { launchId: event.launchId, identity };
    return 'applied';
  }

  private revealSourceLocation(
    request: SimulatorSubappHostEditorSourceLocationRevealV1,
  ): 'revealed' | 'ignored' {
    if (
      this.closed
      || !this.isActiveBlocklyProject()
      || request.sceneId !== this.sceneId
    ) {
      return 'ignored';
    }
    const sourceState = this.readCurrentSourceState();
    if (
      !sourceState
      || !sourceState.workspaceCurrent
      || !request.sourceMapRevision
      || request.sourceMapRevision !== sourceState.sourceMapRevision
      || !samePortablePath(request.location.file, sourceState.sourcePath)
    ) {
      return 'ignored';
    }
    const blockId = this.source.resolveBlockIdByGeneratedLine(
      request.location.line,
    );
    if (!blockId || !this.view.hasBlock(blockId)) return 'ignored';
    const identity = locationScopeIdentity(request);
    this.view.showDebugBlock(
      this.projectRoot,
      blockId,
      request.focus,
    );
    this.markerOwner = { launchId: request.launchId, identity };
    return 'revealed';
  }

  private selectMappedBlock(
    event: SimulatorSubappDebugLocationHintEvent,
  ): string | null {
    const candidates = [
      event.primaryBlockId,
      ...event.mappings
        .filter((mapping) => mapping.ranges.some((range) => range.current))
        .map((mapping) => mapping.blockId),
      ...event.mappings.map((mapping) => mapping.blockId),
    ];
    const visited = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate || visited.has(candidate)) continue;
      visited.add(candidate);
      if (this.view.hasBlock(candidate)) return candidate;
    }
    return null;
  }

  private readCurrentSourceState(): SimulatorBlocklyEditorSourceState | null {
    try {
      const state = this.source.readState(this.projectRoot);
      const sourceMapRevision = String(state.sourceMapRevision || '').toLowerCase();
      if (!SOURCE_MAP_REVISION_PATTERN.test(sourceMapRevision)) return null;
      return {
        sourceMapRevision,
        sourcePath: normalizePortablePath(state.sourcePath),
        workspaceCurrent: state.workspaceCurrent === true,
      };
    } catch {
      return null;
    }
  }

  private isActiveBlocklyProject(): boolean {
    const binding = this.activeProject.readActiveBinding();
    return !!binding
      && binding.editorKind === 'blockly'
      && binding.projectIdentity === this.projectIdentity
      && binding.sceneId === this.sceneId
      && this.activeProject.isSameProjectRoot(
        binding.projectRoot,
        this.projectRoot,
      );
  }

  private clearMarkerOwnedBy(launchId: string): void {
    if (this.markerOwner?.launchId !== launchId) return;
    this.clearMarker();
  }

  private clearMarker(): void {
    if (!this.markerOwner) return;
    this.markerOwner = null;
    this.view.clearDebugBlock(this.projectRoot);
  }
}

function locationScopeIdentity(value: {
  launchId: string;
  sessionId: string;
  sceneId: string;
  sceneRevision: string;
}): string {
  return [
    value.launchId,
    value.sessionId,
    value.sceneId,
    value.sceneRevision,
  ].join('\0');
}

function samePortablePath(left: DebugSourceLocation['file'], right: string): boolean {
  const normalizedLeft = normalizePortablePath(left);
  const normalizedRight = normalizePortablePath(right);
  return !!normalizedLeft
    && !!normalizedRight
    && normalizedLeft === normalizedRight;
}

function normalizePortablePath(value: string): string {
  const normalized = String(value || '').trim().replaceAll('\\', '/');
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split('/').some((segment) => segment === '..')
  ) {
    return '';
  }
  return normalized.replace(/^\.\//u, '');
}

function requirePortableIdentifier(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) {
    throw new TypeError(`${label} must be a portable identifier.`);
  }
  return normalized;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}
