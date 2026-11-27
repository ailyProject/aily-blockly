import type { NoticeOptions } from '@shared/public-api';

export interface AiOperationNoticePort {
  updateOwned(owner: string, notice: NoticeOptions): boolean;
  clearOwned(owner: string): boolean;
}

export interface AiOperationNoticeState {
  readonly running: boolean;
  readonly stopping: boolean;
  readonly synchronizing?: boolean;
  readonly automationWriting: boolean;
  readonly recoveryRequired: boolean;
  readonly projectPath: string;
  readonly executionKey: string;
  readonly stop?: () => void;
}

/** Running work and a preserved recovery fence have different lifetimes. This
 * presenter never releases either a writer or a recovery grant. */
export class ChildAiOperationNotice {
  private signature = '';
  private dismissedRecovery = '';

  constructor(private readonly notices: AiOperationNoticePort, private readonly owner: string,
    private readonly translate: (key: string) => string) {}

  update(state: AiOperationNoticeState, refreshText = false): void {
    const kind = state.running ? state.synchronizing ? 'synchronizing' : state.stopping ? 'stopping' : 'running'
      : state.automationWriting ? 'settling' : state.recoveryRequired ? 'recovery' : 'idle';
    const signature = JSON.stringify([kind, state.executionKey, state.projectPath]);
    if (kind !== 'recovery') this.dismissedRecovery = '';
    if (kind === 'idle') {
      this.signature = signature;
      this.notices.clearOwned(this.owner);
      return;
    }
    if (kind === 'recovery' && this.dismissedRecovery === signature) return;
    if (signature === this.signature && !refreshText) return;
    const key = `NOTIFICATION.AI_${kind.toUpperCase()}`;
    const notice: NoticeOptions = {
      title: this.translate(key),
      text: kind === 'recovery' || kind === 'stopping' || kind === 'synchronizing'
        ? this.translate(key + '_DETAIL') : undefined,
      state: kind === 'recovery' ? 'warn' : 'doing',
      closable: kind === 'recovery',
      showProgress: false,
      setTimeout: 0,
      sendToLog: false,
      ...(kind === 'running' && state.stop ? { stop: state.stop } : {}),
      ...(kind === 'recovery' ? { onClose: () => {
        this.dismissedRecovery = signature;
        this.notices.clearOwned(this.owner);
      } } : {}),
    };
    // A compiler or another child may currently own the shared notification.
    // Keep this presentation pending instead of overwriting its active work.
    if (this.notices.updateOwned(this.owner, notice)) this.signature = signature;
  }

  clear(): void {
    this.signature = '';
    this.notices.clearOwned(this.owner);
  }
}
