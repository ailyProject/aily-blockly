export const DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID = 'aily-chat-react';
export const DEFAULT_AILY_CHAT_SUBAPP_BOOTSTRAP_KEY = 'defaultAilyChatSubappInstalledAt';

export interface DefaultAilyChatCatalogItem {
  id: string;
  toolId: string;
  installed: boolean;
}

export interface DefaultAilyChatBootstrapAdapter {
  completed: boolean;
  initialize(): Promise<void>;
  readCatalog(): readonly DefaultAilyChatCatalogItem[];
  install(catalogId: string): Promise<void>;
  isPinned(): boolean;
  pin(): boolean;
  markCompleted(): Promise<void>;
}

export async function bootstrapDefaultAilyChatSubapp(
  adapter: DefaultAilyChatBootstrapAdapter,
): Promise<boolean> {
  if (adapter.completed) {
    return false;
  }

  await adapter.initialize();
  let item = adapter.readCatalog().find(app => app.toolId === DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID);
  if (!item) {
    return false;
  }

  if (!item.installed) {
    await adapter.install(item.id);
    item = adapter.readCatalog().find(app => app.toolId === DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID);
  }
  if (!item?.installed) {
    return false;
  }

  if (!adapter.isPinned() && !adapter.pin()) {
    return false;
  }

  await adapter.markCompleted();
  return true;
}
