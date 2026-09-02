interface SubWindowState {
  path?: unknown;
  open?: unknown;
}

interface SubWindowEnvironment {
  windows?: SubWindowState[];
}

interface SubWindowControlResult {
  success?: unknown;
  error?: unknown;
  state?: SubWindowState;
}

export interface ProjectSubWindowBridge {
  list: () => Promise<SubWindowEnvironment>;
  control: (path: string, action: 'close') => Promise<SubWindowControlResult>;
}

export function isConnectionGraphWindowPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;

  const queryIndex = path.indexOf('?');
  if (queryIndex < 0 || path.slice(0, queryIndex).replace(/^\/+/, '') !== 'iframe') {
    return false;
  }

  const iframeUrl = new URLSearchParams(path.slice(queryIndex + 1)).get('url');
  if (!iframeUrl) return false;

  try {
    return new URL(iframeUrl).pathname.replace(/\/+$/u, '') === '/connection-graph';
  } catch {
    return false;
  }
}

/** Close every detached connection-graph surface before its project is released. */
export async function closeConnectionGraphSubWindows(
  bridge: ProjectSubWindowBridge | null | undefined,
): Promise<boolean> {
  if (!bridge?.list || !bridge?.control) return false;

  const environment = await bridge.list();
  const paths = (environment?.windows || [])
    .map(windowState => windowState?.path)
    .filter(isConnectionGraphWindowPath);

  for (const path of paths) {
    const result = await bridge.control(path, 'close');
    const isClosed = result?.state?.open === false || result?.error === 'window-not-found';
    if (!isClosed) return false;
  }

  return true;
}
