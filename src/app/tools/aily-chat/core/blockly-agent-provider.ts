import type {
  IAgentCommandContribution,
  IAgentContribution,
  IHostAgentProvider,
} from 'aily-lex/browser';

import { PROJECT_SCENE_AGENT_TYPE } from './agent-identifiers';
import { normalizeGovernanceToolName } from './tool-name-normalizer';

export {
  PROJECT_SCENE_AGENT_TYPE,
};

export const BLOCKLY_HOST_AGENT_URI_SCHEME = 'aily-chat-agent';
export const PROJECT_SCENE_AGENT_NAME = PROJECT_SCENE_AGENT_TYPE;
export const PROJECT_SCENE_AGENT_MAX_TURNS = 12;
export const PROJECT_SCENE_AGENT_MESSAGE_INHERITANCE = 'none' as const;
export const PROJECT_SCENE_AGENT_MODEL = 'inherit';
export const PROJECT_SCENE_AGENT_REQUIRED_CONTEXT = {
  scopes: ['workspaceIdentity', 'projectInfo', 'boardInfo', 'libraryIndex', 'workspaceArtifacts'],
  strict: true,
  hydrateBeforeFirstModelCall: true,
} as const;
export const PROJECT_SCENE_AGENT_TOOLS = [
  'get_project_scene_generation_context',
  'submit_project_scene_wiring_intent',
] as const;

type AgentConfigChangeSubscription = { unsubscribe(): void };

export interface BlocklyAgentProviderConfigSource {
  readonly configChanged$: {
    subscribe(listener: () => void): AgentConfigChangeSubscription;
  };
  getAgentToolsConfig(agentName: string): {
    readonly disabledTools?: readonly string[];
  } | null | undefined;
}

const PROJECT_SCENE_AGENT_COMMANDS: readonly IAgentCommandContribution[] = [
  {
    name: 'generate',
    description: 'Generate a bounded native v2 Project Scene proposal for the active simulator request.',
    sampleRequest: '@ProjectSceneAgent /generate generate the native Project Scene from the current project',
    when: 'Use only when the independent Simulator has an active Project Scene generation request.',
  },
];

export const PROJECT_SCENE_AGENT_WHEN_TO_USE =
  'Generate a bounded native v2 Project Scene proposal only for an active request from the independent Simulator.';
export const PROJECT_SCENE_AGENT_WHEN_NOT_TO_USE =
  'Do not use without an active Project Scene generation request. Never read or translate connection_output.json, generate AWS, edit files, control QEMU/GDB, or handle non-Scene tasks.';
export const PROJECT_SCENE_AGENT_ARGUMENT_HINT =
  'Generate the requested native Project Scene proposal';
export const PROJECT_SCENE_PROMPT_BODY = `You are ProjectSceneAgent, a narrowly scoped proposal provider for the independent Aily Simulator.

# Authority boundary

- You never own, open, persist, or directly edit a Scene document.
- You never control the Simulator iframe, QEMU, GDB, UART, instruments, sessions, or runtime processes.
- You never use AWS, connection.aws, legacy schematic tools, pinmap generation tools, or connection_output.json.
- You never use generic file editing, deletion, shell, network, or arbitrary tool discovery.
- The Simulator Project Scene authority validates revisions, Component Packages, terminals, functions, electrical topology, and persistence.

# Workflow

1. Call get_project_scene_generation_context exactly once with the requestId from the provider prompt.
2. Use only the bounded request, authoritative Component Package guide, and injected current-project context.
3. Infer the physical board, components, exact GPIO/bus functions, power topology, internal pull configuration, and required explicit resistors.
4. Submit only request-scoped part refs, catalog package IDs, and multi-terminal semantic nets through submit_project_scene_wiring_intent. Never choose package versions, persistent IDs, layout, routing, or presentation.
5. If the request is expired, replaced, or revision-conflicted, stop without writing any file.

# Electrical rules

- LED and button are two-terminal components.
- Model LED source/sink polarity correctly and include an explicit current-limiting resistor when required.
- Distinguish internal INPUT_PULLUP/INPUT_PULLDOWN from an external resistor.
- Never short power to ground or connect multiple push-pull outputs together.
- Use only package IDs, versions, terminal IDs, terminal functions, and signal kinds advertised by the generation context.`;

export function createBlocklyHostAgentUri(agentType: string): string {
  const normalizedAgentType = typeof agentType === 'string' ? agentType.trim() : '';
  return `${BLOCKLY_HOST_AGENT_URI_SCHEME}:/agents/${encodeURIComponent(normalizedAgentType || 'unknown')}.agent.md`;
}

const PROJECT_SCENE_AGENT_CONTRIBUTION: IAgentContribution = {
  agentType: PROJECT_SCENE_AGENT_TYPE,
  name: 'Project Scene Agent',
  description: PROJECT_SCENE_AGENT_WHEN_TO_USE,
  argumentHint: PROJECT_SCENE_AGENT_ARGUMENT_HINT,
  target: 'aily',
  whenToUse: PROJECT_SCENE_AGENT_WHEN_TO_USE,
  whenNotToUse: PROJECT_SCENE_AGENT_WHEN_NOT_TO_USE,
  uri: createBlocklyHostAgentUri(PROJECT_SCENE_AGENT_TYPE),
  modeInstructions: { content: PROJECT_SCENE_PROMPT_BODY, toolReferences: [] },
  requiredContext: PROJECT_SCENE_AGENT_REQUIRED_CONTEXT,
  systemPrompt: PROJECT_SCENE_PROMPT_BODY,
  tools: [...PROJECT_SCENE_AGENT_TOOLS],
  commands: PROJECT_SCENE_AGENT_COMMANDS,
  excludeTools: [],
  maxTurns: PROJECT_SCENE_AGENT_MAX_TURNS,
  model: PROJECT_SCENE_AGENT_MODEL,
  messageInheritance: PROJECT_SCENE_AGENT_MESSAGE_INHERITANCE,
  agents: [],
};

function getConfiguredAgentTools(
  configSource: BlocklyAgentProviderConfigSource | undefined,
  agentName: string,
  tools: readonly string[],
): string[] {
  const disabledTools = new Set(
    (configSource?.getAgentToolsConfig(agentName)?.disabledTools ?? [])
      .map(toolName => normalizeGovernanceToolName(toolName)),
  );
  return tools.filter(toolName => !disabledTools.has(normalizeGovernanceToolName(toolName)));
}

function buildBlocklyAgentContributions(
  configSource?: BlocklyAgentProviderConfigSource,
): IAgentContribution[] {
  return [
    {
      ...PROJECT_SCENE_AGENT_CONTRIBUTION,
      tools: getConfiguredAgentTools(configSource, PROJECT_SCENE_AGENT_TYPE, PROJECT_SCENE_AGENT_TOOLS),
    },
  ];
}

function resolveConfigSource(
  configSource: BlocklyAgentProviderConfigSource | undefined,
): BlocklyAgentProviderConfigSource | undefined {
  return configSource
    && typeof configSource.getAgentToolsConfig === 'function'
    && typeof configSource.configChanged$?.subscribe === 'function'
    ? configSource
    : undefined;
}

export function createBlocklyAgentProvider(
  configSource?: BlocklyAgentProviderConfigSource,
): IHostAgentProvider {
  const liveConfigSource = resolveConfigSource(configSource);
  let signature = JSON.stringify(buildBlocklyAgentContributions(liveConfigSource));

  return {
    contributeAgents(): IAgentContribution[] {
      const contributions = buildBlocklyAgentContributions(liveConfigSource);
      signature = JSON.stringify(contributions);
      return contributions;
    },
    ...(liveConfigSource ? {
      onAgentsChanged(listener: () => void) {
        const subscription = liveConfigSource.configChanged$.subscribe(() => {
          const nextSignature = JSON.stringify(buildBlocklyAgentContributions(liveConfigSource));
          if (nextSignature !== signature) {
            signature = nextSignature;
            listener();
          }
        });
        return { dispose: () => subscription.unsubscribe() };
      },
    } : {}),
  };
}
