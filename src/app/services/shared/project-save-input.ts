export type ProjectSaveInput =
  | { kind: 'board-config'; configKey: string; configValue: string }
  | { kind: 'board-switch'; boardName: string };

/** Command meaning only. Current menus, runtime and project bytes are observed
 * by their existing owners; they are never recaptured into this original input. */
export function readProjectSaveInput(value: unknown): ProjectSaveInput | undefined {
  if (value === undefined) return undefined;
  const input = value as ProjectSaveInput;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const keys = Object.keys(input).sort().join(',');
    if (input.kind === 'board-config' && keys === 'configKey,configValue,kind'
      && typeof input.configKey === 'string' && input.configKey.length > 0 && typeof input.configValue === 'string') {
      return { kind: 'board-config', configKey: input.configKey, configValue: input.configValue };
    }
    if (input.kind === 'board-switch' && keys === 'boardName,kind'
      && typeof input.boardName === 'string' && /^@aily-project\/board-[\w.-]+$/.test(input.boardName)) {
      return { kind: 'board-switch', boardName: input.boardName };
    }
  }
  throw Object.assign(new Error('Invalid original board publication input.'), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
}
