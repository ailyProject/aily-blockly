import type { AgentSource } from 'aily-lex/browser';
import { AilyHost } from './host';

export const BLOCKLY_HOST_PLUGIN_URI_SCHEME = 'aily-chat-plugin';

type PluginChangeSubscription =
  | { dispose?: () => void; unsubscribe?: () => void }
  | (() => void)
  | void;

interface PluginCapabilitySetLike {
  readonly instructions?: readonly string[];
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly agents?: readonly string[];
  readonly slashCommands?: readonly string[];
  readonly hooks?: readonly string[];
  readonly mcp?: readonly string[];
}

interface PluginSourceLike {
  readonly kind: 'builtin' | 'file' | 'package';
  readonly location?: string;
}

interface PluginAuditRecordLike {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly source: PluginSourceLike;
  readonly declaredCapabilities: PluginCapabilitySetLike;
  readonly resolvedCapabilities: PluginCapabilitySetLike;
  readonly isApplied: boolean;
}

export interface BlocklyPluginCustomizationContribution {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly source?: AgentSource;
  readonly content?: string;
}

export interface BlocklyPluginCustomizationAgent {
  getPluginAuditRecords(): readonly PluginAuditRecordLike[];
  onPluginsChanged?(listener: () => void): PluginChangeSubscription;
}

export interface BlocklyPluginCustomizationProvider {
  contributePlugins(): readonly BlocklyPluginCustomizationContribution[];
  onPluginsChanged?(listener: () => void): PluginChangeSubscription;
}

export function createBlocklyPluginCustomizationProvider(
  options: { readonly getAgent: () => BlocklyPluginCustomizationAgent | null | undefined },
): BlocklyPluginCustomizationProvider {
  return {
    contributePlugins(): readonly BlocklyPluginCustomizationContribution[] {
      const agent = options.getAgent();
      if (!agent || typeof agent.getPluginAuditRecords !== 'function') {
        return [];
      }

      return agent.getPluginAuditRecords()
        .map(toPluginCustomizationContribution)
        .filter((contribution): contribution is BlocklyPluginCustomizationContribution => !!contribution);
    },
    onPluginsChanged(listener: () => void): PluginChangeSubscription {
      return options.getAgent()?.onPluginsChanged?.(listener);
    },
  };
}

export function createBlocklyHostPluginUri(pluginName: string): string {
  const normalizedName = typeof pluginName === 'string' ? pluginName.trim() : '';
  const encodedName = encodeURIComponent(normalizedName || 'unknown');
  return `${BLOCKLY_HOST_PLUGIN_URI_SCHEME}:/plugins/${encodedName}.plugin.md`;
}

function toPluginCustomizationContribution(
  record: PluginAuditRecordLike,
): BlocklyPluginCustomizationContribution | undefined {
  const { uri, fileBacked } = resolvePluginCustomizationUri(record);
  if (!uri) {
    return undefined;
  }

  return {
    uri,
    name: record.name,
    description: record.description,
    source: resolvePluginCustomizationSource(record),
    ...(fileBacked ? {} : { content: serializePluginAuditRecord(record) }),
  };
}

function resolvePluginCustomizationSource(record: PluginAuditRecordLike): AgentSource | undefined {
  switch (record.source.kind) {
    case 'builtin':
      return 'built-in';
    case 'package':
      return 'plugin';
    case 'file':
      return classifyFileBackedPluginSource(record.source.location);
    default:
      return undefined;
  }
}

function classifyFileBackedPluginSource(location: string | undefined): AgentSource | undefined {
  const filePath = resolveFilesystemLocation(location);
  if (!filePath) {
    return undefined;
  }

  const host = AilyHost.get();
  const normalizedFilePath = normalizeFilesystemLocation(filePath);
  const projectRoot = normalizeFilesystemLocation(host.project?.projectRootPath ?? host.project?.currentProjectPath ?? '');
  const userHome = normalizeFilesystemLocation(host.path?.getUserHome?.() ?? host.platform?.homedir?.() ?? '');

  if (projectRoot && isEqualOrParentPath(normalizedFilePath, projectRoot)) {
    return 'project';
  }

  if (userHome && isEqualOrParentPath(normalizedFilePath, userHome)) {
    return 'user';
  }

  return undefined;
}

function resolvePluginCustomizationUri(
  record: PluginAuditRecordLike,
): { readonly uri: string; readonly fileBacked: boolean } {
  const location = normalizeLocation(record.source.location);
  if (location) {
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(location)) {
      return { uri: location, fileBacked: location.startsWith('file://') };
    }

    if (looksLikeFilesystemPath(location)) {
      return { uri: toFileUri(location), fileBacked: true };
    }
  }

  return {
    uri: createBlocklyHostPluginUri(record.name),
    fileBacked: false,
  };
}

function serializePluginAuditRecord(record: PluginAuditRecordLike): string {
  const frontmatterEntries: Array<readonly [string, unknown]> = [
    ['name', record.name],
  ];

  if (record.version) {
    frontmatterEntries.push(['version', record.version]);
  }
  if (record.description) {
    frontmatterEntries.push(['description', record.description]);
  }

  pushCapabilityFrontmatter(frontmatterEntries, 'instructions', record.declaredCapabilities.instructions);
  pushCapabilityFrontmatter(frontmatterEntries, 'tools', record.declaredCapabilities.tools);
  pushCapabilityFrontmatter(frontmatterEntries, 'skills', record.declaredCapabilities.skills);
  pushCapabilityFrontmatter(frontmatterEntries, 'agents', record.declaredCapabilities.agents);
  pushCapabilityFrontmatter(frontmatterEntries, 'slashCommands', record.declaredCapabilities.slashCommands);
  pushCapabilityFrontmatter(frontmatterEntries, 'hooks', record.declaredCapabilities.hooks);
  pushCapabilityFrontmatter(frontmatterEntries, 'mcp', record.declaredCapabilities.mcp);

  const header = frontmatterEntries
    .map(([key, value]) => `${key}: ${serializeYamlInlineValue(value)}`)
    .join('\n');

  const body = [
    '# Plugin Audit Snapshot',
    '',
    `- sourceKind: ${record.source.kind}`,
    ...(record.source.location ? [`- sourceLocation: ${record.source.location}`] : []),
    `- applied: ${record.isApplied ? 'true' : 'false'}`,
    '',
    '## Resolved Capabilities',
    ...renderCapabilitySection('instructions', record.resolvedCapabilities.instructions),
    ...renderCapabilitySection('tools', record.resolvedCapabilities.tools),
    ...renderCapabilitySection('skills', record.resolvedCapabilities.skills),
    ...renderCapabilitySection('agents', record.resolvedCapabilities.agents),
    ...renderCapabilitySection('slashCommands', record.resolvedCapabilities.slashCommands),
    ...renderCapabilitySection('hooks', record.resolvedCapabilities.hooks),
    ...renderCapabilitySection('mcp', record.resolvedCapabilities.mcp),
  ].join('\n');

  return ['---', header, '---', body].join('\n');
}

function pushCapabilityFrontmatter(
  entries: Array<readonly [string, unknown]>,
  key: string,
  values: readonly string[] | undefined,
): void {
  if (Array.isArray(values) && values.length > 0) {
    entries.push([key, values]);
  }
}

function renderCapabilitySection(label: string, values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  return [
    `- ${label}: ${values.join(', ')}`,
  ];
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

function normalizeLocation(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveFilesystemLocation(value: string | undefined): string {
  const normalized = normalizeLocation(value);
  if (!normalized) {
    return '';
  }

  if (normalized.startsWith('file://')) {
    return decodeFileUri(normalized);
  }

  return looksLikeFilesystemPath(normalized) ? normalized : '';
}

function decodeFileUri(value: string): string {
  const withoutScheme = value.replace(/^file:\/\//i, '');
  if (withoutScheme.startsWith('/')) {
    const windowsDriveMatch = withoutScheme.match(/^\/([a-zA-Z]:\/.*)$/);
    if (windowsDriveMatch) {
      return decodeURI(windowsDriveMatch[1]);
    }
  }

  return decodeURI(withoutScheme);
}

function normalizeFilesystemLocation(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isEqualOrParentPath(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function looksLikeFilesystemPath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value);
}

function toFileUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/g, '');
  const encoded = encodeURI(normalized);
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encoded}`;
  }
  if (normalized.startsWith('//')) {
    return `file:${encoded}`;
  }

  return normalized.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}