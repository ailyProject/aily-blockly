import type { IPromptSection, PromptContext } from 'aily-lex/types/prompt';
import { PromptLayer } from 'aily-lex/types/prompt';
import { MAIN_AGENT_TYPE, normalizeAgentIdentifier } from './agent-identifiers';
import { AilyHost } from './host';
import { SkillRegistry } from './skill-registry';

export type PromptHost = ReturnType<typeof AilyHost.get>;

export function createHardwareSafetySection(
  id: string,
  content: string,
): IPromptSection {
  return {
    id,
    layer: PromptLayer.HostDomain,
    priority: 90,
    cacheable: true,
    tag: 'hardwareSafety',
    getContent: () => content,
  };
}

export function createSkillsListingSection(id: string): IPromptSection {
  return {
    id,
    layer: PromptLayer.SessionContext,
    priority: 50,
    cacheable: false,
    getContent: (ctx) => {
      const toolAwareCtx = ctx as PromptContext & { availableToolNames?: ReadonlySet<string> };
      const agentType = normalizeAgentIdentifier(ctx.agentId) || MAIN_AGENT_TYPE;
      const listing = SkillRegistry.getSkillsListing(agentType, {
        availableToolNames: toolAwareCtx.availableToolNames,
      });
      if (!listing) {
        return '';
      }
      return [
        listing,
        '<additional_skills_reminder>',
        'Always check whether any listed skill applies to the user request. When one applies, call load_skill with action="load" and its exact name before taking domain-specific action. Multiple skills may apply to one request; their tested instructions are required context, not optional suggestions.',
        '</additional_skills_reminder>',
      ].join('\n');
    },
  };
}

export function createSkillCommandSection(id: string): IPromptSection {
  return {
    id,
    layer: PromptLayer.ToolInstructions,
    priority: 55,
    cacheable: false,
    getContent: (ctx) => {
      const requestedSkillNames = Array.isArray((ctx as PromptContext & { requestedSkillNames?: readonly string[] }).requestedSkillNames)
        ? ((ctx as PromptContext & { requestedSkillNames?: readonly string[] }).requestedSkillNames ?? [])
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
          .map(name => name.trim())
        : [];
      const commandName = ctx.command?.name?.trim();
      const targetSkillNames = requestedSkillNames.length > 0
        ? requestedSkillNames
        : (commandName ? [commandName] : []);

      if (targetSkillNames.length === 0) {
        return '';
      }

      const sections = targetSkillNames
        .map(name => buildRequestedSkillSection(name, requestedSkillNames.length > 0))
        .filter((section): section is string => section.length > 0);

      return sections.join('\n\n');
    },
  };
}

function buildRequestedSkillSection(name: string, fromRequestedSkillNames: boolean): string {
  const skillContext = SkillRegistry.getSkillContext(name);
  if (!skillContext || (!fromRequestedSkillNames && skillContext.userInvocable === false)) {
    return '';
  }

  const intro = fromRequestedSkillNames
    ? `The current request explicitly requested the ${skillContext.name} skill for this turn.`
    : `The current request explicitly selected the /${skillContext.name} skill command.`;

  if (skillContext.mode === 'fork') {
    return [
      intro,
      `Call load_skill with action="load", name="${skillContext.name}", and task set to the current user request so the skill runs as a forked subagent.`,
      `Skill file: ${skillContext.skillMdPath}`,
    ].join('\n');
  }

  const relatedFiles = skillContext.relatedFiles ?? [];
  const relatedFilesSection = relatedFiles.length > 0
    ? [
      'Related files (use read_file to inspect only what you need):',
      ...relatedFiles.map(file => `- ${file.path}${file.category ? ` (${file.category})` : ''}`),
    ]
    : [];

  return [
    intro,
    'Treat this skill as request-scoped context for the current turn. Do not assume it should remain active in future turns unless explicitly loaded again.',
    `<skill-context name="${skillContext.name}" mode="inline">`,
    `Description: ${skillContext.description || 'No description provided.'}`,
    `Skill file: ${skillContext.skillMdPath}`,
    ...(skillContext.baseDir ? [`Base directory: ${skillContext.baseDir}`] : []),
    ...relatedFilesSection,
    '',
    'Instructions:',
    skillContext.body,
    '</skill-context>',
  ].join('\n');
}

export function collectRuntimePromptFileContext(
  host: PromptHost,
  defaultProjectPaths: readonly string[],
): Pick<PromptContext, 'activeFilePath' | 'filePaths'> {
  const filePaths: string[] = [];
  const activeFilePath = normalizePromptFilePath(host.editor?.getCurrentFilePath?.());
  if (activeFilePath) {
    filePaths.push(activeFilePath);
  }

  const projectPath = host.project?.currentProjectPath;
  if (projectPath) {
    for (const relativePath of defaultProjectPaths) {
      filePaths.push(normalizePromptFilePath(host.path.join(projectPath, ...relativePath.split('/'))));
    }
  }

  const normalizedFilePaths = [...new Set(filePaths.filter((path): path is string => Boolean(path)))];
  return {
    activeFilePath,
    filePaths: normalizedFilePaths.length > 0 ? normalizedFilePaths : undefined,
  };
}

export function appendStandardPromptEnv(
  envExtra: string[],
  host: PromptHost,
  fileContext: Pick<PromptContext, 'activeFilePath'>,
): string {
  const platformType = host.platform?.type || 'unknown';
  if (platformType === 'win32' || (host.platform as any)?.isWindows) {
    envExtra.push('Shell: PowerShell - use semicolons (;) to chain commands, NOT && or ||');
  }

  const locale = host.config?.locale;
  if (locale) {
    envExtra.push(`Locale: ${locale}`);
  }

  if (fileContext.activeFilePath) {
    envExtra.push(`Active file: ${fileContext.activeFilePath}`);
  }

  return platformType;
}

export function normalizePromptFilePath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().replace(/\\/g, '/')
    : undefined;
}
