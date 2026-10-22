/** Display metadata for an application-bundled Web presentation. It grants no
 * installed-runtime, project, account or execution authority. */
export interface ChildToolWebAppMetadata {
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly only?: string;
  readonly router?: readonly string[];
  readonly core?: readonly string[];
  readonly enabled?: boolean;
  readonly defaultToolbar?: boolean;
}

export interface ChildToolWebAppDescriptor {
  readonly load?: unknown;
  readonly app?: ChildToolWebAppMetadata;
}

export interface ChildToolWebAppItem {
  id: string;
  name: string;
  description?: string;
  icon: string;
  only?: string;
  router?: string[];
  core?: string[];
  enabled: boolean;
  defaultToolbar: boolean;
  action: 'tool-open';
  data: { type: 'tool'; data: string };
}

function metadata(descriptor: ChildToolWebAppDescriptor | undefined): ChildToolWebAppMetadata | null {
  const app = descriptor?.app;
  return typeof descriptor?.load === 'function' && typeof app?.name === 'string' && app.name.trim()
    ? app : null;
}

export function hasWebToolApp(platform: 'native' | 'web',
  presentations: Readonly<Record<string, ChildToolWebAppDescriptor>>, toolId: string): boolean {
  return platform === 'web' && Boolean(toolId) && Object.hasOwn(presentations, toolId)
    && metadata(presentations[toolId]) !== null;
}

/** One descriptor supplies discovery and presentation. Only display fields are
 * projected; native installation metadata and executable routing are excluded. */
export function projectWebToolApps(platform: 'native' | 'web',
  presentations: Readonly<Record<string, ChildToolWebAppDescriptor>>): ChildToolWebAppItem[] {
  if (platform !== 'web') return [];
  return Object.entries(presentations).flatMap(([id, descriptor]) => {
    const app = metadata(descriptor);
    return !id || !app ? [] : [{ id, name: app.name, description: app.description,
      icon: app.icon || 'fa-light fa-puzzle-piece', only: app.only,
      router: app.router ? [...app.router] : undefined, core: app.core ? [...app.core] : undefined,
      enabled: app.enabled !== false, defaultToolbar: app.defaultToolbar === true,
      action: 'tool-open' as const, data: { type: 'tool' as const, data: id } }];
  });
}
