import type { IPromptProfile, IPromptSection } from 'aily-lex/types/prompt';
import { PromptLayer } from 'aily-lex/types/prompt';
import { AilyHost } from './host';
import {
  appendStandardPromptEnv,
  collectRuntimePromptFileContext,
} from './runtime-prompt-shared';

export const UNBOUND_ROUTER_REQUIRED_CONTEXT = {
  scopes: ['workspaceIdentity', 'projectInfo', 'boardInfo'],
  strict: false,
  hydrateBeforeFirstModelCall: false,
} as const;

const UNBOUND_ROUTER_IDENTITY_SECTION: IPromptSection = {
  id: 'unbound-router-identity',
  layer: PromptLayer.Identity,
  priority: 200,
  cacheable: true,
  tag: 'agentIdentity',
  getContent: () => UNBOUND_ROUTER_IDENTITY_PROMPT,
};

const UNBOUND_ROUTER_IDENTITY_PROMPT = `You are Aily, the routing assistant inside a unified embedded IDE.
The IDE can work in coder mode for source-code projects or blockly mode for ABS/Blockly projects.
When the active project or user intent does not clearly select one runtime, analyze the request first and ask the user to confirm whether to continue in coder mode or blockly mode before writing code or using runtime-specific tools.`;

const UNBOUND_ROUTER_DOMAIN_SECTION: IPromptSection = {
  id: 'unbound-router-domain',
  layer: PromptLayer.HostDomain,
  priority: 100,
  cacheable: true,
  tag: 'domain',
  getContent: () => UNBOUND_ROUTER_DOMAIN_PROMPT,
};

const UNBOUND_ROUTER_DOMAIN_PROMPT = `Runtime routing rules:
- Use coder mode for normal source-code work, firmware architecture, compiler errors, source edits, and projects centered on files such as src/main.cpp.
- Use blockly mode for ABS/Blockly visual-programming projects, block generation, workspace synchronization, and tools that need project.abs or blockly workspace state.
- If the request can be answered without project-specific code changes, answer directly and state any runtime assumption.
- If the user asks to create or edit code and the runtime is ambiguous, ask a concise confirmation question instead of guessing.
- After the user confirms coder or blockly, call selectRuntimeMode with confirmed=true and a short reason. Do not claim the runtime has been selected unless that tool call succeeds.
- After selectRuntimeMode succeeds, reply briefly in the user's language: state the selected runtime mode, the one-line reason, and that you will continue in that mode.`;

export const UNBOUND_ROUTER_PROMPT_PROFILE: IPromptProfile = {
  hostId: 'unbound-router',
  requiredContext: UNBOUND_ROUTER_REQUIRED_CONTEXT,
  sections: [
    UNBOUND_ROUTER_IDENTITY_SECTION,
    UNBOUND_ROUTER_DOMAIN_SECTION,
  ],
  cacheBreakpoint: PromptLayer.HostDomain,
  getContext: async () => {
    const host = AilyHost.get();
    const projectPath = host.project?.currentProjectPath || host.project?.projectRootPath || '';
    const envExtra: string[] = [];

    if (projectPath) {
      envExtra.push(`Project path: ${projectPath}`);
      pushProjectMarker(envExtra, projectPath);
    } else {
      envExtra.push('Project path: none');
    }

    const fileContext = collectRuntimePromptFileContext(host, []);
    const platformType = appendStandardPromptEnv(envExtra, host, fileContext);

    return {
      platform: platformType,
      sessionDate: new Date().toLocaleDateString(),
      envExtra,
      activeFilePath: fileContext.activeFilePath,
      filePaths: fileContext.filePaths ?? [],
    };
  },
};

function pushProjectMarker(envExtra: string[], projectPath: string): void {
  const host = AilyHost.get();
  try {
    const absPath = host.path.join(projectPath, 'project.abs');
    envExtra.push(`project.abs: ${host.fs.existsSync(absPath) ? 'present' : 'missing'}`);
  } catch {
    envExtra.push('project.abs: unknown');
  }

  try {
    const mainCppPath = host.path.join(projectPath, 'src', 'main.cpp');
    envExtra.push(`src/main.cpp: ${host.fs.existsSync(mainCppPath) ? 'present' : 'missing'}`);
  } catch {
    envExtra.push('src/main.cpp: unknown');
  }
}
