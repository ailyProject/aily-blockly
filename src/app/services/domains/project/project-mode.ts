export type ProjectMode = 'blockly' | 'coder';

/** package.json is authoritative for Coder; Blockly opens from complete ABS or a legacy ABI. */
export function detectProjectMode(input: {
  manifest?: unknown;
  hasAbi: boolean;
  hasCompleteAbs?: boolean;
  hasAci: boolean;
  hasArduinoSketch?: boolean;
}): ProjectMode | null {
  if (input.manifest && typeof input.manifest === 'object'
    && (input.manifest as { type?: unknown }).type === 'coder') {
    return 'coder';
  }
  if (input.hasAbi || input.hasCompleteAbs) return 'blockly';
  if (input.hasAci) return 'coder';
  if (!input.manifest && input.hasArduinoSketch) return 'coder';
  return null;
}

export function getProjectApplicationName(mode: ProjectMode): string {
  return mode === 'coder' ? 'Aily Coder' : 'Aily Blockly';
}

/** Explicit AI mode arguments are assertions, never permission to change the host mode. */
export function getProjectCreationModeError(
  mode: ProjectMode,
  params: Record<string, unknown>,
): string | null {
  for (const key of ['developmentMode', 'projectType', 'mode', 'type']) {
    const requested = params[key];
    if (requested != null && requested !== mode) {
      return `${getProjectApplicationName(mode)} can only create ${mode} projects. Open the other application to create a different project type.`;
    }
  }
  return null;
}
