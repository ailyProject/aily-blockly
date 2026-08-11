export function boardRequiresCloudAuth(boardPackageJson: unknown): boolean {
  return !!boardPackageJson
    && typeof boardPackageJson === 'object'
    && (boardPackageJson as Record<string, unknown>)['auth'] === true;
}
