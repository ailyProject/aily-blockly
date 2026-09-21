/** Board switching is a project lifecycle operation, never an npm library edit. */
export interface BoardSwitchPort {
  currentProject(): string;
  readBoard(): Promise<Record<string, any>>;
  resolveBoard(name: string): Promise<{ name: string; version: string } | undefined>;
  changeBoard(board: { name: string; version: string }): Promise<void>;
  ensureRuntime(project: string): Promise<void>;
  isReady(project: string): boolean;
}

export async function switchProjectBoard(input: Record<string, unknown>, port: BoardSwitchPort): Promise<Record<string, any>> {
  const project = port.currentProject();
  const name = input['boardName'];
  const base = { operation: 'board_switch', project };
  if (!project || typeof name !== 'string' || !/^@aily-project\/board-[\w.-]+$/.test(name)) {
    return { ...base, ok: false, changed: false, reason: 'invalid_board', message: 'Use the exact boardName returned by search_boards_libraries.' };
  }
  let changed = false;
  let changeAttempted = false;
  const assertCurrent = () => {
    if (port.currentProject() !== project) throw new Error('Active project changed during board switch. No further writes were attempted.');
  };
  try {
    const board = await port.resolveBoard(name);
    assertCurrent();
    if (!board) return { ...base, ok: false, changed, reason: 'board_not_in_catalog' };
    const before = await port.readBoard();
    const previousBoard = before['ok'] ? before['boardPackage'] : undefined;
    assertCurrent();
    if (previousBoard !== name) {
      // A thrown lifecycle call may already have persisted part of the change.
      changeAttempted = true;
      await port.changeBoard(board);
      changed = true;
      assertCurrent();
    }
    await port.ensureRuntime(project);
    assertCurrent();
    const boardState = await port.readBoard();
    const currentBoard = boardState['ok'] ? boardState['boardPackage'] : undefined;
    assertCurrent();
    if (!port.isReady(project) || currentBoard !== name) {
      return { ...base, ok: false, changed, reason: 'board_runtime_not_ready', requestedBoard: name, currentBoard, boardState,
        message: 'Board lifecycle returned, but the loaded board/runtime did not match. This is not confirmation of background loading.',
        recovery: { automaticRetry: false, action: 'resolve_host_lifecycle_error' },
        guidance: 'Resolve boardState/host load diagnostics. Do not sleep or repeatedly reinstall/switch the same board as a readiness workaround.' };
    }
    return { ...base, ok: true, changed, ready: true, previousBoard, boardPackage: currentBoard,
      guidance: 'Board template options were reset when switching. Existing project source and user libraries are retained; verify their compatibility before editing/building.' };
  } catch (error) {
    const code = (error as any)?.code;
    return { ...base, ok: false, changed: changed ? true : changeAttempted ? null : false,
      stateMayHaveChanged: changeAttempted, code,
      reason: code === 'PROJECT_RELOAD_REJECTED' ? 'project_reload_rejected' : code === 'PROJECT_OPERATION_BUSY' ? 'project_operation_busy' : 'board_switch_failed',
      message: error instanceof Error ? error.message : String(error),
      recovery: { automaticRetry: false, action: 'resolve_host_lifecycle_error' },
      guidance: 'Inspect the current project/board state before retrying. A failed switch is not proof of rollback; do not use lib_add/lib_remove or edit package.json to switch boards.' };
  }
}
