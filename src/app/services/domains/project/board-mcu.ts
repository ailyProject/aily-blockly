/** Board-package declaration only. No SDK lookup, build result or name guessing.
 * Missing/invalid declarations remain unknown so legacy boards still open. */
export function normalizeBoardMcu(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const mcu = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(mcu) ? mcu : undefined;
}

/** Normalize a detached board configuration, never persist derived metadata. */
export function normalizeBoardMcuDeclaration(board: Record<string, any>): void {
  const mcu = normalizeBoardMcu(board['mcu']);
  if (mcu === undefined) delete board['mcu'];
  else board['mcu'] = mcu;
}
