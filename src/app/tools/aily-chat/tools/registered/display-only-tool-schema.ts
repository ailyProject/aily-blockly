import type { ToolSchema } from '../../core/tool-types';
import { MAIN_AGENT_TYPE, normalizeAgentIdentifiers } from '../../core/agent-identifiers';
import { withDisplayOnlyCompat } from './display-only-compat';

interface DisplayOnlyToolSchemaOptions {
  description?: string;
  agents?: string[];
}

export function createDisplayOnlyToolSchema(
  name: string,
  options?: DisplayOnlyToolSchemaOptions,
): ToolSchema {
  const agents = normalizeAgentIdentifiers(options?.agents) || [];
  return {
    name,
    description: withDisplayOnlyCompat(options?.description ?? `${name} display-only compatibility schema`),
    input_schema: { type: 'object', properties: {}, required: [] },
    agents: agents.length > 0 ? agents : [MAIN_AGENT_TYPE],
  };
}