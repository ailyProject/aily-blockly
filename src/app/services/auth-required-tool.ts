const AUTH_REQUIRED_TOOL_IDS = new Set([
  'aily-chat',
  'aily-chat-react',
  'cloud-space',
  'user-center',
]);

export function isAuthRequiredTool(toolId: string | null | undefined): boolean {
  return typeof toolId === 'string' && AUTH_REQUIRED_TOOL_IDS.has(toolId);
}

export function collectOpenAuthRequiredToolIds(
  openToolIds: readonly string[],
  openWindowPaths: readonly string[],
): string[] {
  const windowToolIds = openWindowPaths.map((path) => {
    const normalizedPath = normalizeWindowPath(path);
    const childToolMatch = normalizedPath.match(/^\/child-tool\/([^/?#]+)/);
    if (childToolMatch?.[1]) {
      return decodeURIComponent(childToolMatch[1]);
    }
    return normalizedPath.replace(/^\/+/, '');
  });

  return [...new Set([...openToolIds, ...windowToolIds])]
    .filter((toolId) => isAuthRequiredTool(toolId));
}

function normalizeWindowPath(path: string): string {
  const trimmedPath = String(path || '').trim();
  const hashRouteIndex = trimmedPath.indexOf('#/');
  const routePath = hashRouteIndex >= 0 ? trimmedPath.slice(hashRouteIndex + 2) : trimmedPath;
  return `/${routePath.replace(/^\/+/, '')}`;
}
