export const MAIN_AGENT_TYPE = 'main';
export const MAIN_AGENT_LEGACY_ALIAS = 'mainAgent';
export const SCHEMATIC_AGENT_TYPE = 'SchematicAgent';
export const SCHEMATIC_AGENT_LEGACY_ALIAS = 'schematicAgent';
export const PROJECT_SCENE_AGENT_TYPE = 'ProjectSceneAgent';

export type CanonicalAgentIdentifier =
  | typeof MAIN_AGENT_TYPE
  | typeof SCHEMATIC_AGENT_TYPE
  | typeof PROJECT_SCENE_AGENT_TYPE;

export function normalizeAgentIdentifier(agentName: string | null | undefined): string {
  const normalized = typeof agentName === 'string' ? agentName.trim() : '';
  if (!normalized) {
    return '';
  }
  if (normalized === MAIN_AGENT_LEGACY_ALIAS) {
    return MAIN_AGENT_TYPE;
  }
  if (normalized === SCHEMATIC_AGENT_LEGACY_ALIAS) {
    return SCHEMATIC_AGENT_TYPE;
  }
  return normalized;
}

export function normalizeAgentIdentifiers(agentNames: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(agentNames)) {
    return [];
  }

  return [...new Set(
    agentNames
      .map(agentName => normalizeAgentIdentifier(agentName))
      .filter(agentName => agentName.length > 0),
  )];
}

export function isMainAgentIdentifier(agentName: string | null | undefined): boolean {
  return normalizeAgentIdentifier(agentName) === MAIN_AGENT_TYPE;
}

export function isSchematicAgentIdentifier(agentName: string | null | undefined): boolean {
  return normalizeAgentIdentifier(agentName) === SCHEMATIC_AGENT_TYPE;
}

export function isProjectSceneAgentIdentifier(agentName: string | null | undefined): boolean {
  return normalizeAgentIdentifier(agentName) === PROJECT_SCENE_AGENT_TYPE;
}
