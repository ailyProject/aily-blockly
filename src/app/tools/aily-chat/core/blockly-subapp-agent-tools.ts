import type { IToolContribution, ToolResultContent } from 'aily-lex/browser';
import type { IExternalHostAPI } from 'aily-lex/host/blockly';

import {
  ChildToolAgentDefinition,
  ChildToolConfig,
  getChildToolConfigs,
} from '../../../configs/tool.config';
import {
  error,
  text,
  type InvokeHandler,
} from './blockly-contributed-tool-runtime';

export interface SubappAgentToolBinding {
  readonly toolId: string;
  readonly definition: ChildToolAgentDefinition;
}

interface SubappAgentHostCapability {
  execute(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export function collectSubappAgentToolBindings(
  configs: Record<string, ChildToolConfig> = getChildToolConfigs(),
): SubappAgentToolBinding[] {
  const candidates = Object.values(configs).flatMap(config =>
    (config.agent?.tools || []).map(definition => ({
      toolId: config.id,
      definition,
    })),
  );
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.definition.name, (counts.get(candidate.definition.name) || 0) + 1);
  }
  return candidates.filter(candidate => counts.get(candidate.definition.name) === 1);
}

export function appendSubappAgentContributions(
  contributions: IToolContribution[],
  bindings: readonly SubappAgentToolBinding[],
): void {
  for (const binding of bindings) {
    const definition = binding.definition;
    contributions.push({
      name: definition.name,
      toolSet: `subapp:${binding.toolId}`,
      description: definition.description || definition.name,
      prompt: '',
      inputSchema: definition.inputSchema as any,
      annotations: {
        readOnly: definition.permission !== 'change',
      },
      runtimeModes: ['blockly', 'coder'],
      agentScope: ['main'],
    } as IToolContribution);
  }
}

export function createSubappAgentHandlers(
  bindings: readonly SubappAgentToolBinding[],
): Record<string, InvokeHandler> {
  return Object.fromEntries(bindings.map(binding => [
    binding.definition.name,
    async (
      input: Record<string, unknown>,
      hostAPI: IExternalHostAPI,
      invocationContext,
    ): Promise<ToolResultContent> => {
      const capability = (hostAPI as IExternalHostAPI & {
        subappAgent?: SubappAgentHostCapability;
      }).subappAgent;
      if (!capability?.execute) {
        return error('Subapp Agent host capability is unavailable.');
      }
      const response = await capability.execute({
        toolId: binding.toolId,
        tool: binding.definition.name,
        params: input,
      }, invocationContext?.signal);
      const serialized = JSON.stringify(response);
      return response['ok'] === true
        ? text(serialized, {
            toolId: binding.toolId,
            subappAgentTool: binding.definition.name,
          })
        : error(String(response['error'] || serialized), {
            toolId: binding.toolId,
            subappAgentTool: binding.definition.name,
            errorCode: response['errorCode'],
            details: response['details'],
          });
    },
  ]));
}
