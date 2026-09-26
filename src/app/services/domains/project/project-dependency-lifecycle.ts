import { Subject } from 'rxjs';

export interface ProjectDependencySession {
  readonly projectPath: string;
  readonly projectSessionId: string;
  readonly signal: AbortSignal;
}

interface DependencyEntry {
  session: ProjectDependencySession;
  controller: AbortController;
  preparing: boolean;
  pending: number;
  idleWaiters: Array<() => void>;
}

/** Tracks preparation and work owned by one opening of a project. */
export class ProjectDependencyLifecycle {
  private readonly entries = new Map<string, DependencyEntry>();
  private readonly changesSubject = new Subject<void>();
  readonly changes = this.changesSubject.asObservable();

  constructor(private readonly normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')) {}

  ensure(projectPath: string): ProjectDependencySession {
    const current = this.get(projectPath);
    if (current) {
      this.assertCurrent(current);
      return current;
    }
    const controller = new AbortController();
    const session = Object.freeze({ projectPath, projectSessionId: globalThis.crypto.randomUUID(), signal: controller.signal });
    this.entries.set(this.normalize(projectPath), { session, controller, preparing: false, pending: 0, idleWaiters: [] });
    this.changesSubject.next();
    return session;
  }

  beginPreparation(projectPath: string): ProjectDependencySession {
    const session = this.ensure(projectPath);
    const entry = this.entries.get(this.normalize(projectPath))!;
    entry.preparing = true;
    this.changesSubject.next();
    return session;
  }

  get(projectPath: string): ProjectDependencySession | undefined {
    return this.entries.get(this.normalize(projectPath))?.session;
  }

  assertCurrent(session: ProjectDependencySession): void {
    if (this.get(session.projectPath) !== session || session.signal.aborted) {
      throw Object.assign(new Error('Project dependency session was cancelled or replaced.'), { code: 'PROJECT_DEPENDENCY_CANCELLED' });
    }
  }

  async run<T>(session: ProjectDependencySession, work: () => Promise<T>): Promise<T> {
    this.assertCurrent(session);
    const entry = this.entries.get(this.normalize(session.projectPath))!;
    entry.pending += 1;
    this.changesSubject.next();
    try {
      this.assertCurrent(session);
      const result = await work();
      this.assertCurrent(session);
      return result;
    } catch (error) {
      this.assertCurrent(session);
      throw error;
    } finally {
      entry.pending -= 1;
      if (!entry.pending) entry.idleWaiters.splice(0).forEach(resolve => resolve());
      this.changesSubject.next();
    }
  }

  finishPreparation(session: ProjectDependencySession): void {
    const entry = this.entries.get(this.normalize(session.projectPath));
    if (entry?.session !== session || !entry.preparing) return;
    entry.preparing = false;
    this.changesSubject.next();
  }

  cancel(projectPath: string): ProjectDependencySession | undefined {
    const entry = this.entries.get(this.normalize(projectPath));
    if (!entry) return undefined;
    entry.preparing = false;
    entry.controller.abort();
    this.changesSubject.next();
    return entry.session;
  }

  waitForIdle(session: ProjectDependencySession): Promise<void> {
    const entry = this.entries.get(this.normalize(session.projectPath));
    if (entry?.session !== session || !entry.pending) return Promise.resolve();
    return new Promise(resolve => entry.idleWaiters.push(resolve));
  }

  release(session: ProjectDependencySession): void {
    const key = this.normalize(session.projectPath);
    if (this.entries.get(key)?.session !== session) return;
    this.entries.delete(key);
    this.changesSubject.next();
  }

  isBusy(projectPath: string): boolean {
    const entry = this.entries.get(this.normalize(projectPath));
    return !!entry && (entry.preparing || entry.pending > 0 || entry.session.signal.aborted);
  }

  isStopping(projectPath: string): boolean {
    return this.get(projectPath)?.signal.aborted === true;
  }
}
