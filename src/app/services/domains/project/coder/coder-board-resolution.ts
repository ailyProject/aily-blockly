export interface CoderBoardLike {
  boardId?: string;
  name?: string;
  nickname?: string;
  package?: string;
  version?: string;
  [key: string]: unknown;
}

/** Resolve one board from the shared Blockly/Coder board catalog. */
export function resolveCoderBoard(
  boards: readonly CoderBoardLike[],
  requestedName: string,
): CoderBoardLike | undefined {
  const requested = normalizePackageName(requestedName);
  const requestedIdentity = normalizeIdentity(requestedName);

  return boards.find((board) => {
    const packageName = String(board.name || board.package || '').trim();
    if (normalizePackageName(packageName) === requested) {
      return true;
    }
    return requestedIdentity && [board.boardId, board.name, board.nickname]
      .some((value) => normalizeIdentity(value) === requestedIdentity);
  });
}

function normalizePackageName(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeIdentity(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}
