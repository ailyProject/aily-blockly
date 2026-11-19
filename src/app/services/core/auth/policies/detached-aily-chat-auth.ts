export interface RendererLocationLike {
  readonly pathname?: string;
  readonly hash?: string;
}

/**
 * A detached Aily Chat window runs the Angular host shell on the child-tool
 * route. The shell consumes token-free state from the main renderer; only the
 * managed Node runtime may request an access-token lease from the host bridge.
 */
export function isDetachedAilyChatRenderer(
  location: RendererLocationLike | undefined = typeof window !== 'undefined' ? window.location : undefined,
): boolean {
  if (!location) return false;

  const hashRoute = String(location.hash || '')
    .replace(/^#/u, '')
    .split('?', 1)[0]
    .replace(/^\/+/, '/')
    .replace(/\/+$/u, '');

  if (hashRoute === '/child-tool/aily-chat' || hashRoute === '/child-tool/device-manager') return true;

  const pathname = String(location.pathname || '').replace(/\/+$/u, '');

  return pathname === '/child-tool/aily-chat' || pathname === '/child-tool/device-manager';
}
