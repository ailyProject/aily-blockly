export function getLinkUploadParam(boardConfig: unknown): string {
  if (!boardConfig || typeof boardConfig !== 'object') {
    return '';
  }

  const value = (boardConfig as Record<string, unknown>)['linkUploadParam'];
  return typeof value === 'string' ? value.trim() : '';
}

export function hasLinkUploadParam(boardConfig: unknown): boolean {
  return getLinkUploadParam(boardConfig).length > 0;
}
