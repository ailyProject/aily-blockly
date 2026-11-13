export type AutoSaveState = '' | 'pending' | 'saving' | 'saved' | 'error';

/** One idle save, tied to the current project and its latest edit generation. */
export class ProjectAutoSave {
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private running = false;
  private disposed = false;
  constructor(private readonly hooks: {
    project: () => string;
    enabled: () => boolean;
    ready: () => boolean;
    dirty: () => Promise<boolean>;
    save: (path: string) => Promise<{ success: boolean; projectSaved?: boolean; code?: string; error?: string }>;
    state: (state: AutoSaveState, error?: string) => void;
  }) {}

  edited(): void {
    clearTimeout(this.timer);
    const revision = ++this.revision, path = this.hooks.project();
    if (this.disposed || !path || !this.hooks.enabled()) { this.hooks.state(''); return; }
    this.hooks.state('pending');
    this.timer = setTimeout(() => { void this.flush(path, revision); }, 2000);
  }
  cancel(): void { clearTimeout(this.timer); this.revision++; this.hooks.state(''); }
  dispose(): void { this.disposed = true; this.cancel(); }
  private current(path: string, revision: number): boolean {
    return !this.disposed && revision === this.revision && path === this.hooks.project() && this.hooks.enabled();
  }
  private async flush(path: string, revision: number): Promise<void> {
    if (!this.current(path, revision)) return;
    if (this.running || !this.hooks.ready()) {
      this.timer = setTimeout(() => { void this.flush(path, revision); }, 2000);
      return;
    }
    this.running = true;
    try {
      const dirty = await this.hooks.dirty();
      if (!this.current(path, revision)) return;
      if (!this.hooks.ready()) {
        this.timer = setTimeout(() => { void this.flush(path, revision); }, 2000);
        return;
      }
      if (!dirty) { this.hooks.state(''); return; }
      this.hooks.state('saving');
      const result = await this.hooks.save(path);
      const saved = result.success || (result.projectSaved === true && result.code === 'BUILD_WORKSPACE_BUSY');
      if (this.current(path, revision)) this.hooks.state(saved ? 'saved' : 'error', saved ? undefined : result.error);
    } catch (error) {
      if (this.current(path, revision)) this.hooks.state('error', error instanceof Error ? error.message : String(error));
    } finally { this.running = false; }
  }
}
