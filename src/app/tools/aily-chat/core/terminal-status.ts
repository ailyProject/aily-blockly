export interface TerminalStatusLike {
  readonly status?: string | null;
  readonly exitCode?: number | null;
  readonly isRunning?: boolean;
  readonly running?: boolean;
}

export type TerminalLifecycleState = 'running' | 'completed' | 'failed' | 'cancelled';

function normalizeTerminalStatus(status: string | null | undefined): string | undefined {
  return typeof status === 'string' && status.trim().length > 0
    ? status.trim().toLowerCase()
    : undefined;
}

export function resolveTerminalLifecycleState(terminal: TerminalStatusLike): TerminalLifecycleState {
  const status = normalizeTerminalStatus(terminal.status);
  if (terminal.isRunning === true || terminal.running === true || status === 'running' || status === 'stalled') {
    return 'running';
  }
  if (status === 'cancelled') {
    return 'cancelled';
  }
  if (status === 'failed' || status === 'timeout' || status === 'killed') {
    return 'failed';
  }
  if (status === 'completed') {
    return 'completed';
  }
  if (typeof terminal.exitCode === 'number') {
    return terminal.exitCode === 0 ? 'completed' : 'failed';
  }
  return 'completed';
}

export function isTerminalFailureState(terminal: TerminalStatusLike): boolean {
  return resolveTerminalLifecycleState(terminal) === 'failed';
}

export function isTerminalCancelledState(terminal: TerminalStatusLike): boolean {
  return resolveTerminalLifecycleState(terminal) === 'cancelled';
}
