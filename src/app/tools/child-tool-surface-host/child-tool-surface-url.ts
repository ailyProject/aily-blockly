export function resolveRuntimeSurfaceEntry(entry: string, uiIndex: string): string {
  const normalizedEntry = String(entry || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const normalizedUiIndex = String(uiIndex || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalizedEntry === normalizedUiIndex) {
    return '';
  }
  const uiRoot = normalizedUiIndex.includes('/')
    ? normalizedUiIndex.slice(0, normalizedUiIndex.lastIndexOf('/') + 1)
    : '';

  return uiRoot && normalizedEntry.startsWith(uiRoot)
    ? normalizedEntry.slice(uiRoot.length)
    : normalizedEntry;
}
