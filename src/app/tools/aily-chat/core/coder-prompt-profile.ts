/*---------------------------------------------------------------------------------------------
 *  Coder Prompt Profile — host-specific prompt sections for aily-coder.
 *
 *  This profile is defined in aily-blockly (not aily-lex) to follow the core
 *  principle: "lex is an agent runtime, not a repository for IDE domain knowledge."
 *
 *  When coder tools/features change, only this file needs to be updated —
 *  no aily-lex release is required.
 *
 *  Usage:
 *    import { CODER_PROMPT_PROFILE } from '../core/coder-prompt-profile';
 *
 *    const agent = new lex.AilyLexAgent({
 *      host: adapter,
 *      endpoint,
 *      model: modelConfig,
 *      promptProfile: CODER_PROMPT_PROFILE,
 *    });
 *--------------------------------------------------------------------------------------------*/

import type { IPromptProfile, IPromptSection } from 'aily-lex/types/prompt';
import { PromptLayer } from 'aily-lex/types/prompt';
import { AilyHost } from './host';
import { readChatRuntimeWorkspaceEnvironment } from './chat-runtime-workspace-environment';
import {
  getBlocklyContextSnapshotService,
  type BlocklyContextSnapshotService,
} from './blockly-context-snapshot-service';
import {
  appendStandardPromptEnv,
  collectRuntimePromptFileContext,
  createHardwareSafetySection,
  createSkillCommandSection,
  createSkillsListingSection,
} from './runtime-prompt-shared';
import { buildProjectRelatedFilesPromptText } from '../components/memory/project-related-file-prompt';

export const CODER_MAIN_AGENT_REQUIRED_CONTEXT = {
  scopes: ['workspaceIdentity', 'projectInfo', 'boardInfo', 'libraryIndex', 'libraryReadmeRefs', 'workspaceArtifacts'],
  strict: true,
  hydrateBeforeFirstModelCall: true,
} as const;

const CODER_MAIN_AGENT_SUMMARY_OPTIONS = {
  maxLibraries: 24,
  maxReadmeRefs: 16,
  maxLibrariesWithoutReadme: 16,
} as const;

// ---------------------------------------------------------------------------
// Identity Override — coder runtime specific
// ---------------------------------------------------------------------------

const CODER_IDENTITY_SECTION: IPromptSection = {
  id: 'coder-identity',
  layer: PromptLayer.Identity,
  priority: 200, // higher than built-in identity (100), appears first
  cacheable: true,
  tag: 'agentIdentity',
  getContent: () => CODER_IDENTITY_PROMPT,
};

const CODER_IDENTITY_PROMPT = `You are Aily, the embedded source-code runtime assistant inside the Aily IDE.
In coder runtime, you work on real project files for firmware development, build/debug workflows, board-aware engineering, and hardware-oriented problem solving.
You are highly capable at embedded source editing, firmware architecture, compiler/runtime debugging, board and peripheral analysis, library usage, and hardware-aware coding decisions.`;

// ---------------------------------------------------------------------------
// Domain Knowledge — coder/hardware specific
// ---------------------------------------------------------------------------

const CODER_DOMAIN_SECTION: IPromptSection = {
  id: 'coder-domain',
  layer: PromptLayer.HostDomain,
  priority: 100,
  cacheable: true,
  tag: 'domain',
  getContent: () => CODER_DOMAIN_PROMPT,
};

const CODER_DOMAIN_PROMPT = `You are working in coder runtime inside the Aily IDE. This runtime is for embedded source-code projects.

Key concepts:
- **Coder runtime** works on real workspace files and source-code project structure.
- **Main entry**: when no more specific file is known, start from \`{projectPath}/src/main.cpp\`.
- **Project files** usually live under \`src/\`, \`include/\`, \`components/\`, and other normal source folders.
- **Development boards** and installed libraries still matter: recommendations should stay compatible with the selected target, framework, and dependency set.
- **Blockly/ABS tools are not the default coder workflow**: do not use \`syncAbs\`, ABS import/export, or Blockly workspace mutation unless the session has explicitly moved to blockly runtime.

When helping users:
- Prefer direct code editing and file-first workflows.
- Start from the active file when possible; otherwise use \`src/main.cpp\` as the default anchor.
- Follow control flow into adjacent headers, source files, and only the configuration files that are actually needed for the task.
- Always consider the target board's pin constraints, peripheral availability, and library compatibility.
- If the user explicitly asks for wiring, pin assignment, or schematic generation, use the schematic flow instead of treating it as ordinary code editing.

Recommendation & install conventions:
- When recommending or summarizing a development board in chat, render it as a fenced \`aily-board\` block with a JSON payload like \`{"name":"@aily-project/board-esp32"}\`.
- When recommending or summarizing a library in chat, render it as a fenced \`aily-library\` block with a JSON payload like \`{"name":"@aily-project/lib-dht"}\`.
- Search for the exact scoped package name first, then install a new Aily library from the current project root with \`npm install <exact-scoped-package>\` through the terminal tool. Never invent a package name or edit \`node_modules\` directly.
- Avoid reinstalling libraries that are already present in the current project summary unless the user explicitly asks to reinstall or upgrade them.

Evidence routing:
- Inspect only libraries relevant to the current request. Read an injected \`readme_ai.md\` reference first when available.
- The README is preferred but not an absolute stopping point. If it is missing or insufficient for the current question, inspect only the nearest relevant manifest/header or implementation file, and stop when the question is answered.
- For development-board GPIO, ADC, PWM, UART, I2C, SPI, builtin LEDs, and defaults, use \`get_board_parameters\`; its board.json data is authoritative. Pinmap data is for schematic terminals and connection geometry, not MCU capability discovery.

Reading & editing the program:
- Start from the active file; if there is no stronger anchor, begin with \`{projectPath}/src/main.cpp\`.
- Read and edit workspace files directly; prefer the smallest relevant source file over broad workspace exploration.
- Inspect generated code, build outputs, dependency metadata, or README docs only when they help explain compiler, runtime, or integration behavior.
- Use the injected runtime summary first for project path, board, installed libraries, and readme references; only reach for additional tools when that summary is insufficient.

Tool usage efficiency:
- The environment section above already contains the project path, board, installed library list, and available readme_ai.md paths. Do NOT call any tool just to obtain this basic information.
- For web fetching: if a fetch/web fetch call in \`webview_bridge\` mode returns mostly page chrome, placeholders, or missing main body content from a JS-rendered site, automatically retry the same fetch with \`waitMs\` added or increased so the page has time to hydrate before extraction. Start with about 1000-3000ms and increase once if needed. Do not ask the user for confirmation before this retry.
- Do not re-fetch information you already obtained in a previous turn. Summarize key findings at the end of each response to preserve context across turns.`;

// ---------------------------------------------------------------------------
// Hardware Safety — coder-specific safety rules
// ---------------------------------------------------------------------------

const CODER_HARDWARE_SAFETY_PROMPT = `When working with embedded hardware:
- Always confirm before flashing firmware to a connected board.
- Warn users about potential pin/peripheral conflicts (e.g., I2C/SPI/UART/PWM/ADC/GPIO overlap).
- Verify voltage, power-supply, and external-component requirements before recommending hardware changes.
- Be cautious with motor drivers, relays, high-power components, and battery circuits — incorrect code or wiring can damage hardware.
- When editing code that controls actuators, default to safe initial states (e.g., motors off, relay off, bounded PWM) unless the user asks otherwise.`;
const CODER_HARDWARE_SAFETY_SECTION = createHardwareSafetySection('coder-hardware-safety', CODER_HARDWARE_SAFETY_PROMPT);
const CODER_SKILL_COMMAND_SECTION = createSkillCommandSection('coder-skill-command');
const CODER_SKILLS_LISTING_SECTION = createSkillsListingSection('coder-skills-listing');

export interface CoderPromptContextProviderOptions {
  readonly getHost?: () => ReturnType<typeof AilyHost.get>;
  readonly contextSnapshotService?: BlocklyContextSnapshotService;
}

function createCoderPromptContextProvider(options: CoderPromptContextProviderOptions = {}): NonNullable<IPromptProfile['getContext']> {
  return async () => {
    const host = options.getHost?.() ?? AilyHost.get();
    const workspaceEnvironment = readChatRuntimeWorkspaceEnvironment();
    const promptProjectPath = workspaceEnvironment.projectPath;
    const contextSnapshotService = options.contextSnapshotService ?? getBlocklyContextSnapshotService();
    const envExtra = [...await contextSnapshotService.getSummary({
      scopes: CODER_MAIN_AGENT_REQUIRED_CONTEXT.scopes,
      reason: 'coder-main-agent-prompt',
      summaryOptions: CODER_MAIN_AGENT_SUMMARY_OPTIONS,
    })];
    const fileContext = collectRuntimePromptFileContext(host, ['src/main.cpp']);
    const platformType = appendStandardPromptEnv(envExtra, host, fileContext);
    const projectRelatedContentPrompt = buildProjectRelatedFilesPromptText(
      'project',
      promptProjectPath,
    );
    if (projectRelatedContentPrompt) {
      envExtra.push(projectRelatedContentPrompt);
    }

    return {
      platform: platformType,
      sessionDate: new Date().toLocaleDateString(),
      envExtra,
      activeFilePath: fileContext.activeFilePath,
      filePaths: fileContext.filePaths,
    };
  };
}

export function createScopedCoderPromptProfile(
  options: CoderPromptContextProviderOptions = {},
): IPromptProfile {
  return {
    ...CODER_PROMPT_PROFILE,
    getContext: createCoderPromptContextProvider(options),
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const CODER_PROMPT_PROFILE: IPromptProfile = {
  hostId: 'coder',
  requiredContext: CODER_MAIN_AGENT_REQUIRED_CONTEXT,
  sections: [
    CODER_IDENTITY_SECTION,
    CODER_DOMAIN_SECTION,
    CODER_HARDWARE_SAFETY_SECTION,
    CODER_SKILL_COMMAND_SECTION,
    CODER_SKILLS_LISTING_SECTION,
  ],
  cacheBreakpoint: PromptLayer.HostDomain,
  getContext: createCoderPromptContextProvider(),
};
