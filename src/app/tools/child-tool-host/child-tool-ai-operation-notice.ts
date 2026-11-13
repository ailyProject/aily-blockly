import type { NoticeOptions } from '@shared/public-api';

export interface AiOperationNoticePort {
  updateOwned(owner: string, notice: NoticeOptions): boolean;
  clearOwned(owner: string): boolean;
}

export interface AiOperationNoticeState {
  readonly running: boolean;
  readonly stopping: boolean;
  readonly synchronizing?: boolean;
  readonly writing: boolean;
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

  constructor(private readonly notices: AiOperationNoticePort, private readonly owner: string) {}

  update(state: AiOperationNoticeState): void {
    const kind = state.running ? state.synchronizing ? 'synchronizing' : state.stopping ? 'stopping' : 'running'
      : state.writing ? 'settling' : state.recoveryRequired ? 'recovery' : 'idle';
    const signature = JSON.stringify([kind, state.executionKey, state.projectPath]);
    if (kind !== 'recovery') this.dismissedRecovery = '';
    if (kind === 'idle') {
      this.signature = signature;
      this.notices.clearOwned(this.owner);
      return;
    }
    if (kind === 'recovery' && this.dismissedRecovery === signature) return;
    if (signature === this.signature) return;
    const notice: NoticeOptions = {
      title: kind === 'recovery' ? '工作区需要恢复'
        : kind === 'synchronizing' ? '正在同步 AI 状态'
        : kind === 'stopping' ? '正在停止 AI'
        : kind === 'settling' ? '正在结束工作区操作' : 'AI正在操作',
      text: kind === 'recovery' ? '画布已保留并暂停编辑。请在对话中按恢复提示继续；关闭此提示不会解除保护。'
        : kind === 'synchronizing' ? '正在重新连接对话，等待确认原任务状态。'
        : kind === 'stopping' || kind === 'settling' ? '正在等待已开始的操作安全结束。' : undefined,
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
