import type { AgentSource } from 'aily-lex/browser';

export const BLOCKLY_HOST_HOOK_URI_SCHEME = 'aily-chat-hook';

type HookChangeSubscription =
  | { dispose?: () => void; unsubscribe?: () => void }
  | (() => void)
  | void;

type HookCustomizationSource = 'builtin' | 'host' | 'plugin' | 'project' | 'user' | 'direct';
type HookCustomizationLayer = 'system' | 'project' | 'user' | 'session';

interface HookCustomizationDescriptorLike {
  readonly event: string;
  readonly source: HookCustomizationSource;
  readonly layer: HookCustomizationLayer;
  readonly name: string;
  readonly priority: number;
  readonly order: number;
  readonly toolName?: string;
}

export interface BlocklyHookCustomizationContribution {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly source?: AgentSource;
  readonly content?: string;
}

export interface BlocklyHookCustomizationAgent {
  readonly hookRegistry?: unknown;
}

export interface BlocklyHookCustomizationProvider {
  contributeHooks(): readonly BlocklyHookCustomizationContribution[];
  onHooksChanged?(listener: () => void): HookChangeSubscription;
}

export function createBlocklyHookCustomizationProvider(
  options: { readonly getAgent: () => BlocklyHookCustomizationAgent | null | undefined },
): BlocklyHookCustomizationProvider {
  return {
    contributeHooks(): readonly BlocklyHookCustomizationContribution[] {
      const hookRegistry = getHookCustomizationRegistry(options.getAgent()?.hookRegistry);
      if (!hookRegistry) {
        return [];
      }

      return hookRegistry.getCustomizationDescriptors().map(toHookCustomizationContribution);
    },
    onHooksChanged(listener: () => void): HookChangeSubscription {
      return getHookCustomizationRegistry(options.getAgent()?.hookRegistry)?.onDidChange?.(listener);
    },
  };
}

function getHookCustomizationRegistry(
  value: unknown,
): {
  getCustomizationDescriptors(): readonly HookCustomizationDescriptorLike[];
  onDidChange?(listener: () => void): HookChangeSubscription;
} | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as {
    getCustomizationDescriptors?: unknown;
    onDidChange?: unknown;
  };
  if (typeof candidate.getCustomizationDescriptors !== 'function') {
    return undefined;
  }

  return {
    getCustomizationDescriptors: candidate.getCustomizationDescriptors.bind(value) as () => readonly HookCustomizationDescriptorLike[],
    onDidChange: typeof candidate.onDidChange === 'function'
      ? candidate.onDidChange.bind(value) as (listener: () => void) => HookChangeSubscription
      : undefined,
  };
}

function toHookCustomizationContribution(
  descriptor: HookCustomizationDescriptorLike,
): BlocklyHookCustomizationContribution {
  const matcherLabel = descriptor.toolName && descriptor.toolName !== '*'
    ? ` (${descriptor.toolName})`
    : '';
  return {
    uri: createBlocklyHostHookUri(descriptor),
    name: `${descriptor.event}${matcherLabel}`,
    description: `${descriptor.name} · ${descriptor.source}/${descriptor.layer}`,
    source: mapHookSourceToCustomizationSource(descriptor.source),
    content: serializeHookCustomizationDescriptor(descriptor),
  };
}

function createBlocklyHostHookUri(descriptor: HookCustomizationDescriptorLike): string {
  const encodedEvent = encodeURIComponent(descriptor.event);
  const encodedName = encodeURIComponent(descriptor.name || 'unknown');
  const encodedMatcher = encodeURIComponent(descriptor.toolName || '*');
  return `${BLOCKLY_HOST_HOOK_URI_SCHEME}:/hooks/${encodedEvent}/${encodedName}/${encodedMatcher}/${descriptor.order}.json`;
}

function mapHookSourceToCustomizationSource(
  source: HookCustomizationSource,
): AgentSource | undefined {
  switch (source) {
    case 'builtin':
      return 'built-in';
    case 'plugin':
      return 'plugin';
    case 'project':
      return 'project';
    case 'user':
      return 'user';
    case 'host':
      return 'host';
    default:
      return undefined;
  }
}

function serializeHookCustomizationDescriptor(descriptor: HookCustomizationDescriptorLike): string {
  return JSON.stringify({
    event: descriptor.event,
    matcher: descriptor.toolName ?? '*',
    provider: {
      name: descriptor.name,
      source: descriptor.source,
      layer: descriptor.layer,
      priority: descriptor.priority,
      registrationOrder: descriptor.order,
    },
  }, null, 2);
}