import { parseAgentDefinition, type AgentSource, type IAgentContribution, type IHostAgentFileProvider, type IHostAgentProvider } from 'aily-lex/browser';

import { BLOCKLY_HOST_AGENT_URI_SCHEME, createBlocklyHostAgentUri } from './blockly-agent-provider';
import {
  BLOCKLY_HOST_HOOK_URI_SCHEME,
  type BlocklyHookCustomizationProvider,
} from './blockly-hook-customization-provider';
import type { BlocklyInstructionFileProvider } from './blockly-instruction-file-provider';
import {
  BLOCKLY_HOST_PLUGIN_URI_SCHEME,
  type BlocklyPluginCustomizationProvider,
} from './blockly-plugin-customization-provider';
import type { BlocklySkillCustomizationProvider } from './blockly-skill-customization-provider';

type SessionCustomizationChangeSubscription =
  | { dispose?: () => void; unsubscribe?: () => void }
  | (() => void)
  | void;

export type BlocklySessionCustomizationType = 'agent' | 'instructions' | 'skill' | 'hook' | 'plugins';

export interface BlocklySessionCustomizationProviderMetadata {
  readonly label: string;
  readonly iconId?: string;
  readonly supportedTypes?: readonly BlocklySessionCustomizationType[];
}

export const BLOCKLY_SESSION_CUSTOMIZATION_PROVIDER_METADATA: BlocklySessionCustomizationProviderMetadata = {
  label: 'Aily Blockly',
  supportedTypes: ['agent', 'instructions', 'skill', 'hook', 'plugins'],
};

export const BLOCKLY_SESSION_CUSTOMIZATION_PROVIDER_METADATA_BY_SESSION_TYPE: Readonly<Record<string, BlocklySessionCustomizationProviderMetadata>> = {
  local: BLOCKLY_SESSION_CUSTOMIZATION_PROVIDER_METADATA,
  'aily-agent': {
    label: 'Aily Agent',
    iconId: 'aily',
    supportedTypes: ['agent', 'instructions', 'skill', 'hook', 'plugins'],
  },
};

export const BLOCKLY_SESSION_CUSTOMIZATION_PROVIDER_SESSION_TYPE = 'local';
export const BLOCKLY_SESSION_CUSTOMIZATION_PROVIDER_SESSION_TYPES = [
  'local',
  'aily-agent',
] as const;

export interface BlocklySessionCustomizationItem {
  readonly type: BlocklySessionCustomizationType;
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly sessionTypes?: readonly string[];
  readonly groupKey?: string;
  readonly badge?: string;
  readonly badgeTooltip?: string;
  readonly source?: AgentSource | 'url';
}

export interface BlocklySessionCustomizationItemProvider {
  provideChatSessionCustomizations(): readonly BlocklySessionCustomizationItem[];
  onDidChange?: (listener: () => void) => SessionCustomizationChangeSubscription;
}

export interface BlocklySessionCustomizationProviderBinding {
  readonly sessionType?: string;
  readonly metadata: BlocklySessionCustomizationProviderMetadata;
  readonly itemProvider: BlocklySessionCustomizationItemProvider;
}

export interface BlocklySessionCustomizationItemProviderSource {
  readonly source: AgentSource;
  readonly provider: IHostAgentFileProvider;
}

export interface BlocklySessionCustomizationRuntimeAgentProviderSource {
  readonly source: AgentSource;
  readonly provider: IHostAgentProvider;
}

export interface BlocklySessionCustomizationInstructionProviderSource {
  readonly source: AgentSource;
  readonly provider: BlocklyInstructionFileProvider;
}

export interface BlocklySessionCustomizationSkillProviderSource {
  readonly provider: BlocklySkillCustomizationProvider;
}

export interface BlocklySessionCustomizationHookProviderSource {
  readonly provider: BlocklyHookCustomizationProvider;
}

export interface BlocklySessionCustomizationPluginProviderSource {
  readonly provider: BlocklyPluginCustomizationProvider;
}

export interface BlocklySessionCustomizationContentProvider {
  provideTextDocumentContent(uri: string): Promise<string | undefined> | string | undefined;
}

export interface BlocklySessionCustomizationItemProviderOptions {
  readonly sessionType?: string;
}

type ParsedInstructionCustomizationMetadata = {
  readonly name?: string;
  readonly description?: string;
  readonly applyTo?: readonly string[];
};

export function createBlocklySessionCustomizationItemProvider(
  sources: readonly BlocklySessionCustomizationItemProviderSource[],
  runtimeAgentSources: readonly BlocklySessionCustomizationRuntimeAgentProviderSource[] = [],
  instructionSources: readonly BlocklySessionCustomizationInstructionProviderSource[] = [],
  skillSources: readonly BlocklySessionCustomizationSkillProviderSource[] = [],
  hookSources: readonly BlocklySessionCustomizationHookProviderSource[] = [],
  pluginSources: readonly BlocklySessionCustomizationPluginProviderSource[] = [],
  options: BlocklySessionCustomizationItemProviderOptions = {},
): BlocklySessionCustomizationItemProvider {
  const sessionType = normalizeSessionCustomizationSessionType(options.sessionType);
  const activeSources = sources.filter((entry): entry is BlocklySessionCustomizationItemProviderSource => {
    return !!entry?.provider && typeof entry.provider.contributeAgentFiles === 'function';
  });
  const activeRuntimeAgentSources = runtimeAgentSources.filter((entry): entry is BlocklySessionCustomizationRuntimeAgentProviderSource => {
    return !!entry?.provider && typeof entry.provider.contributeAgents === 'function';
  });
  const activeInstructionSources = instructionSources.filter((entry): entry is BlocklySessionCustomizationInstructionProviderSource => {
    return !!entry?.provider && typeof entry.provider.contributeInstructionFiles === 'function';
  });
  const activeSkillSources = skillSources.filter((entry): entry is BlocklySessionCustomizationSkillProviderSource => {
    return !!entry?.provider && typeof entry.provider.contributeSkills === 'function';
  });
  const activeHookSources = hookSources.filter((entry): entry is BlocklySessionCustomizationHookProviderSource => {
    return !!entry?.provider && typeof entry.provider.contributeHooks === 'function';
  });
  const activePluginSources = pluginSources.filter((entry): entry is BlocklySessionCustomizationPluginProviderSource => {
    return !!entry?.provider && typeof entry.provider.contributePlugins === 'function';
  });

  return {
    provideChatSessionCustomizations(): readonly BlocklySessionCustomizationItem[] {
      const seenUris = new Set<string>();
      const items: BlocklySessionCustomizationItem[] = [];

      for (const entry of activeRuntimeAgentSources) {
        for (const contribution of entry.provider.contributeAgents()) {
          const uri = normalizeRuntimeAgentContributionUri(contribution);
          if (!uri || seenUris.has(uri)) {
            continue;
          }

          seenUris.add(uri);
          items.push({
            type: 'agent',
            uri,
            name: contribution.name,
            source: entry.source,
          });
        }
      }

      for (const entry of activeSources) {
        for (const file of entry.provider.contributeAgentFiles()) {
          const uri = typeof file.uri === 'string' ? file.uri.trim() : '';
          if (!uri || seenUris.has(uri)) {
            continue;
          }

          const item = buildAgentFileCustomizationItem(file, entry.source, sessionType);
          if (!item) {
            continue;
          }

          seenUris.add(uri);
          items.push(item);
        }
      }

      for (const entry of activeInstructionSources) {
        for (const file of entry.provider.contributeInstructionFiles()) {
          const uri = typeof file.uri === 'string' ? file.uri.trim() : '';
          if (!uri || seenUris.has(uri)) {
            continue;
          }

          seenUris.add(uri);
          items.push(buildInstructionFileCustomizationItem(file, entry.source, sessionType));
        }
      }

      for (const entry of activeSkillSources) {
        for (const skill of entry.provider.contributeSkills()) {
          const item = buildSkillCustomizationItem(skill, sessionType);
          if (!item || seenUris.has(item.uri)) {
            continue;
          }

          seenUris.add(item.uri);
          items.push(item);
        }
      }

      for (const entry of activeHookSources) {
        for (const hook of entry.provider.contributeHooks()) {
          const uri = typeof hook.uri === 'string' ? hook.uri.trim() : '';
          if (!uri || seenUris.has(uri)) {
            continue;
          }

          seenUris.add(uri);
          items.push({
            type: 'hook',
            uri,
            name: hook.name,
            description: hook.description,
            source: hook.source,
          });
        }
      }

      for (const entry of activePluginSources) {
        for (const plugin of entry.provider.contributePlugins()) {
          const uri = typeof plugin.uri === 'string' ? plugin.uri.trim() : '';
          if (!uri || seenUris.has(uri)) {
            continue;
          }

          seenUris.add(uri);
          items.push({
            type: 'plugins',
            uri,
            name: plugin.name,
            description: plugin.description,
            source: plugin.source,
          });
        }
      }

      return items;
    },
    ...((
      activeSources.some(entry => typeof entry.provider.onAgentFilesChanged === 'function')
      || activeRuntimeAgentSources.some(entry => typeof entry.provider.onAgentsChanged === 'function')
      || activeInstructionSources.some(entry => typeof entry.provider.onInstructionFilesChanged === 'function')
      || activeSkillSources.some(entry => typeof entry.provider.onSkillsChanged === 'function')
      || activeHookSources.some(entry => typeof entry.provider.onHooksChanged === 'function')
      || activePluginSources.some(entry => typeof entry.provider.onPluginsChanged === 'function')
    ) ? {
      onDidChange(listener: () => void): SessionCustomizationChangeSubscription {
        const subscriptions: SessionCustomizationChangeSubscription[] = [];
        for (const entry of activeSources) {
          const subscription = entry.provider.onAgentFilesChanged?.(() => listener());
          if (subscription) {
            subscriptions.push(subscription);
          }
        }
        for (const entry of activeRuntimeAgentSources) {
          const subscription = entry.provider.onAgentsChanged?.(() => listener());
          if (subscription) {
            subscriptions.push(subscription);
          }
        }
        for (const entry of activeInstructionSources) {
          const subscription = entry.provider.onInstructionFilesChanged?.(() => listener());
          if (subscription) {
            subscriptions.push(subscription);
          }
        }
        for (const entry of activeSkillSources) {
          const subscription = entry.provider.onSkillsChanged?.(() => listener());
          if (subscription) {
            subscriptions.push(subscription);
          }
        }
        for (const entry of activeHookSources) {
          const subscription = entry.provider.onHooksChanged?.(() => listener());
          if (subscription) {
            subscriptions.push(subscription);
          }
        }
        for (const entry of activePluginSources) {
          const subscription = entry.provider.onPluginsChanged?.(() => listener());
          if (subscription) {
            subscriptions.push(subscription);
          }
        }

        return {
          dispose() {
            for (const subscription of subscriptions) {
              disposeSessionCustomizationChangeSubscription(subscription);
            }
          },
        };
      },
    } : {}),
  };
}

export function createBlocklySessionCustomizationProviderBinding(
  sources: readonly BlocklySessionCustomizationItemProviderSource[],
  runtimeAgentSources: readonly BlocklySessionCustomizationRuntimeAgentProviderSource[] = [],
  instructionSources: readonly BlocklySessionCustomizationInstructionProviderSource[] = [],
  skillSources: readonly BlocklySessionCustomizationSkillProviderSource[] = [],
  hookSources: readonly BlocklySessionCustomizationHookProviderSource[] = [],
  pluginSources: readonly BlocklySessionCustomizationPluginProviderSource[] = [],
  sessionType: string = BLOCKLY_SESSION_CUSTOMIZATION_PROVIDER_SESSION_TYPE,
): BlocklySessionCustomizationProviderBinding {
  const normalizedSessionType = normalizeSessionCustomizationSessionType(sessionType);
  return {
    sessionType: normalizedSessionType,
    metadata: getBlocklySessionCustomizationProviderMetadata(normalizedSessionType),
    itemProvider: createBlocklySessionCustomizationItemProvider(
      sources,
      runtimeAgentSources,
      instructionSources,
      skillSources,
      hookSources,
      pluginSources,
      { sessionType: normalizedSessionType },
    ),
  };
}

export function createBlocklySessionCustomizationProviderBindings(
  sources: readonly BlocklySessionCustomizationItemProviderSource[],
  runtimeAgentSources: readonly BlocklySessionCustomizationRuntimeAgentProviderSource[] = [],
  instructionSources: readonly BlocklySessionCustomizationInstructionProviderSource[] = [],
  skillSources: readonly BlocklySessionCustomizationSkillProviderSource[] = [],
  hookSources: readonly BlocklySessionCustomizationHookProviderSource[] = [],
  pluginSources: readonly BlocklySessionCustomizationPluginProviderSource[] = [],
  sessionTypes: readonly string[] = BLOCKLY_SESSION_CUSTOMIZATION_PROVIDER_SESSION_TYPES,
): readonly BlocklySessionCustomizationProviderBinding[] {
  return Array.from(new Set(sessionTypes
    .filter((sessionType): sessionType is string => typeof sessionType === 'string')
    .map(sessionType => sessionType.trim())
    .filter(sessionType => sessionType.length > 0)))
    .map((sessionType) => createBlocklySessionCustomizationProviderBinding(
      sources,
      runtimeAgentSources,
      instructionSources,
      skillSources,
      hookSources,
      pluginSources,
      sessionType,
    ));
}

function normalizeSessionCustomizationSessionType(sessionType: string | undefined): string {
  return typeof sessionType === 'string' && sessionType.trim().length > 0
    ? sessionType.trim()
    : BLOCKLY_SESSION_CUSTOMIZATION_PROVIDER_SESSION_TYPE;
}

function getBlocklySessionCustomizationProviderMetadata(sessionType: string): BlocklySessionCustomizationProviderMetadata {
  return BLOCKLY_SESSION_CUSTOMIZATION_PROVIDER_METADATA_BY_SESSION_TYPE[sessionType]
    ?? BLOCKLY_SESSION_CUSTOMIZATION_PROVIDER_METADATA;
}

export function createBlocklySessionCustomizationContentProvider(
  runtimeAgentSources: readonly BlocklySessionCustomizationRuntimeAgentProviderSource[],
  hookSources: readonly BlocklySessionCustomizationHookProviderSource[] = [],
  pluginSources: readonly BlocklySessionCustomizationPluginProviderSource[] = [],
): BlocklySessionCustomizationContentProvider {
  const activeRuntimeAgentSources = runtimeAgentSources.filter((entry): entry is BlocklySessionCustomizationRuntimeAgentProviderSource => {
    return !!entry?.provider && typeof entry.provider.contributeAgents === 'function';
  });
  const activeHookSources = hookSources.filter((entry): entry is BlocklySessionCustomizationHookProviderSource => {
    return !!entry?.provider && typeof entry.provider.contributeHooks === 'function';
  });
  const activePluginSources = pluginSources.filter((entry): entry is BlocklySessionCustomizationPluginProviderSource => {
    return !!entry?.provider && typeof entry.provider.contributePlugins === 'function';
  });

  return {
    provideTextDocumentContent(uri: string): string | undefined {
      const normalizedUri = typeof uri === 'string' ? uri.trim() : '';
      if (!normalizedUri) {
        return undefined;
      }

      for (const entry of activeRuntimeAgentSources) {
        for (const contribution of entry.provider.contributeAgents()) {
          if (normalizeRuntimeAgentContributionUri(contribution) !== normalizedUri) {
            continue;
          }

          return serializeRuntimeAgentContribution(contribution);
        }
      }

      for (const entry of activeHookSources) {
        for (const contribution of entry.provider.contributeHooks()) {
          if (contribution.uri.trim() !== normalizedUri || typeof contribution.content !== 'string') {
            continue;
          }

          return contribution.content;
        }
      }

      for (const entry of activePluginSources) {
        for (const contribution of entry.provider.contributePlugins()) {
          if (typeof contribution.content !== 'string' || contribution.uri.trim() !== normalizedUri) {
            continue;
          }

          return contribution.content;
        }
      }

      return undefined;
    },
  };
}

export function getBlocklySessionCustomizationContentProviderSchemes(): readonly string[] {
  return [BLOCKLY_HOST_AGENT_URI_SCHEME, BLOCKLY_HOST_HOOK_URI_SCHEME, BLOCKLY_HOST_PLUGIN_URI_SCHEME];
}

function normalizeRuntimeAgentContributionUri(contribution: IAgentContribution): string {
  const rawUri = typeof contribution.uri === 'string' ? contribution.uri.trim() : '';
  if (rawUri) {
    return rawUri;
  }

  return createBlocklyHostAgentUri(contribution.agentType);
}

function normalizeSkillContributionUri(skillPath: string): string {
  const normalized = normalizeFilesystemPath(skillPath);
  if (!normalized) {
    return '';
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(normalized)) {
    return normalized;
  }

  const encoded = encodeURI(normalized);
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encoded}`;
  }
  if (normalized.startsWith('//')) {
    return `file:${encoded}`;
  }

  return normalized.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

function mapSkillOriginToCustomizationSource(originType: 'builtin' | 'project' | 'user' | 'hub' | 'url'): AgentSource | 'url' {
  switch (originType) {
    case 'builtin':
      return 'built-in';
    case 'user':
      return 'user';
    case 'project':
      return 'project';
    case 'hub':
      return 'plugin';
    case 'url':
      return 'url';
  }

  return 'host';
}

function normalizeFilesystemPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
}

function buildAgentFileCustomizationItem(
  file: { readonly name: string; readonly content: string; readonly uri?: string },
  source: AgentSource,
  sessionType: string,
): BlocklySessionCustomizationItem | undefined {
  const uri = typeof file.uri === 'string' ? file.uri.trim() : '';
  const parsed = parseAgentDefinition(file.content, source, uri ? { name: file.name, uri } : { name: file.name });
  const sessionTypes = parseAgentCustomizationSessionTypes(file.content);
  if (!shouldIncludeAgentCustomizationUri(uri, sessionTypes, sessionType)) {
    return undefined;
  }

  const name = normalizeCustomizationString(parsed?.name) ?? file.name;
  const description = normalizeCustomizationString(parsed?.whenToUse);

  return {
    type: 'agent',
    uri,
    name,
    ...(description ? { description } : {}),
    ...(Array.isArray(sessionTypes) && sessionTypes.length > 0 ? { sessionTypes: [...sessionTypes] } : {}),
    source,
  };
}

function buildInstructionFileCustomizationItem(
  file: { readonly name: string; readonly content: string; readonly uri: string },
  source: AgentSource,
  sessionType: string,
): BlocklySessionCustomizationItem {
  const metadata = parseInstructionCustomizationMetadata(file.content);
  const name = metadata.name ?? file.name;
  const isAgentInstruction = isAgentInstructionCustomizationFile(file);
  const groupKey = isAgentInstruction
    ? 'agent-instructions'
    : metadata.applyTo && metadata.applyTo.length > 0
      ? 'context-instructions'
      : 'on-demand-instructions';
  const presentation = buildInstructionPresentation(metadata.applyTo);

  return {
    type: 'instructions',
    uri: file.uri.trim(),
    name,
    ...(!isAgentInstruction && metadata.description ? { description: metadata.description } : {}),
    groupKey,
    ...(!isAgentInstruction && presentation.badge ? { badge: presentation.badge } : {}),
    ...(!isAgentInstruction && presentation.badgeTooltip ? { badgeTooltip: presentation.badgeTooltip } : {}),
    source,
  };
}

function buildSkillCustomizationItem(
  skill: { readonly skillMdPath: string; readonly metadata: { readonly name: string; readonly description?: string }; readonly origin: { readonly type: 'builtin' | 'project' | 'user' | 'hub' | 'url' } },
  sessionType: string,
): BlocklySessionCustomizationItem | undefined {
  const uri = normalizeSkillContributionUri(skill.skillMdPath);
  if (!uri || !shouldIncludeSkillCustomizationUri(uri, sessionType)) {
    return undefined;
  }

  return {
    type: 'skill',
    uri,
    name: skill.metadata.name,
    description: skill.metadata.description,
    source: mapSkillOriginToCustomizationSource(skill.origin.type),
  };
}

function shouldIncludeAgentCustomizationUri(
  uri: string,
  sessionTypes: readonly string[] | undefined,
  sessionType: string,
): boolean {
  if (!uri) {
    return false;
  }

  if (Array.isArray(sessionTypes) && sessionTypes.length > 0 && !sessionTypes.includes(sessionType)) {
    return false;
  }

  return true;
}

function shouldIncludeSkillCustomizationUri(uri: string, sessionType: string): boolean {
  if (!uri) {
    return false;
  }

  return true;
}

function stripMarkdownExtension(value: string): string {
  return value.replace(/\.md$/i, '');
}

function parseAgentCustomizationSessionTypes(content: string): readonly string[] | undefined {
  return normalizeStringArrayValue(parseSimpleFrontmatter(content)['sessionTypes']);
}

function isAgentInstructionCustomizationFile(
  file: { readonly name: string; readonly uri: string },
): boolean {
  const normalizedName = file.name.trim().toLowerCase();
  if (normalizedName === 'agents.md' || normalizedName === 'aily.md') {
    return true;
  }

  return file.uri.trim().replace(/\\/g, '/').toLowerCase().endsWith('/.aily/aily-instructions.md');
}

function buildInstructionPresentation(
  applyTo: readonly string[] | undefined,
): { badge?: string; badgeTooltip?: string } {
  if (!applyTo || applyTo.length === 0) {
    return {};
  }

  if (applyTo.length === 1) {
    const pattern = applyTo[0];
    if (pattern === '**') {
      return {
        badge: 'always added',
        badgeTooltip: 'This instruction is automatically included in every interaction.',
      };
    }

    return {
      badge: pattern,
      badgeTooltip: `This instruction is automatically included when files matching '${pattern}' are in context.`,
    };
  }

  return {
    badge: `${applyTo.length} contexts`,
    badgeTooltip: `This instruction is automatically included when any configured activation rule matches: ${applyTo.join(', ')}.`,
  };
}

function parseInstructionCustomizationMetadata(content: string): ParsedInstructionCustomizationMetadata {
  const frontmatter = parseSimpleFrontmatter(content);
  const name = normalizeCustomizationString(frontmatter['name']);
  const description = normalizeCustomizationString(frontmatter['description']);
  const applyTo = normalizeStringArrayValue(frontmatter['applyTo']);

  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(applyTo && applyTo.length > 0 ? { applyTo } : {}),
  };
}

function parseSimpleFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const delimiterIndex = line.indexOf(':');
    if (delimiterIndex <= 0) {
      continue;
    }

    const key = line.slice(0, delimiterIndex).trim();
    const rawValue = line.slice(delimiterIndex + 1).trim();
    if (!key) {
      continue;
    }

    result[key] = parseSimpleFrontmatterValue(rawValue);
  }

  return result;
}

function parseSimpleFrontmatterValue(rawValue: string): unknown {
  if (!rawValue) {
    return '';
  }

  if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))) {
    return rawValue.slice(1, -1);
  }

  if (rawValue === 'true') {
    return true;
  }
  if (rawValue === 'false') {
    return false;
  }

  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    const entries = rawValue.slice(1, -1).trim();
    if (!entries) {
      return [];
    }

    return entries
      .split(',')
      .map((entry) => normalizeCustomizationString(parseSimpleFrontmatterValue(entry.trim())))
      .filter((entry): entry is string => !!entry);
  }

  return rawValue;
}

function normalizeStringArrayValue(value: unknown): readonly string[] | undefined {
  if (typeof value === 'string') {
    const normalized = normalizeCustomizationString(value);
    return normalized ? [normalized] : undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map(entry => normalizeCustomizationString(entry))
    .filter((entry): entry is string => !!entry);
  return items.length > 0 ? items : undefined;
}

function normalizeCustomizationString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function serializeRuntimeAgentContribution(contribution: IAgentContribution): string {
  const body = typeof contribution.modeInstructions?.content === 'string'
    ? contribution.modeInstructions.content.trim()
    : typeof contribution.systemPrompt === 'string'
      ? contribution.systemPrompt.trim()
      : '';

  const frontmatterEntries: Array<readonly [string, unknown]> = [
    ['name', contribution.name],
    ['description', contribution.description ?? contribution.whenToUse],
    ['argument-hint', contribution.argumentHint ?? `Describe the task for ${contribution.name}`],
  ];

  if (contribution.target) {
    frontmatterEntries.push(['target', contribution.target]);
  }
  if (contribution.visibility?.agentInvocable === false) {
    frontmatterEntries.push(['disable-model-invocation', true]);
  }
  if (contribution.visibility?.userInvocable === false) {
    frontmatterEntries.push(['user-invocable', false]);
  }
  if (contribution.tools) {
    frontmatterEntries.push(['tools', contribution.tools]);
  }
  const ailyEntries: [string, unknown][] = [];
  if (contribution.excludeTools) {
    ailyEntries.push(['disallowedTools', contribution.excludeTools]);
  }
  if (contribution.disallowedPromptPatterns) {
    ailyEntries.push(['disallowedPromptPatterns', contribution.disallowedPromptPatterns]);
  }
  if (contribution.agents) {
    frontmatterEntries.push(['agents', contribution.agents]);
  }
  if (contribution.handoffs && contribution.handoffs.length > 0) {
    frontmatterEntries.push(['handoffs', contribution.handoffs]);
  }
  if (typeof contribution.maxTurns === 'number') {
    ailyEntries.push(['maxTurns', contribution.maxTurns]);
  }
  if (contribution.model) {
    frontmatterEntries.push(['model', contribution.model]);
  }
  if (contribution.messageInheritance) {
    ailyEntries.push(['messageInheritance', contribution.messageInheritance]);
  }
  if (ailyEntries.length > 0) {
    frontmatterEntries.push(['aily', Object.fromEntries(ailyEntries)]);
  }

  const header = frontmatterEntries
    .map(([key, value]) => `${key}: ${serializeYamlInlineValue(value)}`)
    .join('\n');

  return ['---', header, '---', body].join('\n');
}

function serializeYamlInlineValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(entry => serializeYamlInlineValue(entry)).join(', ')}]`;
  }

  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }

  return JSON.stringify(value);
}

function disposeSessionCustomizationChangeSubscription(
  subscription: SessionCustomizationChangeSubscription,
): void {
  if (!subscription) {
    return;
  }

  if (typeof subscription === 'function') {
    subscription();
    return;
  }

  if (typeof subscription.unsubscribe === 'function') {
    subscription.unsubscribe();
    return;
  }

  subscription.dispose?.();
}
