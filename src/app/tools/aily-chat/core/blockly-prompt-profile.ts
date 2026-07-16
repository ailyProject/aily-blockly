/*---------------------------------------------------------------------------------------------
 *  Blockly Prompt Profile — host-specific prompt sections for aily-blockly.
 *
 *  This profile is defined in aily-blockly (not aily-lex) to follow the core
 *  principle: "lex is an agent runtime, not a repository for IDE domain knowledge."
 *
 *  When blockly tools/features change, only this file needs to be updated —
 *  no aily-lex release is required.
 *
 *  Usage:
 *    import { BLOCKLY_PROMPT_PROFILE } from '../core/blockly-prompt-profile';
 *
 *    const agent = new lex.AilyLexAgent({
 *      host: adapter,
 *      endpoint,
 *      model: modelConfig,
 *      promptProfile: BLOCKLY_PROMPT_PROFILE,
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

export const BLOCKLY_MAIN_AGENT_REQUIRED_CONTEXT = {
  scopes: ['workspaceIdentity', 'projectInfo', 'boardInfo', 'libraryIndex', 'libraryReadmeRefs', 'workspaceArtifacts'],
  strict: true,
  hydrateBeforeFirstModelCall: true,
} as const;

const BLOCKLY_MAIN_AGENT_SUMMARY_OPTIONS = {
  maxLibraries: 24,
  maxReadmeRefs: 16,
  maxLibrariesWithoutReadme: 16,
} as const;

// ---------------------------------------------------------------------------
// Identity Override — aily-blockly specific
// ---------------------------------------------------------------------------

const BLOCKLY_IDENTITY_SECTION: IPromptSection = {
  id: 'blockly-identity',
  layer: PromptLayer.Identity,
  priority: 200, // higher than built-in identity (100), appears first
  cacheable: true,
  tag: 'agentIdentity',
  getContent: () => BLOCKLY_IDENTITY_PROMPT,
};

const BLOCKLY_IDENTITY_PROMPT = `You are an interactive AI assistant specializing in aily blockly development, and your name is Aily.
You can assist users with various embedded software engineering tasks, including project analysis, development board selection, library management, code generation with blockly, and library conversion.
You are knowledgeable about microcontrollers (ESP32, Arduino, STM32), sensors, actuators, electronic circuits, and the ABS hardware control syntax.`;

// ---------------------------------------------------------------------------
// Domain Knowledge — blockly/hardware specific
// ---------------------------------------------------------------------------

const BLOCKLY_DOMAIN_SECTION: IPromptSection = {
  id: 'blockly-domain',
  layer: PromptLayer.HostDomain,
  priority: 100,
  cacheable: true,
  tag: 'domain',
  getContent: () => BLOCKLY_DOMAIN_PROMPT,
};

const BLOCKLY_DOMAIN_PROMPT = `You are working inside Aily Blockly, a visual block programming IDE for embedded systems.

Key concepts:
- **ABS (Aily Block Syntax)**: A domain-specific language that compiles to Arduino C++ code. Users build programs by connecting visual blocks.
- **Projects**: Each project targets a specific development board and contains an ABS workspace, libraries, and build configuration.
- **Libraries**: Reusable component packages that extend blockly with new blocks for sensors, actuators, and communication modules.
- **Development Boards**: ESP32, Arduino Uno/Mega/Nano, STM32, and other MCU boards with specific pin mappings and capabilities.
- **Build Pipeline**: ABS workspace → ABS transpiler → Arduino C++ → Compiler → Firmware binary → Flash to board.

When helping users:
- Prefer ABS block-based solutions over raw C++ code unless explicitly asked for code.
- Always consider the target board's pin constraints and peripheral availability.
- Validate library compatibility with the selected board before recommending them.
- For hardware-related changes (flashing firmware, changing pin configurations), confirm with the user first.

Recommendation & install conventions:
- When recommending or summarizing a development board in chat, render it as a fenced \`aily-board\` block with a JSON payload like \`{"name":"@aily-project/board-esp32"}\`.
- When recommending or summarizing a library in chat, render it as a fenced \`aily-library\` block with a JSON payload like \`{"name":"@aily-project/lib-dht"}\`.
- Install new Aily libraries with \`npm install @aily-project/lib-xxx\`.
- Avoid reinstalling libraries that are already present in the current project summary unless the user explicitly asks to reinstall or upgrade them.

Reading & editing the program:
- The ABS source file is at \`{projectPath}/project.abs\` — use \`read_file\` to read it directly.
- The generated C++ is at \`{projectPath}/.temp/sketch/sketch.ino\` — use \`read_file\` to inspect generated code.
- To modify the program: use \`syncAbs action="export"\` to sync workspace → .abs file, then \`read_file\` / \`edit_file\` on project.abs, then \`syncAbs action="import"\` to apply changes back to the workspace.
- Use \`lint\` to check the generated C++ for syntax errors. Use mode \`fast\` for quick feedback, \`accurate\` for the strictest available check, or \`auto\` to let the linter choose.
- Use \`analyzeLibrary\` to inspect what blocks a library provides.

Tool usage efficiency:
- The environment section above already contains the project path, board, installed library list, and available readme_ai.md paths. Do NOT call any tool just to obtain this basic information.
- For web fetching: if a fetch/web fetch call in \`webview_bridge\` mode returns mostly page chrome, placeholders, or missing main body content from a JS-rendered site, automatically retry the same fetch with \`waitMs\` added or increased so the page has time to hydrate before extraction. Start with about 1000-3000ms and increase once if needed. Do not ask the user for confirmation before this retry.
- Do not re-fetch information you already obtained in a previous turn. Summarize key findings at the end of each response to preserve context across turns.`;

// ---------------------------------------------------------------------------
// Hardware Safety — blockly-specific safety rules
// ---------------------------------------------------------------------------

const BLOCKLY_PROJECT_WORKFLOW_SECTION: IPromptSection = {
  id: 'blockly-project-workflow',
  layer: PromptLayer.ToolInstructions,
  priority: 95,
  cacheable: true,
  tag: 'projectWorkflow',
  getContent: () => BLOCKLY_PROJECT_WORKFLOW_PROMPT,
};

const BLOCKLY_PROJECT_WORKFLOW_PROMPT = `Project planning and creation workflow:
- If the environment says "No project is currently open.", treat that as the authoritative state. Do not infer an active project, board, or installed libraries from arbitrary directories or search results.
- If the request is simple and does not require creating a project, answer directly or ask one concise clarification question.
- If no project is open and the request requires or implies creating a new Blockly project, follow this sequence before any creation/editing action, even for simple features such as LED blink:
  1. Call load_skill with action="load" and name="blockly-project-planning".
  2. Use hardware/library discovery tools to search for the required development board and library package names. Do not guess package names and do not ask the user to choose a board before this search.
  3. Select 2-3 viable board/library combinations when alternatives exist, or explain why only one combination is practical.
  4. Plan the architecture and workflow for each candidate: board, libraries, wiring/pins, ABS/workspace structure, validation, and safety notes.
  5. Present the options to the user and ask them to choose or confirm before creating the project.
- In Plan mode, stop at the option/architecture plan. Do not inspect arbitrary local project files for implementation details when no project is open, and do not create a project, install libraries, or edit workspace files.
- Do not ask "which development board do you want to use?" as the first response. First run the required skill and board/library discovery, then offer researched options.
- Ask the user to confirm the selected plan with ask_user before creating a project, installing libraries, or making workspace edits.
- After the user confirms creation, create or open the project, then continue using the new project path from the refreshed environment/context.`;

const BLOCKLY_ABS_EDITING_WORKFLOW_SECTION: IPromptSection = {
  id: 'blockly-abs-editing-workflow',
  layer: PromptLayer.HostDomain,
  priority: 85,
  cacheable: true,
  tag: 'absEditingWorkflow',
  getContent: () => BLOCKLY_ABS_EDITING_WORKFLOW_PROMPT,
};

const BLOCKLY_ABS_EDITING_WORKFLOW_PROMPT = `Blockly code-editing skill routing:
- Before implementing or modifying Blockly/ABS program code, call load_skill with action="load" and name="blockly-best-practices", then follow the loaded instructions before changing project artifacts.
- If no project is open, follow the project planning and creation workflow first.
- When the task involves non-trivial ABS syntax, block argument order, statement inputs, or library block usage, also load abs-syntax-reference before editing instead of guessing.
- Keep detailed editing, synchronization, and validation steps in the loaded skills rather than reconstructing the workflow from this routing section.`;

const BLOCKLY_HARDWARE_SAFETY_PROMPT = `When working with hardware:
- Always confirm before flashing firmware to a connected board.
- Warn users about potential pin conflicts (e.g., using a pin for both I2C and GPIO).
- Verify power supply requirements before recommending external components.
- Be cautious with motor drivers, high-power components, and battery circuits — incorrect wiring can damage hardware.
- When generating ABS blocks that control actuators, default to safe initial values (e.g., motors at 0 speed).`;
const BLOCKLY_HARDWARE_SAFETY_SECTION = createHardwareSafetySection('blockly-hardware-safety', BLOCKLY_HARDWARE_SAFETY_PROMPT);
const BLOCKLY_SKILL_COMMAND_SECTION = createSkillCommandSection('blockly-skill-command');
const BLOCKLY_SKILLS_LISTING_SECTION = createSkillsListingSection('blockly-skills-listing');

export interface BlocklyPromptContextProviderOptions {
  readonly getHost?: () => ReturnType<typeof AilyHost.get>;
  readonly contextSnapshotService?: BlocklyContextSnapshotService;
}

function createBlocklyPromptContextProvider(options: BlocklyPromptContextProviderOptions = {}): NonNullable<IPromptProfile['getContext']> {
  return async () => {
    const host = options.getHost?.() ?? AilyHost.get();
    const workspaceEnvironment = readChatRuntimeWorkspaceEnvironment();
    const promptProjectPath = workspaceEnvironment.projectPath;
    const contextSnapshotService = options.contextSnapshotService ?? getBlocklyContextSnapshotService();
    const envExtra = [...await contextSnapshotService.getSummary({
      scopes: BLOCKLY_MAIN_AGENT_REQUIRED_CONTEXT.scopes,
      reason: 'main-agent-prompt',
      summaryOptions: BLOCKLY_MAIN_AGENT_SUMMARY_OPTIONS,
    })];
    console.info('[AilyChat][PromptContext]', {
      profile: 'blockly',
      lineCount: envExtra.length,
      hasBoard: envExtra.some(line => line.startsWith('Current board:')),
      hasLibraries: envExtra.some(line => line.startsWith('Installed libraries')),
      projectLine: envExtra.find(line => line.startsWith('Project path:')) ?? null,
      boardLine: envExtra.find(line => line.startsWith('Current board:')) ?? null,
    });
    const fileContext = collectRuntimePromptFileContext(host, ['project.abs', '.temp/sketch/sketch.ino']);
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

export function createScopedBlocklyPromptProfile(
  options: BlocklyPromptContextProviderOptions = {},
): IPromptProfile {
  return {
    ...BLOCKLY_PROMPT_PROFILE,
    getContext: createBlocklyPromptContextProvider(options),
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const BLOCKLY_PROMPT_PROFILE: IPromptProfile = {
  hostId: 'blockly',
  requiredContext: BLOCKLY_MAIN_AGENT_REQUIRED_CONTEXT,
  sections: [
    BLOCKLY_IDENTITY_SECTION,
    BLOCKLY_DOMAIN_SECTION,
    BLOCKLY_PROJECT_WORKFLOW_SECTION,
    BLOCKLY_ABS_EDITING_WORKFLOW_SECTION,
    BLOCKLY_HARDWARE_SAFETY_SECTION,
    BLOCKLY_SKILL_COMMAND_SECTION,
    BLOCKLY_SKILLS_LISTING_SECTION,
  ],
  cacheBreakpoint: PromptLayer.HostDomain,
  getContext: createBlocklyPromptContextProvider(),
};
