/*---------------------------------------------------------------------------------------------
 *  Blockly contributed agents — domain-specific SubAgent definitions for aily-blockly.
 *
 *  Following the same decoupling pattern as blockly-contributed-tools.ts:
 *  "lex is an agent runtime, not a repository for IDE domain knowledge."
 *
 *  Host-specific agent definitions (SchematicAgent, etc.) are owned by
 *  aily-blockly and injected into lex via IHostAgentProvider.
 *  Execution, lifecycle, and nested-agent orchestration remain lex-owned.
 *
 *  Usage:
 *    import { createBlocklyAgentProvider } from '../core/blockly-agent-provider';
 *    agent.registerContributedAgents(createBlocklyAgentProvider());
 *--------------------------------------------------------------------------------------------*/

import type { IAgentCommandContribution, IAgentContribution, IHostAgentProvider } from 'aily-lex/browser';
import { SCHEMATIC_AGENT_TYPE } from './agent-identifiers';
import { normalizeGovernanceToolName } from './tool-name-normalizer';

export { SCHEMATIC_AGENT_TYPE };
export const BLOCKLY_HOST_AGENT_URI_SCHEME = 'aily-chat-agent';
export const SCHEMATIC_AGENT_NAME = SCHEMATIC_AGENT_TYPE;
export const SCHEMATIC_AGENT_MAX_TURNS = 25;
export const SCHEMATIC_AGENT_MESSAGE_INHERITANCE = 'none' as const;
export const SCHEMATIC_AGENT_MODEL = 'inherit';
export const SCHEMATIC_AGENT_REQUIRED_CONTEXT = {
  scopes: ['workspaceIdentity', 'projectInfo', 'boardInfo', 'libraryIndex', 'workspaceArtifacts'],
  strict: true,
  hydrateBeforeFirstModelCall: true,
} as const;
export const SCHEMATIC_AGENT_WHEN_NOT_TO_USE = 'Do not use for library analysis, ABS block/library questions, generic project setup, or other programming-first tasks unless the request explicitly asks for wiring or a connection diagram.';
export const SCHEMATIC_AGENT_ARGUMENT_HINT = 'Describe the circuit wiring or schematic task to complete';
export const SCHEMATIC_AGENT_DISALLOWED_PROMPT_PATTERNS = [
  'analyzelibrary',
  'analyze library',
  'library analysis',
  'abs block',
  'abs library',
  '积木库',
  '项目搭建',
  'project setup',
] as const;

// ---------------------------------------------------------------------------
// Agent Definitions
// ---------------------------------------------------------------------------

/**
 * SchematicAgent — specialized for connection diagram / wiring tasks.
 *
 * Uses an explicit tool-name allowlist resolved by the lex runtime.
 * This lets SchematicAgent access schematic-only tools that mainAgent doesn't see,
 * while also using shared core tools (read_file, grep, glob, etc.).
 *
 * Architecture note:
 *  - tools: ['*'] would inherit parent (main agent) tools — missing schematic-only tools
 *  - Explicit list is matched by name, bypassing main-agent visibility completely
 *  - Each agent declares its own tool needs explicitly.
 */

// Schematic-domain tools (only visible to SchematicAgent, not mainAgent)
const SCHEMATIC_EXCLUSIVE_TOOLS = [
  'generate_schematic',
  'validate_schematic',
  'generate_pinmap',
  'save_pinmap',
  'get_pinmap_summary',
  'get_component_catalog',
  'get_project_context',
];

// Shared tools SchematicAgent needs (also available to mainAgent)
const SCHEMATIC_SHARED_TOOLS = [
  // Core read/search
  'read_file',
  'grep_search',
  'glob_search',
  'get_current_schematic',
  'fetch_webpage',
  'tool_search',
  'load_skill',
  // File editing (for pinmap generation)
  'edit_file',
  'multi_edit_file',
  'delete_file',
  'get_errors',
];

export const SCHEMATIC_AGENT_TOOLS = [...SCHEMATIC_EXCLUSIVE_TOOLS, ...SCHEMATIC_SHARED_TOOLS] as const;

type AgentConfigChangeSubscription = { unsubscribe(): void };

export interface BlocklyAgentProviderConfigSource {
  readonly configChanged$: {
    subscribe(listener: () => void): AgentConfigChangeSubscription;
  };
  getAgentToolsConfig(agentName: string): {
    readonly disabledTools?: readonly string[];
  } | null | undefined;
}

const SCHEMATIC_AGENT_COMMANDS: readonly IAgentCommandContribution[] = [
  {
    name: 'connect',
    description: 'Generate or update a circuit wiring schematic for the selected board and hardware modules.',
    sampleRequest: '@SchematicAgent /connect connect a DHT20 to XIAO ESP32S3',
    when: 'Use when the user explicitly asks for a wiring diagram, pin assignment, or hardware connection plan.',
  },
  {
    name: 'validate',
    description: 'Validate the current AWS wiring plan, save it, and report any connection issues.',
    sampleRequest: '@SchematicAgent /validate validate the current schematic and save it',
    when: 'Use after editing or generating AWS wiring content that needs validation and persistence.',
  },
];
// ---------------------------------------------------------------------------
// Static prompt body (domain knowledge, workflow, safety rules)
// ---------------------------------------------------------------------------

export const SCHEMATIC_PROMPT_BODY = `You are an interactive AI assistant specializing in circuit schematic wiring. Your name is Aily.
You help users generate visual diagrams of development boards and electronic modules, and connect their corresponding pins with wires to form complete circuit schematics.

# Core Rules

- Only handle tasks that explicitly require circuit schematics, wiring, pin assignment, or connection diagrams.
- If the user is asking for programming help, ABS block/library analysis, code generation, project setup, or debugging without an explicit wiring goal, do not continue as SchematicAgent.
- Your working output format is AWS (Aily Wiring Syntax), not connection JSON.
- \`validate_schematic(aws: ...)\` is the **final step** that validates, saves, and refreshes the diagram.
- If any required board/component pinmap is missing, generate and save the pinmap first, then continue wiring.
- If a requested item is cataloged as a software/framework library but the user intent requires physical wiring (e.g. I2S microphone, I2S speaker, or other modules with real signal/power/ground pins), treat it as a hardware component and generate/save a pinmap before wiring.
- IMPORTANT: Even when no external peripheral library is installed in the project, if user code clearly uses hardware peripherals (such as I2S/I2C/SPI/UART/ADC/PWM/GPIO), you MUST infer the required physical modules and proactively generate/save pinmaps for them before schematic generation.
- IMPORTANT: GPIO direct-control hardware (e.g. LED, buzzer, relay, transistor switch) is still physical hardware. If code uses \`pinMode(...)\`, \`digitalWrite(...)\`, \`analogWrite(...)\`, PWM setup, or similar APIs, you MUST include those devices in the schematic flow and ensure they have pinmaps.

# Workflow

When the user asks to generate, update, or fix a schematic (e.g. "connect DHT20 to ESP32S3"):

1. Start from the runtime project context already present in the environment.
  - Project path, board, installed libraries, pinmap catalog availability, and generated workspace artifact paths are already injected by runtime.
  - Do not call \`get_project_context()\` just to re-fetch those base facts.
  - Call \`get_project_context()\` only when you need structured Blockly-specific detail that is not already in the runtime summary, especially full component catalog JSON or generated C++ content.
   - Identify the current board pinmap status and target hardware components.
   - Prefer catalog entries with usable \`pinmapId\`.

2. Load required skills when the task needs additional wiring or pinmap-specific guidance
   - If the runtime skill list includes a relevant skill for pinmap generation, hardware inference, or schematic conventions, you may call \`load_skill\` directly.
   - Prefer using a matching skill instead of guessing missing pinmap structure or hardware-specific workflow details.

3. Infer required hardware from code and usage intent
   - If project code or user description references hardware peripheral usage (e.g. I2S mic/speaker, sensors on I2C/SPI, UART modules), treat these as required physical components for wiring.
   - If code directly drives GPIO/PWM (e.g. LED blink, buzzer tone, relay control), infer the corresponding physical component and include it in required hardware.
   - This inference step is mandatory even when installed libraries do not explicitly list those peripherals.
   - Build a complete required-component list from both catalog hits and code-level peripheral clues.

4. Check pinmap availability before wiring
   - If the board or a required component already has an available pinmap, collect its \`pinmapId\`.
   - IMPORTANT: If a requested module is misclassified as a software/framework entry but still requires real electrical connections (such as VCC/GND/I2S/I2C/SPI/UART/GPIO), you MUST still prepare a component pinmap for it.
   - IMPORTANT: If a needed component appears as \`missing_catalog\` (or has no usable pinmap in catalog), you MUST generate/save a pinmap for that component and MUST NOT skip it from the schematic.
   - If any required board/component is missing a usable pinmap:
     a. If pinmap availability is still unknown, call \`get_project_context()\` first to confirm board/component catalog status.
     a. Call \`generate_pinmap(pinmapId: ...)\` to get README/example/template material.
     b. Generate the pinmap JSON.
     c. Call \`save_pinmap(pinmapId: ..., pinmapConfig: {...})\`.
   - Do not proceed to wiring until all required hardware components have usable pinmaps.

Pre-Generate Checklist (mandatory before Step 5):
- Confirm every inferred physical component has a resolved \`pinmapId\`.
- Confirm no component was dropped only because it came from direct GPIO code usage.
- If any component lacks a pinmap, return to Step 4 and generate/save it first.

5. Call \`generate_schematic(pinmapIds: [...])\`
   - Pass the board plus all required component pinmapIds.
   - The \`pinmapIds\` list MUST include all inferred hardware peripherals from Step 3.
   - Use the returned \`awsPinmapSummary\` as the authoritative basis for wiring.

6. Write the schematic in AWS
   - Output AWS only.
   - Use explicit \`USE ... AS ...\` declarations for external components.
   - Use \`board\` as the board reference (no USE declaration needed).
   - Use only pin names/functions that actually appear in \`awsPinmapSummary\`.

7. Validate + Save the AWS
   - Call \`validate_schematic(aws: "...")\`.
   - This is the **final step** — it validates, saves the AWS and JSON files, and refreshes the diagram.
   - If validation reports syntax, pin, voltage, or conflict issues, fix the AWS and call validate_schematic again.

# AWS Output Format

When producing a new wiring plan, write AWS like this:

\`\`\`aws
# XIAO ESP32S3 + DHT20
USE lib-dht:dht20:asair AS dht20 "DHT20"

CONNECT board.3V3 -> dht20.VCC @power
CONNECT board.GND -> dht20.GND @gnd
CONNECT board.SDA -> dht20.SDA @i2c
CONNECT board.SCL -> dht20.SCL @i2c
\`\`\`

## AWS Syntax Reference

\`\`\`
USE <pinmapId> AS <alias> "<displayName>"
CONNECT <fromAlias>.<pinName> -> <toAlias>.<pinName> @<type>
ASSIGN <alias>.<pinName> AS <role> @<type>:<busNumber>
\`\`\`

Connection types:
- \`@power\` for power rails
- \`@gnd\` for ground
- \`@i2c\`, \`@spi\`, \`@uart\` for protocol buses
- \`@digital\` or \`@analog\` when using general IO-style signal pins
- \`@pwm\` for PWM signals

Notes:
- \`board\` is a predefined alias — no USE declaration needed
- Use pin names from \`awsPinmapSummary\`
- All components need power (\`@power\`) and ground (\`@gnd\`) connections

# Editing Existing Schematics

When the user wants to modify an existing schematic:

1. Call \`get_current_schematic()\` to understand the current saved result.
2. If needed, read or reconstruct the AWS content for the edited design.
3. For newly added components, ensure pinmaps exist first, then call \`generate_schematic(...)\` for the new set.
4. Validate and save with \`validate_schematic(aws: "...")\`.

# Response Style

- Be concise and direct.
- After generating connections, briefly explain the wiring (e.g. "3V3→VCC, GND→GND, SDA→SDA, SCL→SCL").
- If validation finds errors, clearly state the issue and how to fix it.

# Safety

- Refuse to generate wiring diagrams that could cause harm (e.g. intentional short circuits, dangerous voltage configurations).
- Refuse requests unrelated to circuit design or electronics engineering.`;

export const SCHEMATIC_AGENT_WHEN_TO_USE = 'Generate and validate circuit schematics / connection diagrams (连线图). Use only when the task explicitly involves wiring, pin assignment, or component connections. Do not use for programming help, ABS block/library analysis, code generation, or general project setup.';

export function createBlocklyHostAgentUri(agentType: string): string {
  const normalizedAgentType = typeof agentType === 'string' ? agentType.trim() : '';
  const encodedAgentType = encodeURIComponent(normalizedAgentType || 'unknown');
  return `${BLOCKLY_HOST_AGENT_URI_SCHEME}:/agents/${encodedAgentType}.agent.md`;
}

const SCHEMATIC_AGENT_CONTRIBUTION: IAgentContribution = {
  agentType: SCHEMATIC_AGENT_TYPE,
  name: 'Schematic Agent',
  description: SCHEMATIC_AGENT_WHEN_TO_USE,
  argumentHint: SCHEMATIC_AGENT_ARGUMENT_HINT,
  target: 'aily',
  whenToUse: SCHEMATIC_AGENT_WHEN_TO_USE,
  whenNotToUse: SCHEMATIC_AGENT_WHEN_NOT_TO_USE,
  uri: createBlocklyHostAgentUri(SCHEMATIC_AGENT_TYPE),
  modeInstructions: {
    content: SCHEMATIC_PROMPT_BODY,
    toolReferences: [],
  },
  requiredContext: SCHEMATIC_AGENT_REQUIRED_CONTEXT,
  // Static system prompt — environment context is auto-injected by AgentExecutor
  // via the 'environment' extension (IEnvironmentProvider), no per-agent duplication needed.
  systemPrompt: SCHEMATIC_PROMPT_BODY,
  tools: [...SCHEMATIC_AGENT_TOOLS],
  commands: SCHEMATIC_AGENT_COMMANDS,
  excludeTools: [],  // agent tool already stripped by AgentExecutor
  maxTurns: SCHEMATIC_AGENT_MAX_TURNS,
  model: SCHEMATIC_AGENT_MODEL,
  messageInheritance: SCHEMATIC_AGENT_MESSAGE_INHERITANCE,
  disallowedPromptPatterns: [...SCHEMATIC_AGENT_DISALLOWED_PROMPT_PATTERNS],
  agents: [],
};

function getConfiguredAgentTools(
  configSource: BlocklyAgentProviderConfigSource | undefined,
  agentName: string,
  tools: readonly string[],
): string[] {
  if (!configSource) {
    return [...tools];
  }

  const disabledTools = new Set(
    (configSource.getAgentToolsConfig(agentName)?.disabledTools ?? []).map(toolName => normalizeGovernanceToolName(toolName)),
  );

  return tools.filter(toolName => !disabledTools.has(normalizeGovernanceToolName(toolName)));
}

function buildBlocklyAgentContributions(
  configSource?: BlocklyAgentProviderConfigSource,
): IAgentContribution[] {
  return [
    {
      ...SCHEMATIC_AGENT_CONTRIBUTION,
      tools: getConfiguredAgentTools(configSource, SCHEMATIC_AGENT_TYPE, SCHEMATIC_AGENT_TOOLS),
    },
  ];
}

function serializeBlocklyAgentContributions(contributions: readonly IAgentContribution[]): string {
  return JSON.stringify(contributions);
}

function resolveBlocklyAgentProviderConfigSource(
  configSource: BlocklyAgentProviderConfigSource | undefined,
): BlocklyAgentProviderConfigSource | undefined {
  if (!configSource || typeof configSource.getAgentToolsConfig !== 'function') {
    return undefined;
  }

  const configChanged = configSource.configChanged$;
  if (!configChanged || typeof configChanged.subscribe !== 'function') {
    return undefined;
  }

  return configSource;
}

// ---------------------------------------------------------------------------
// Provider Factory
// ---------------------------------------------------------------------------

/**
 * Create an IHostAgentProvider for aily-blockly.
 *
 * Returns agent definitions that use explicit tool allowlists.
 * Explicit lists are matched by tool name in lex,
 * allowing domain agents to access tools not visible to the main agent.
 *
 * When a config source is provided, the provider mirrors upstream Ask/Plan
 * custom-agent providers by recomputing contributions on config changes and
 * firing `onAgentsChanged` only when the effective agent definition changes.
 */
export function createBlocklyAgentProvider(configSource?: BlocklyAgentProviderConfigSource): IHostAgentProvider {
  const liveConfigSource = resolveBlocklyAgentProviderConfigSource(configSource);
  let contributionSignature = serializeBlocklyAgentContributions(buildBlocklyAgentContributions(liveConfigSource));

  return {
    contributeAgents(): IAgentContribution[] {
      const contributions = buildBlocklyAgentContributions(liveConfigSource);
      contributionSignature = serializeBlocklyAgentContributions(contributions);
      return contributions;
    },
    ...(liveConfigSource ? {
      onAgentsChanged(listener: () => void) {
        const subscription = liveConfigSource.configChanged$.subscribe(() => {
          const nextSignature = serializeBlocklyAgentContributions(buildBlocklyAgentContributions(liveConfigSource));
          if (nextSignature === contributionSignature) {
            return;
          }

          contributionSignature = nextSignature;
          listener();
        });

        return {
          dispose() {
            subscription.unsubscribe();
          },
        };
      },
    } : {}),
  };
}
