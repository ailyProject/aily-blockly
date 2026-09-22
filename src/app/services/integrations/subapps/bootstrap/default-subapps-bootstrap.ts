export const DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID = 'aily-chat';

export interface DefaultSubappCatalogItem {
  id: string;
  toolId: string;
  installed: boolean;
  uninstalling?: boolean;
  enabled?: boolean;
  only?: string;
  config?: unknown;
  app?: {
    enabled?: boolean;
    autoInstall?: boolean;
    defaultToolbar?: boolean;
  };
}

export interface DefaultSubappsBootstrapAdapter {
  initialize(): Promise<void>;
  readCatalog(): readonly DefaultSubappCatalogItem[];
  isAvailable(item: DefaultSubappCatalogItem): boolean;
  install(catalogId: string): Promise<void>;
  onError(id: string, error: unknown): void;
}

/** Reconcile catalog defaults with installed apps at every
 * startup. Sequential installations share the host's install-progress stream.
 */
export async function bootstrapDefaultSubapps(
  adapter: DefaultSubappsBootstrapAdapter,
): Promise<void> {
  await adapter.initialize();
  const findItem = (id: string) => adapter.readCatalog().find(app => app.id === id);
  const eligible = (item: DefaultSubappCatalogItem | undefined): item is DefaultSubappCatalogItem =>
    !!item && !item.uninstalling && item.enabled !== false && item.app?.enabled !== false
      && adapter.isAvailable(item);

  for (const entry of adapter.readCatalog()) {
    try {
      const item = findItem(entry.id);
      if (!eligible(item)) continue;
      if (item.app?.autoInstall === true && !item.installed) {
        await adapter.install(item.id);
      }
    } catch (error) {
      adapter.onError(entry.id, error);
    }
  }
}
