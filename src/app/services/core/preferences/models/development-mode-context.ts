export type DevelopmentMode = 'blockly' | 'coder';
export type DevelopmentModeSource = 'settings' | 'project';

export interface DevelopmentModeContext {
  readonly developmentMode: DevelopmentMode;
  readonly developmentModePreference: DevelopmentMode;
  readonly developmentModeLocked: boolean;
  readonly developmentModeSource: DevelopmentModeSource;
}

export function resolveDevelopmentModeContext(input: {
  readonly preference: unknown;
  readonly projectPath?: string | null;
  readonly isCoderProject?: boolean;
}): DevelopmentModeContext {
  const preference: DevelopmentMode = input.preference === 'coder' ? 'coder' : 'blockly';
  const projectOpen = Boolean(String(input.projectPath || '').trim());

  if (!projectOpen) {
    return {
      developmentMode: preference,
      developmentModePreference: preference,
      developmentModeLocked: false,
      developmentModeSource: 'settings',
    };
  }

  return {
    developmentMode: input.isCoderProject === true ? 'coder' : 'blockly',
    developmentModePreference: preference,
    developmentModeLocked: true,
    developmentModeSource: 'project',
  };
}
