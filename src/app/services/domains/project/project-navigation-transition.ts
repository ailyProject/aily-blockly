export interface ProjectViewReservation {
  requestId: string;
  rendererGeneration: number;
  sourceProject: string;
  projectPath: string;
}

/** Before the old editor is retired, only reversible preparation is in flight. */
export class ProjectNavigationTransition {
  private readonly controller = new AbortController();
  private handoff = false;

  stop = (): boolean => {
    if (this.handoff) return false;
    this.controller.abort(Object.assign(new Error('The original navigation stopped before changing the view.'), {
      code: 'PROJECT_DEPENDENCY_CANCELLED',
    }));
    return true;
  };

  assertCurrent(): void {
    this.controller.signal.throwIfAborted();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  beginHandoff(): void {
    this.assertCurrent();
    this.handoff = true;
  }

  async wait<T>(work: Promise<T>): Promise<T> {
    const { signal } = this.controller;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
    try { return await Promise.race([work, cancelled]); }
    finally { signal.removeEventListener('abort', cancel); }
  }
}
