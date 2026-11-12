export class ProjectLifecycleError extends Error {
  constructor(readonly code: 'PROJECT_OPERATION_BUSY' | 'PROJECT_LIFECYCLE_OWNER_STALE' | 'PROJECT_RELOAD_REJECTED' | 'PROJECT_SAVE_FAILED', message: string) {
    super(message); this.name = 'ProjectLifecycleError';
  }
}

export interface ProjectLifecycleLease {
  readonly token: symbol;
  release(): void;
}

/** Host resource ownership, independent of Agent sessions and UI status.
 * Only a live, path-scoped owner can re-enter (e.g. board switch -> reload).
 * '*' is reserved for disposing the entire host project set. */
export class ProjectLifecycleGate {
  private readonly owners = new Map<symbol, ReadonlySet<string>>();

  hasActive(projectPath: string): boolean {
    const path = normalize(projectPath);
    return [...this.owners.values()].some(paths => paths.has('*') || paths.has(path));
  }

  acquire(projectPaths: readonly string[], owner?: symbol): ProjectLifecycleLease {
    const paths = new Set(projectPaths.filter(Boolean).map(normalize));
    if (owner) {
      const owned = this.owners.get(owner);
      if (!owned || [...paths].some(path => !owned.has(path))) {
        throw new ProjectLifecycleError('PROJECT_LIFECYCLE_OWNER_STALE', 'Project lifecycle owner is stale or belongs to another project.');
      }
    }
    for (const [token, active] of this.owners) {
      if (token !== owner && [...paths].some(path => path === '*' || active.has('*') || active.has(path))) {
        throw new ProjectLifecycleError('PROJECT_OPERATION_BUSY', '项目正在保存、重载或切换开发板，请等待当前宿主操作完成。');
      }
    }
    const token = Symbol('project-lifecycle');
    this.owners.set(token, paths);
    return { token, release: () => { this.owners.delete(token); } };
  }
}

function normalize(path: string): string { return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
