export interface BoardConfigSelection {
  key?: string;
  data?: unknown;
  extra?: {
    selectAction?: string;
  };
}

export interface ProjectConfigStore {
  getPackageJson(): Promise<any>;
  setPackageJson(packageJson: any): Promise<void>;
}

/**
 * Persist a board menu selection and report whether the stored value changed.
 * The package file is the source of truth so a previously clicked option can be
 * selected again after the project configuration is reloaded or modified.
 */
export async function persistBoardConfigSelection(
  store: ProjectConfigStore,
  selection: BoardConfigSelection,
): Promise<boolean> {
  if (!selection.key) {
    return false;
  }

  const packageJson = await store.getPackageJson();
  if (!packageJson) {
    return false;
  }

  packageJson.projectConfig = packageJson.projectConfig || {};
  if (packageJson.projectConfig[selection.key] === selection.data) {
    return false;
  }

  packageJson.projectConfig[selection.key] = selection.data;
  await store.setPackageJson(packageJson);
  return true;
}

export function shouldRunBoardConfigSelectionEffects(
  configChanged: boolean,
  selection: BoardConfigSelection,
): boolean {
  return configChanged || Boolean(selection.extra?.selectAction);
}
