import type { Observable } from 'rxjs';
import { normalizeAgentIdentifier } from './agent-identifiers';

export const CHAT_MODE_IDS = ['ask', 'edit', 'agent', 'plan'] as const;
export type ChatModeId = (typeof CHAT_MODE_IDS)[number];

export const CHAT_SURFACE_MODE_IDS = CHAT_MODE_IDS;
export type ChatSurfaceModeId = ChatModeId;

export type ChatSessionType = string;
export const LOCAL_CHAT_SESSION_TYPE: ChatSessionType = 'local';
export const AILY_AGENT_CHAT_SESSION_TYPE: ChatSessionType = 'aily-agent';
export const DEFAULT_CHAT_SESSION_TYPE: ChatSessionType = LOCAL_CHAT_SESSION_TYPE;

const CHAT_SESSION_CUSTOM_AGENT_TARGETS = {
  [AILY_AGENT_CHAT_SESSION_TYPE]: 'aily',
} as const satisfies Record<string, ChatResolvedModeTarget>;

export interface ChatSelectedMode {
  readonly modeId: ChatSurfaceModeId;
  readonly customAgentTarget?: string;
}

export interface ChatResolvedModeInstructions {
  readonly content: string;
  readonly toolReferences: readonly unknown[];
  readonly metadata?: Readonly<Record<string, boolean | string | number>>;
}

export type ChatResolvedModeSource = 'built-in' | 'host' | 'user' | 'project' | 'plugin';

export interface ChatResolvedModeHandoff {
  readonly label: string;
  readonly agent: string;
  readonly prompt: string;
  readonly send?: boolean;
  readonly showContinueOn?: boolean;
  readonly model?: string;
}

export type ChatResolvedModeTarget = 'aily' | 'undefined';

export interface ChatResolvedModeVisibility {
  readonly userInvocable: boolean;
  readonly agentInvocable: boolean;
}

export interface ChatResolvedMode {
  readonly id: string;
  readonly kind: ChatSurfaceModeId;
  readonly isBuiltin: boolean;
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly modeInstructions?: ChatResolvedModeInstructions;
  readonly uri?: string;
  readonly customTools?: readonly string[];
  readonly source?: ChatResolvedModeSource;
  readonly model?: string;
  readonly argumentHint?: string;
  readonly target?: ChatResolvedModeTarget;
  readonly visibility?: ChatResolvedModeVisibility;
  readonly enabled?: boolean;
  readonly sessionTypes?: readonly string[];
  readonly permissionMode?: ChatSessionPermissionMode;
  readonly handOffs?: readonly ChatResolvedModeHandoff[];
  readonly agents?: readonly string[];
  readonly hidden?: boolean;
  readonly customAgentTarget?: string;
}

export interface ChatResolvedModesCollection {
  readonly builtin: readonly ChatResolvedMode[];
  readonly custom: readonly ChatResolvedMode[];
  findModeById(modeId: string): ChatResolvedMode | undefined;
  findModeByName(modeName: string): ChatResolvedMode | undefined;
}

export interface ChatRuntimeModeCollection extends ChatResolvedModesCollection {
  readonly onDidChange: Observable<void>;
  waitForRefresh(): Promise<void>;
}

export interface ResolveChatCurrentModeOptions {
  readonly resolveAgentModeDefinition?: (agentId: string) => unknown;
}

export interface ChatSessionInputMode {
  readonly id: string;
  readonly kind: ChatSurfaceModeId | undefined;
  readonly modeInstructions?: ChatSessionInputModeInstructions;
}

export interface ChatSessionInputModeInstructions {
  readonly uri?: string;
  readonly name: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, boolean | string | number>>;
  readonly isBuiltin?: boolean;
}

export interface ChatSessionProviderOptionIcon {
  readonly id: string;
  readonly color?: string;
}

export interface ChatSessionProviderOptionCommand {
  readonly command: string;
  readonly title: string;
  readonly tooltip?: string;
  readonly arguments?: readonly unknown[];
}

export interface ChatSessionModeDescriptor {
  readonly id: string;
  readonly kind: ChatSurfaceModeId;
  readonly isBuiltin: boolean;
  readonly name?: string;
  readonly modeInstructions?: ChatSessionInputModeInstructions;
}

export interface ChatSessionProviderOptionItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: ChatSessionProviderOptionIcon;
  readonly default?: boolean;
  readonly locked?: boolean;
  readonly slashCommand?: string;
}

export interface ChatSessionProviderOptionGroup {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly kind?: string;
  readonly icon?: ChatSessionProviderOptionIcon;
  readonly when?: string;
  readonly commands?: readonly ChatSessionProviderOptionCommand[];
  readonly items: readonly ChatSessionProviderOptionItem[];
  readonly selected?: ChatSessionProviderOptionItem;
}

export const CHAT_SESSION_PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const;
export type ChatSessionPermissionMode = (typeof CHAT_SESSION_PERMISSION_MODES)[number];

export const DEFAULT_CHAT_SESSION_PERMISSION_MODE: ChatSessionPermissionMode = 'default';

export const CHAT_SESSION_PERMISSION_PROFILES = ['workspace-write', 'danger-full-access'] as const;
export type ChatSessionPermissionProfile = (typeof CHAT_SESSION_PERMISSION_PROFILES)[number];

export const DEFAULT_CHAT_SESSION_PERMISSION_PROFILE: ChatSessionPermissionProfile = 'workspace-write';

export function normalizeChatSessionType(
  value: unknown,
  fallback: ChatSessionType = DEFAULT_CHAT_SESSION_TYPE,
): ChatSessionType {
  const normalizedValue = typeof value === 'string'
    ? value.trim()
    : '';
  if (normalizedValue) {
    return normalizedValue;
  }

  const normalizedFallback = typeof fallback === 'string'
    ? fallback.trim()
    : '';
  return normalizedFallback || DEFAULT_CHAT_SESSION_TYPE;
}

export function resolveChatSessionCustomAgentTarget(
  sessionType: unknown,
): ChatResolvedModeTarget | undefined {
  const normalizedSessionType = typeof sessionType === 'string'
    ? sessionType.trim()
    : '';
  return normalizedSessionType
    ? CHAT_SESSION_CUSTOM_AGENT_TARGETS[normalizedSessionType as keyof typeof CHAT_SESSION_CUSTOM_AGENT_TARGETS]
    : undefined;
}

export interface ChatSessionInputState {
  mode: ChatSessionInputMode;
  groups?: readonly ChatSessionProviderOptionGroup[];
}

export const PLAN_CHAT_AGENT_TARGET = 'Plan';
export const PLAN_CHAT_MODE_DESCRIPTION = 'Researches and outlines multi-step plans';
export const PLAN_CHAT_MODE_ARGUMENT_HINT = 'Outline the goal or problem to research';
export const PLAN_CHAT_MODE_START_IMPLEMENTATION_PROMPT = 'Start implementation';
export const PLAN_CHAT_MODE_OPEN_IN_EDITOR_PROMPT = '#createFile the plan as is into an untitled file (`untitled:plan-{camelCaseName}.prompt.md` without frontmatter) for further refinement.';

const BUILTIN_CHAT_MODE_LABELS: Record<ChatSurfaceModeId, string> = {
  ask: 'Ask',
  edit: 'Edit',
  agent: 'Agent',
  plan: 'Plan',
};

export const DEFAULT_CHAT_MODE_ID: ChatModeId = 'agent';
export const DEFAULT_CHAT_SURFACE_MODE_ID: ChatSurfaceModeId = 'agent';
export const DEFAULT_CHAT_SELECTED_MODE: ChatSelectedMode = { modeId: DEFAULT_CHAT_SURFACE_MODE_ID };
export const DEFAULT_CHAT_RESOLVED_MODE: ChatResolvedMode = createBuiltinChatResolvedMode(DEFAULT_CHAT_SURFACE_MODE_ID);
export const DEFAULT_CHAT_SESSION_INPUT_STATE: ChatSessionInputState = {
  mode: {
    id: DEFAULT_CHAT_SELECTED_MODE.modeId,
    kind: DEFAULT_CHAT_SELECTED_MODE.modeId,
  },
  groups: [],
};

export function normalizeChatSessionPermissionMode(
  value: unknown,
  fallback: ChatSessionPermissionMode = DEFAULT_CHAT_SESSION_PERMISSION_MODE,
): ChatSessionPermissionMode {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalizedValue = value.trim();
  return (CHAT_SESSION_PERMISSION_MODES as readonly string[]).includes(normalizedValue)
    ? normalizedValue as ChatSessionPermissionMode
    : fallback;
}

export function normalizeChatSessionPermissionProfile(
  value: unknown,
  fallback: ChatSessionPermissionProfile = DEFAULT_CHAT_SESSION_PERMISSION_PROFILE,
): ChatSessionPermissionProfile {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalizedValue = value.trim();
  if (normalizedValue === 'bypassPermissions' || normalizedValue === 'danger-full-access') {
    return 'danger-full-access';
  }

  return (CHAT_SESSION_PERMISSION_PROFILES as readonly string[]).includes(normalizedValue)
    ? normalizedValue as ChatSessionPermissionProfile
    : fallback;
}

export function resolveChatModeId(value: unknown): ChatModeId | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return undefined;
  }

  switch (normalizedValue) {
    case 'qa':
      return 'ask';
    case 'ask':
    case 'edit':
    case 'agent':
    case 'plan':
      return normalizedValue;
    default:
      return undefined;
  }
}

export function isPlanChatAgentTarget(value: unknown): boolean {
  return normalizeAgentIdentifier(typeof value === 'string' ? value : '')
    === normalizeAgentIdentifier(PLAN_CHAT_AGENT_TARGET);
}

export function normalizeChatModeId(
  value: unknown,
  fallback: ChatModeId = DEFAULT_CHAT_MODE_ID,
): ChatModeId {
  return resolveChatModeId(value) ?? fallback;
}

export function resolveChatSurfaceModeId(value: unknown): ChatSurfaceModeId | undefined {
  return resolveChatModeId(value);
}

export function normalizeChatSurfaceModeId(
  value: unknown,
  fallback: ChatSurfaceModeId = DEFAULT_CHAT_SURFACE_MODE_ID,
): ChatSurfaceModeId {
  return resolveChatSurfaceModeId(value) ?? fallback;
}

export function normalizeChatSelectedMode(
  value: { readonly modeId?: unknown; readonly customAgentTarget?: unknown } | undefined,
  fallback: ChatSelectedMode = DEFAULT_CHAT_SELECTED_MODE,
): ChatSelectedMode {
  const modeId = normalizeChatSurfaceModeId(value?.modeId, fallback.modeId);
  const customAgentTarget = normalizeAgentIdentifier(
    typeof value?.customAgentTarget === 'string'
      ? value.customAgentTarget
      : undefined,
  ) || undefined;

  if (modeId === 'agent' && isPlanChatAgentTarget(customAgentTarget)) {
    return { modeId: 'plan' };
  }

  return {
    modeId,
    ...(modeId === 'agent' && customAgentTarget ? { customAgentTarget } : {}),
  };
}

export function createChatSelectedMode(
  modeId: unknown,
  customAgentTarget?: unknown,
): ChatSelectedMode {
  return normalizeChatSelectedMode({ modeId, customAgentTarget });
}

export function createBuiltinChatResolvedMode(
  modeId: unknown,
): ChatResolvedMode {
  const normalizedModeId = normalizeChatSurfaceModeId(modeId, DEFAULT_CHAT_SURFACE_MODE_ID);
  if (normalizedModeId === 'plan') {
    return createPlanChatResolvedMode();
  }

  return {
    id: normalizedModeId,
    kind: normalizedModeId,
    isBuiltin: true,
    name: normalizedModeId,
    label: BUILTIN_CHAT_MODE_LABELS[normalizedModeId],
  };
}

export function createPlanChatResolvedMode(): ChatResolvedMode {
  return {
    id: 'plan',
    kind: 'plan',
    isBuiltin: true,
    name: PLAN_CHAT_AGENT_TARGET,
    label: PLAN_CHAT_AGENT_TARGET,
    description: PLAN_CHAT_MODE_DESCRIPTION,
    argumentHint: PLAN_CHAT_MODE_ARGUMENT_HINT,
    target: 'aily',
    sessionTypes: [LOCAL_CHAT_SESSION_TYPE],
    visibility: {
      userInvocable: true,
      agentInvocable: false,
    },
    agents: ['Explore'],
    handOffs: [
      {
        label: 'Start Implementation',
        agent: 'agent',
        prompt: PLAN_CHAT_MODE_START_IMPLEMENTATION_PROMPT,
        send: true,
      },
      {
        label: 'Open in Editor',
        agent: 'agent',
        prompt: PLAN_CHAT_MODE_OPEN_IN_EDITOR_PROMPT,
        send: true,
        showContinueOn: false,
      },
    ],
    modeInstructions: {
      content: [
        'You are a PLANNING AGENT, pairing with the user to create a detailed, actionable plan.',
        'Your SOLE responsibility is planning. NEVER start implementation.',
        'Research the project, clarify ambiguity, identify risks, and present a concise implementation plan before any changes are made.',
        'Plan Mode is a collaboration mode. Do not confuse it with a generic TODO/checklist or progress tracker; the final plan artifact must be emitted as exactly one <proposed_plan> block.',
        'Do not edit files, install dependencies, deploy, flash firmware, or run mutating device commands in Plan mode.',
        'Use read-only project/library search, memory, and focused research agents when useful.',
        'When delegating focused discovery, call the agent tool with agentName="Explore"; Explore subagents return findings only and must never emit <proposed_plan>.',
        'If the user answers a clarifying question while this conversation is still in Plan mode, treat that answer only as plan refinement input. Never start implementation from that answer.',
        'When persisting the current plan, use the memory path /memories/session/plan.md. Keep that file in sync with plan revisions, but never use the file as a substitute for showing the plan to the user.',
        'For Blockly and hardware work, include board/library constraints, wiring or pinmap assumptions, generated code impact, firmware/build/flash verification, and any device safety or rollback considerations.',
        'When the plan is ready, show a concise human-readable plan inside <proposed_plan> and </proposed_plan>, then stop. Implementation can only start from the host Start Implementation handoff in Agent mode.',
      ].join('\n\n'),
      toolReferences: [],
      metadata: {
        source: 'bootstrap',
        promptVersion: 'aily-plan-mode-2026-06-15',
        planningOnly: true,
      },
    },
    customAgentTarget: PLAN_CHAT_AGENT_TARGET,
  };
}

export function isPlanChatResolvedMode(
  mode: Pick<ChatResolvedMode, 'id' | 'kind' | 'isBuiltin' | 'name' | 'customAgentTarget'> | null | undefined,
): boolean {
  return mode?.kind === 'plan'
    || (mode?.kind === 'agent'
      && mode.isBuiltin === false
      && (isPlanChatAgentTarget(mode.customAgentTarget)
      || isPlanChatAgentTarget(mode.name)
      || isPlanChatAgentTarget(mode.id)));
}

const BUILTIN_CHAT_RESOLVED_MODES: readonly ChatResolvedMode[] = CHAT_SURFACE_MODE_IDS.map(modeId =>
  createBuiltinChatResolvedMode(modeId),
);

export function createChatResolvedModesCollection(
  customModes: readonly ChatResolvedMode[] = [],
): ChatResolvedModesCollection {
  const custom = [...customModes]
    .filter((mode): mode is ChatResolvedMode => !!mode && mode.isBuiltin === false)
    .sort((left, right) => left.label.localeCompare(right.label));
  const customById = new Map(custom.map(mode => [mode.id, mode]));
  const customByName = new Map(custom.map(mode => [mode.name, mode]));

  return {
    builtin: BUILTIN_CHAT_RESOLVED_MODES,
    custom,
    findModeById(modeId: string): ChatResolvedMode | undefined {
      const normalizedModeId = typeof modeId === 'string'
        ? modeId.trim()
        : '';
      if (!normalizedModeId) {
        return undefined;
      }

      const builtinModeId = resolveChatSurfaceModeId(normalizedModeId);
      if (builtinModeId) {
        return BUILTIN_CHAT_RESOLVED_MODES.find(mode => mode.id === builtinModeId);
      }

      return customById.get(normalizedModeId);
    },
    findModeByName(modeName: string): ChatResolvedMode | undefined {
      const normalizedModeName = typeof modeName === 'string'
        ? modeName.trim()
        : '';
      if (!normalizedModeName) {
        return undefined;
      }

      const builtinModeId = resolveChatSurfaceModeId(normalizedModeName);
      if (builtinModeId) {
        return BUILTIN_CHAT_RESOLVED_MODES.find(mode => mode.name === builtinModeId);
      }

      return customByName.get(normalizedModeName);
    },
  };
}

export function serializeChatResolvedModesCache(
  customModes: readonly ChatResolvedMode[] | null | undefined,
): readonly ChatResolvedMode[] {
  if (!Array.isArray(customModes)) {
    return [];
  }

  return customModes
    .filter((mode): mode is ChatResolvedMode => !!mode && mode.isBuiltin === false)
    .map((mode) => ({
      id: mode.id,
      kind: mode.kind,
      isBuiltin: false,
      name: mode.name,
      label: mode.label,
      ...(mode.description ? { description: mode.description } : {}),
      ...(mode.uri ? { uri: mode.uri } : {}),
      ...(mode.customAgentTarget ? { customAgentTarget: mode.customAgentTarget } : {}),
      ...(mode.customTools ? { customTools: [...mode.customTools] } : {}),
      ...(mode.source ? { source: mode.source } : {}),
      ...(mode.model ? { model: mode.model } : {}),
      ...(mode.argumentHint ? { argumentHint: mode.argumentHint } : {}),
      ...(mode.target ? { target: mode.target } : {}),
      ...(mode.visibility ? { visibility: { ...mode.visibility } } : {}),
      ...(mode.enabled === false ? { enabled: false } : {}),
      ...(mode.sessionTypes ? { sessionTypes: [...mode.sessionTypes] } : {}),
      ...(mode.permissionMode ? { permissionMode: mode.permissionMode } : {}),
      ...(mode.handOffs ? {
        handOffs: mode.handOffs.map((handoff) => ({
          label: handoff.label,
          agent: handoff.agent,
          prompt: handoff.prompt,
          ...(handoff.send !== undefined ? { send: handoff.send } : {}),
          ...(handoff.showContinueOn !== undefined ? { showContinueOn: handoff.showContinueOn } : {}),
          ...(handoff.model ? { model: handoff.model } : {}),
        })),
      } : {}),
      ...(mode.agents ? { agents: [...mode.agents] } : {}),
      ...(mode.hidden ? { hidden: true } : {}),
      ...(mode.modeInstructions ? {
        modeInstructions: {
          content: mode.modeInstructions.content,
          toolReferences: [...mode.modeInstructions.toolReferences],
          ...(mode.modeInstructions.metadata ? { metadata: { ...mode.modeInstructions.metadata } } : {}),
        },
      } : {}),
    }));
}

export function deserializeChatResolvedModesCache(
  value: unknown,
): readonly ChatResolvedMode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const modes = new Map<string, ChatResolvedMode>();
  for (const entry of value) {
    const mode = readCachedChatResolvedMode(entry);
    if (mode) {
      modes.set(mode.id, mode);
    }
  }

  return [...modes.values()];
}

export function resolveChatCurrentMode(
  selectedModeOrModeId: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> | unknown,
  customAgentTargetOrOptions?: unknown,
  maybeOptions?: ResolveChatCurrentModeOptions,
): ChatResolvedMode {
  const selectedMode = isSelectedModeSnapshot(selectedModeOrModeId)
    ? normalizeChatSelectedMode(selectedModeOrModeId)
    : normalizeChatSelectedMode({
        modeId: selectedModeOrModeId,
        customAgentTarget: customAgentTargetOrOptions,
      });
  const options = isSelectedModeSnapshot(selectedModeOrModeId)
    ? customAgentTargetOrOptions as ResolveChatCurrentModeOptions | undefined
    : maybeOptions;
  const selectedCustomAgentTarget = resolveChatSelectedCustomAgentTarget(selectedMode);

  if (selectedMode.modeId === 'plan') {
    return createPlanChatResolvedMode();
  }

  if (selectedMode.modeId !== 'agent' || !selectedCustomAgentTarget) {
    return createBuiltinChatResolvedMode(selectedMode.modeId);
  }

  const resolvedDefinition = options?.resolveAgentModeDefinition?.(selectedCustomAgentTarget);
  const agentModeDefinition = readAgentModeDefinition(resolvedDefinition);
  if (!agentModeDefinition && isPlanChatAgentTarget(selectedCustomAgentTarget)) {
    return createPlanChatResolvedMode();
  }
  const name = readNonEmptyString(agentModeDefinition?.name)
    ?? readNonEmptyString(agentModeDefinition?.agentType)
    ?? selectedCustomAgentTarget;
  const uri = readNonEmptyString(agentModeDefinition?.uri);
  const description = readNonEmptyString(agentModeDefinition?.description)
    ?? readNonEmptyString(agentModeDefinition?.whenToUse);
  const customTools = readStringArray(agentModeDefinition?.tools);
  const source = readChatResolvedModeSource(agentModeDefinition?.source);
  const model = readNonEmptyString(agentModeDefinition?.model);
  const argumentHint = readNonEmptyString(agentModeDefinition?.argumentHint);
  const target = readChatResolvedModeTarget(agentModeDefinition?.target);
  const visibility = readChatResolvedModeVisibility(agentModeDefinition?.visibility);
  const enabled = agentModeDefinition?.enabled === false ? false : undefined;
  const sessionTypes = readStringArray(agentModeDefinition?.sessionTypes);
  const permissionMode = readChatResolvedModePermissionMode(agentModeDefinition?.permissionMode);
  const handOffs = readChatResolvedModeHandoffs(agentModeDefinition?.handoffs);
  const agents = readStringArray(agentModeDefinition?.agents);
  const modeInstructions = readModeInstructions(agentModeDefinition?.modeInstructions)
    ?? buildModeInstructionsFromSystemPrompt(agentModeDefinition?.systemPrompt)
    ?? {
      content: '',
      toolReferences: [],
    };

  return {
    id: uri ?? selectedCustomAgentTarget,
    kind: 'agent',
    isBuiltin: false,
    name,
    label: name,
    ...(description ? { description } : {}),
    ...(uri ? { uri } : {}),
    ...(customTools ? { customTools } : {}),
    ...(source ? { source } : {}),
    ...(model ? { model } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    ...(target ? { target } : {}),
    ...(visibility ? { visibility } : {}),
    ...(enabled === false ? { enabled: false } : {}),
    ...(sessionTypes ? { sessionTypes } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(handOffs ? { handOffs } : {}),
    ...(agents ? { agents } : {}),
    ...(agentModeDefinition?.hidden === true ? { hidden: true } : {}),
    modeInstructions,
    customAgentTarget: selectedCustomAgentTarget,
  };
}

export function createTurnRequestModeInfoFromResolvedMode(
  mode: Pick<ChatResolvedMode, 'kind' | 'isBuiltin' | 'name' | 'modeInstructions' | 'uri'>,
): Record<string, unknown> {
  if (mode.isBuiltin) {
    return {
      kind: mode.kind,
      isBuiltin: true,
      modeId: mode.kind,
    };
  }

  return {
    kind: mode.kind,
    isBuiltin: false,
    modeId: 'custom',
    modeInstructions: {
      ...(mode.uri ? { uri: mode.uri } : {}),
      name: mode.name,
      content: mode.modeInstructions?.content ?? '',
      toolReferences: [...(mode.modeInstructions?.toolReferences ?? [])],
      ...(mode.modeInstructions?.metadata ? { metadata: { ...mode.modeInstructions.metadata } } : {}),
      isBuiltin: false,
    },
  };
}

export function createChatSessionModeDescriptor(
  selectedMode: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> | null | undefined,
): ChatSessionModeDescriptor {
  const normalizedSelectedMode = normalizeChatSelectedMode(selectedMode ?? DEFAULT_CHAT_SELECTED_MODE);
  const customAgentTarget = resolveChatSelectedCustomAgentTarget(normalizedSelectedMode);

  if (normalizedSelectedMode.modeId !== 'agent' || !customAgentTarget) {
    return createChatSessionModeDescriptorFromResolvedMode(createBuiltinChatResolvedMode(normalizedSelectedMode.modeId));
  }

  return {
    id: customAgentTarget,
    kind: 'agent',
    isBuiltin: false,
    name: customAgentTarget,
    modeInstructions: {
      name: customAgentTarget,
      content: '',
      isBuiltin: false,
    },
  };
}

export function createChatSessionModeDescriptorFromResolvedMode(
  mode: Pick<ChatResolvedMode, 'id' | 'kind' | 'isBuiltin' | 'name' | 'modeInstructions' | 'uri'> | null | undefined,
): ChatSessionModeDescriptor {
  const kind = normalizeChatSurfaceModeId(mode?.kind, DEFAULT_CHAT_SURFACE_MODE_ID);
  const id = typeof mode?.id === 'string' && mode.id.trim().length > 0
    ? mode.id.trim()
    : kind;

  if (!mode || mode.isBuiltin !== false || kind !== 'agent') {
    return {
      id,
      kind,
      isBuiltin: true,
      name: kind,
    };
  }

  return {
    id,
    kind,
    isBuiltin: false,
    ...(readNonEmptyString(mode.name) ? { name: readNonEmptyString(mode.name) } : {}),
    ...(serializeChatSessionInputModeInstructions(mode, kind)
      ? { modeInstructions: serializeChatSessionInputModeInstructions(mode, kind)! }
      : {}),
  };
}

export function createChatSessionInputModeFromResolvedMode(
  mode: Pick<ChatResolvedMode, 'id' | 'kind' | 'isBuiltin' | 'name' | 'modeInstructions' | 'uri'> | null | undefined,
): ChatSessionInputMode {
  const kind = normalizeChatSurfaceModeId(mode?.kind, DEFAULT_CHAT_SURFACE_MODE_ID);
  const id = typeof mode?.id === 'string' && mode.id.trim().length > 0
    ? mode.id.trim()
    : kind;
  const modeInstructions = serializeChatSessionInputModeInstructions(mode, kind);

  return {
    id,
    kind,
    ...(modeInstructions ? { modeInstructions } : {}),
  };
}

export function createChatSessionInputStateFromResolvedMode(
  mode: Pick<ChatResolvedMode, 'id' | 'kind' | 'isBuiltin' | 'name' | 'modeInstructions' | 'uri'> | null | undefined,
  options?: { readonly groups?: readonly ChatSessionProviderOptionGroup[] | null | undefined },
): ChatSessionInputState {
  return {
    mode: createChatSessionInputModeFromResolvedMode(mode),
    groups: resolveChatSessionInputGroups(options),
  };
}

export function createChatSessionInputState(
  selectedMode: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> | null | undefined,
  options?: { readonly groups?: readonly ChatSessionProviderOptionGroup[] | null | undefined },
): ChatSessionInputState {
  const normalizedSelectedMode = normalizeChatSelectedMode(selectedMode ?? DEFAULT_CHAT_SELECTED_MODE);
  const customAgentTarget = resolveChatSelectedCustomAgentTarget(normalizedSelectedMode);

  return {
    mode: {
      id: normalizedSelectedMode.modeId === 'agent' && customAgentTarget
        ? customAgentTarget
        : normalizedSelectedMode.modeId,
      kind: normalizedSelectedMode.modeId,
      ...(normalizedSelectedMode.modeId === 'agent' && customAgentTarget
        ? {
            modeInstructions: {
              name: customAgentTarget,
              content: '',
              isBuiltin: false,
            },
          }
        : {}),
    },
    groups: resolveChatSessionInputGroups(options),
  };
}

export function resolveChatSelectedModeFromInputState(
  value: { readonly mode?: { readonly id?: unknown; readonly kind?: unknown; readonly modeInstructions?: unknown } } | null | undefined,
): ChatSelectedMode | undefined {
  const mode = normalizeChatSessionInputMode(value?.mode);
  if (!mode) {
    return undefined;
  }

  if (mode.kind === 'agent') {
    if (isPlanChatAgentTarget(mode.id) || isPlanChatAgentTarget(mode.modeInstructions?.name)) {
      return { modeId: 'plan' };
    }

    const builtinModeId = resolveChatSurfaceModeId(mode.id);
    if (!mode.id || builtinModeId === 'agent') {
      if (mode.modeInstructions?.name) {
        return normalizeChatSelectedMode({
          modeId: 'agent',
          customAgentTarget: mode.modeInstructions.name,
        });
      }

      return { modeId: 'agent' };
    }

    if (builtinModeId) {
      return { modeId: builtinModeId };
    }

    return normalizeChatSelectedMode({
      modeId: 'agent',
      customAgentTarget: mode.id,
    });
  }

  const builtinModeId = resolveChatSurfaceModeId(mode.id) ?? mode.kind;
  if (builtinModeId) {
    return normalizeChatSelectedMode({ modeId: builtinModeId });
  }

  return mode.id
    ? normalizeChatSelectedMode({
        modeId: 'agent',
        customAgentTarget: mode.id,
      })
    : undefined;
}

export function normalizeChatSessionInputState(
  value: { readonly mode?: { readonly id?: unknown; readonly kind?: unknown; readonly modeInstructions?: unknown }; readonly groups?: unknown } | null | undefined,
  fallback: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> = DEFAULT_CHAT_SELECTED_MODE,
): ChatSessionInputState {
  const groups = resolveChatSessionInputGroups(value);
  const mode = normalizeChatSessionInputMode(value?.mode);
  if (!mode) {
    return createChatSessionInputState(normalizeChatSelectedMode(fallback), { groups });
  }

  const builtinModeId = resolveChatSurfaceModeId(mode.id);
  if (builtinModeId) {
    return {
      mode: {
        id: builtinModeId,
        kind: mode.kind ?? builtinModeId,
        ...(mode.modeInstructions ? { modeInstructions: mode.modeInstructions } : {}),
      },
      groups,
    };
  }

  if (mode.kind === 'agent' && mode.id) {
    return {
      mode: {
        id: mode.id,
        kind: 'agent',
        ...(mode.modeInstructions ? { modeInstructions: mode.modeInstructions } : {}),
      },
      groups,
    };
  }

  if (mode.kind) {
    return {
      mode: {
        id: mode.kind,
        kind: mode.kind,
        ...(mode.modeInstructions ? { modeInstructions: mode.modeInstructions } : {}),
      },
      groups,
    };
  }

  return createChatSessionInputState(normalizeChatSelectedMode(fallback), { groups });
}

export function resolveChatSelectedCustomAgentTarget(
  selectedMode: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> | null | undefined,
): string | undefined {
  return selectedMode?.modeId === 'agent'
    ? normalizeAgentIdentifier(selectedMode.customAgentTarget) || undefined
    : undefined;
}

export function isSameChatSelectedMode(
  left: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> | null | undefined,
  right: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> | null | undefined,
): boolean {
  return normalizeChatSurfaceModeId(left?.modeId) === normalizeChatSurfaceModeId(right?.modeId)
    && resolveChatSelectedCustomAgentTarget(left) === resolveChatSelectedCustomAgentTarget(right);
}

export function normalizeChatSessionInputMode(
  value: { readonly id?: unknown; readonly kind?: unknown; readonly modeInstructions?: unknown } | null | undefined,
): ChatSessionInputMode | undefined {
  const rawMode = value;
  if (!rawMode || typeof rawMode !== 'object' || Array.isArray(rawMode)) {
    return undefined;
  }

  const id = typeof rawMode.id === 'string'
    ? rawMode.id.trim()
    : '';
  const kind = resolveChatSurfaceModeId(rawMode.kind);
  if (!id && !kind) {
    return undefined;
  }

  return {
    id: id || (kind ?? DEFAULT_CHAT_SURFACE_MODE_ID),
    kind: kind ?? resolveChatSurfaceModeId(id),
    ...(normalizeChatSessionInputModeInstructions(rawMode.modeInstructions)
      ? { modeInstructions: normalizeChatSessionInputModeInstructions(rawMode.modeInstructions) }
      : {}),
  };
}

export function normalizeChatSessionModeDescriptor(
  value: {
    readonly id?: unknown;
    readonly kind?: unknown;
    readonly isBuiltin?: unknown;
    readonly name?: unknown;
    readonly modeInstructions?: unknown;
  } | null | undefined,
): ChatSessionModeDescriptor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const rawDescriptor = value;
  const normalizedModeInstructions = normalizeChatSessionInputModeInstructions(rawDescriptor.modeInstructions);
  const id = readNonEmptyString(rawDescriptor.id) ?? normalizedModeInstructions?.uri;
  const kind = resolveChatSurfaceModeId(rawDescriptor.kind) ?? resolveChatSurfaceModeId(id);
  if (!id && !kind) {
    return undefined;
  }

  const normalizedKind = kind ?? DEFAULT_CHAT_SURFACE_MODE_ID;
  const name = readNonEmptyString(rawDescriptor.name) ?? normalizedModeInstructions?.name;
  const isBuiltin = rawDescriptor.isBuiltin === true || normalizedKind !== 'agent';

  if (isBuiltin) {
    return {
      id: normalizedKind,
      kind: normalizedKind,
      isBuiltin: true,
      ...(name ? { name } : {}),
    };
  }

  return {
    id: id ?? normalizedKind,
    kind: normalizedKind,
    isBuiltin: false,
    ...(name ? { name } : {}),
    ...(normalizedModeInstructions ? { modeInstructions: normalizedModeInstructions } : {}),
  };
}

function resolveChatSessionInputGroups(
  value:
    | { readonly groups?: readonly ChatSessionProviderOptionGroup[] | null | undefined }
    | { readonly groups?: unknown }
    | null
    | undefined,
): readonly ChatSessionProviderOptionGroup[] {
  if (!Array.isArray(value?.groups)) {
    return [];
  }

  return value.groups.flatMap((group) => {
    const normalizedGroup = normalizeChatSessionProviderOptionGroup(group);
    return normalizedGroup ? [normalizedGroup] : [];
  });
}

export function normalizeChatSessionProviderOptionGroups(
  value:
    | { readonly groups?: readonly ChatSessionProviderOptionGroup[] | null | undefined }
    | { readonly groups?: unknown }
    | null
    | undefined,
): readonly ChatSessionProviderOptionGroup[] {
  return resolveChatSessionInputGroups(value);
}

function normalizeChatSessionProviderOptionGroup(
  value: unknown,
): ChatSessionProviderOptionGroup | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const group = value as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly description?: unknown;
    readonly kind?: unknown;
    readonly icon?: unknown;
    readonly when?: unknown;
    readonly commands?: unknown;
    readonly items?: unknown;
    readonly selected?: unknown;
  };
  const id = readNonEmptyString(group.id);
  const name = readNonEmptyString(group.name) ?? id;
  if (!id || !name || !Array.isArray(group.items)) {
    return undefined;
  }

  const items = group.items.flatMap((item) => {
    const normalizedItem = normalizeChatSessionProviderOptionItem(item);
    return normalizedItem ? [normalizedItem] : [];
  });
  if (items.length === 0) {
    return undefined;
  }

  const normalizedSelected = normalizeChatSessionProviderOptionItem(group.selected);
  const selected = normalizedSelected
    ? items.find((item) => item.id === normalizedSelected.id) ?? normalizedSelected
    : items[0];

  return {
    id,
    name,
    ...(readNonEmptyString(group.description) ? { description: readNonEmptyString(group.description) } : {}),
    ...(readNonEmptyString(group.kind) ? { kind: readNonEmptyString(group.kind) } : {}),
    ...(normalizeChatSessionProviderOptionIcon(group.icon) ? { icon: normalizeChatSessionProviderOptionIcon(group.icon) } : {}),
    ...(readNonEmptyString(group.when) ? { when: readNonEmptyString(group.when) } : {}),
    ...(normalizeChatSessionProviderOptionCommands(group.commands).length > 0
      ? { commands: normalizeChatSessionProviderOptionCommands(group.commands) }
      : {}),
    items,
    ...(selected ? { selected } : {}),
  };
}

function normalizeChatSessionProviderOptionItem(
  value: unknown,
): ChatSessionProviderOptionItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const item = value as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly description?: unknown;
    readonly icon?: unknown;
    readonly default?: unknown;
    readonly locked?: unknown;
    readonly slashCommand?: unknown;
  };
  const id = readNonEmptyString(item.id);
  const name = readNonEmptyString(item.name) ?? id;
  if (!id || !name) {
    return undefined;
  }

  return {
    id,
    name,
    ...(readNonEmptyString(item.description) ? { description: readNonEmptyString(item.description) } : {}),
    ...(normalizeChatSessionProviderOptionIcon(item.icon) ? { icon: normalizeChatSessionProviderOptionIcon(item.icon) } : {}),
    ...(item.default === true ? { default: true } : {}),
    ...(item.locked === true ? { locked: true } : {}),
    ...(readNonEmptyString(item.slashCommand) ? { slashCommand: readNonEmptyString(item.slashCommand) } : {}),
  };
}

function normalizeChatSessionProviderOptionIcon(
  value: unknown,
): ChatSessionProviderOptionIcon | undefined {
  if (typeof value === 'string') {
    const normalizedId = value.trim();
    return normalizedId ? { id: normalizedId } : undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const icon = value as {
    readonly id?: unknown;
    readonly color?: unknown;
  };
  const id = readNonEmptyString(icon.id);
  if (!id) {
    return undefined;
  }

  return {
    id,
    ...(readNonEmptyString(icon.color) ? { color: readNonEmptyString(icon.color) } : {}),
  };
}

function normalizeChatSessionProviderOptionCommands(
  value: unknown,
): readonly ChatSessionProviderOptionCommand[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const normalizedCommand = normalizeChatSessionProviderOptionCommand(entry);
    return normalizedCommand ? [normalizedCommand] : [];
  });
}

function normalizeChatSessionProviderOptionCommand(
  value: unknown,
): ChatSessionProviderOptionCommand | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const command = value as {
    readonly command?: unknown;
    readonly title?: unknown;
    readonly tooltip?: unknown;
    readonly arguments?: unknown;
  };
  const commandId = readNonEmptyString(command.command);
  const title = readNonEmptyString(command.title);
  if (!commandId || !title) {
    return undefined;
  }

  return {
    command: commandId,
    title,
    ...(readNonEmptyString(command.tooltip) ? { tooltip: readNonEmptyString(command.tooltip) } : {}),
    ...(Array.isArray(command.arguments) ? { arguments: [...command.arguments] } : {}),
  };
}

interface ChatAgentModeDefinitionLike {
  readonly agentType?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly whenToUse?: unknown;
  readonly systemPrompt?: unknown;
  readonly modeInstructions?: {
    readonly content?: unknown;
    readonly toolReferences?: unknown;
    readonly metadata?: unknown;
  };
  readonly uri?: unknown;
  readonly tools?: unknown;
  readonly source?: unknown;
  readonly model?: unknown;
  readonly argumentHint?: unknown;
  readonly target?: unknown;
  readonly visibility?: {
    readonly userInvocable?: unknown;
    readonly agentInvocable?: unknown;
  };
  readonly enabled?: unknown;
  readonly sessionTypes?: unknown;
  readonly permissionMode?: unknown;
  readonly handoffs?: unknown;
  readonly agents?: unknown;
  readonly hidden?: unknown;
}

interface CachedChatResolvedModeLike {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly isBuiltin?: unknown;
  readonly name?: unknown;
  readonly label?: unknown;
  readonly description?: unknown;
  readonly modeInstructions?: {
    readonly content?: unknown;
    readonly toolReferences?: unknown;
    readonly metadata?: unknown;
  };
  readonly uri?: unknown;
  readonly customTools?: unknown;
  readonly source?: unknown;
  readonly model?: unknown;
  readonly argumentHint?: unknown;
  readonly target?: unknown;
  readonly visibility?: {
    readonly userInvocable?: unknown;
    readonly agentInvocable?: unknown;
  };
  readonly enabled?: unknown;
  readonly sessionTypes?: unknown;
  readonly permissionMode?: unknown;
  readonly handOffs?: unknown;
  readonly agents?: unknown;
  readonly hidden?: unknown;
  readonly customAgentTarget?: unknown;
}

function isSelectedModeSnapshot(
  value: unknown,
): value is Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readAgentModeDefinition(value: unknown): ChatAgentModeDefinitionLike | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ChatAgentModeDefinitionLike
    : undefined;
}

function readCachedChatResolvedMode(value: unknown): ChatResolvedMode | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const cachedMode = value as CachedChatResolvedModeLike;
  const id = readNonEmptyString(cachedMode.id);
  const kind = resolveChatSurfaceModeId(cachedMode.kind);
  const isBuiltin = cachedMode.isBuiltin === true;
  const name = readNonEmptyString(cachedMode.name);
  const label = readNonEmptyString(cachedMode.label) ?? name;
  const customAgentTarget = normalizeAgentIdentifier(readNonEmptyString(cachedMode.customAgentTarget)) || undefined;

  if (!id || !kind || isBuiltin || !name || !label) {
    return undefined;
  }

  const description = readNonEmptyString(cachedMode.description);
  const uri = readNonEmptyString(cachedMode.uri);
  const customTools = readStringArray(cachedMode.customTools);
  const source = readChatResolvedModeSource(cachedMode.source);
  const model = readNonEmptyString(cachedMode.model);
  const argumentHint = readNonEmptyString(cachedMode.argumentHint);
  const target = readChatResolvedModeTarget(cachedMode.target);
  const visibility = readChatResolvedModeVisibility(cachedMode.visibility);
  const enabled = cachedMode.enabled === false ? false : undefined;
  const sessionTypes = readStringArray(cachedMode.sessionTypes);
  const permissionMode = readChatResolvedModePermissionMode(cachedMode.permissionMode);
  const handOffs = readChatResolvedModeHandoffs(cachedMode.handOffs);
  const agents = readStringArray(cachedMode.agents);
  const modeInstructions = readModeInstructions(cachedMode.modeInstructions);

  return {
    id,
    kind,
    isBuiltin: false,
    name,
    label,
    ...(description ? { description } : {}),
    ...(uri ? { uri } : {}),
    ...(customTools ? { customTools } : {}),
    ...(source ? { source } : {}),
    ...(model ? { model } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    ...(target ? { target } : {}),
    ...(visibility ? { visibility } : {}),
    ...(enabled === false ? { enabled: false } : {}),
    ...(sessionTypes ? { sessionTypes } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(handOffs ? { handOffs } : {}),
    ...(agents ? { agents } : {}),
    ...(cachedMode.hidden === true ? { hidden: true } : {}),
    ...(modeInstructions ? { modeInstructions } : {}),
    ...(customAgentTarget ? { customAgentTarget } : {}),
  };
}

function readChatResolvedModeSource(
  value: unknown,
): ChatResolvedModeSource | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.trim();
  return (
    normalizedValue === 'built-in'
    || normalizedValue === 'host'
    || normalizedValue === 'user'
    || normalizedValue === 'project'
    || normalizedValue === 'plugin'
  )
    ? normalizedValue
    : undefined;
}

function readChatResolvedModeTarget(
  value: unknown,
): ChatResolvedModeTarget | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase();
  return (
    normalizedValue === 'aily'
    || normalizedValue === 'undefined'
  )
    ? normalizedValue as ChatResolvedModeTarget
    : undefined;
}

function readChatResolvedModeVisibility(
  value: unknown,
): ChatResolvedModeVisibility | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const visibility = value as {
    readonly userInvocable?: unknown;
    readonly agentInvocable?: unknown;
  };
  return typeof visibility.userInvocable === 'boolean'
    && typeof visibility.agentInvocable === 'boolean'
    ? {
      userInvocable: visibility.userInvocable,
      agentInvocable: visibility.agentInvocable,
    }
    : undefined;
}

function readChatResolvedModePermissionMode(
  value: unknown,
): ChatSessionPermissionMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.trim();
  return (CHAT_SESSION_PERMISSION_MODES as readonly string[]).includes(normalizedValue)
    ? normalizedValue as ChatSessionPermissionMode
    : undefined;
}

function readChatResolvedModeHandoffs(
  value: unknown,
): readonly ChatResolvedModeHandoff[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const handOffs = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }

    const handoff = entry as {
      readonly label?: unknown;
      readonly agent?: unknown;
      readonly prompt?: unknown;
      readonly send?: unknown;
      readonly showContinueOn?: unknown;
      readonly model?: unknown;
    };
    const label = readNonEmptyString(handoff.label);
    const agent = readNonEmptyString(handoff.agent);
    const prompt = readNonEmptyString(handoff.prompt);
    if (!label || !agent || !prompt) {
      return [];
    }

    const send = typeof handoff.send === 'boolean' ? handoff.send : undefined;
    const showContinueOn = typeof handoff.showContinueOn === 'boolean' ? handoff.showContinueOn : undefined;
    const model = readNonEmptyString(handoff.model);

    return [{
      label,
      agent,
      prompt,
      ...(send !== undefined ? { send } : {}),
      ...(showContinueOn !== undefined ? { showContinueOn } : {}),
      ...(model ? { model } : {}),
    }];
  });

  return handOffs.length > 0 ? handOffs : undefined;
}

function readModeInstructions(
  value: ChatAgentModeDefinitionLike['modeInstructions'] | undefined,
): ChatResolvedModeInstructions | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const content = typeof value.content === 'string'
    ? value.content
    : undefined;
  const toolReferences = Array.isArray(value.toolReferences)
    ? [...value.toolReferences]
    : [];
  const metadata = normalizeInstructionMetadata(value.metadata);
  if (content === undefined && toolReferences.length === 0 && !metadata) {
    return undefined;
  }

  return {
    content: content ?? '',
    toolReferences,
    ...(metadata ? { metadata } : {}),
  };
}

function buildModeInstructionsFromSystemPrompt(
  value: unknown,
): ChatResolvedModeInstructions | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return {
    content: value.trim(),
    toolReferences: [],
  };
}

function normalizeInstructionMetadata(
  value: unknown,
): Readonly<Record<string, boolean | string | number>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) => typeof entryValue === 'boolean' || typeof entryValue === 'string' || typeof entryValue === 'number');
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue || undefined;
}

function serializeChatSessionInputModeInstructions(
  mode: Pick<ChatResolvedMode, 'id' | 'kind' | 'isBuiltin' | 'name' | 'modeInstructions' | 'uri'> | null | undefined,
  normalizedKind: ChatSurfaceModeId,
): ChatSessionInputModeInstructions | undefined {
  if (!mode || normalizedKind !== 'agent' || mode.isBuiltin !== false) {
    return undefined;
  }

  const name = readNonEmptyString(mode.name);
  if (!name) {
    return undefined;
  }

  return {
    ...(readNonEmptyString(mode.uri) ?? readNonEmptyString(mode.id)
      ? { uri: readNonEmptyString(mode.uri) ?? readNonEmptyString(mode.id) }
      : {}),
    name,
    content: mode.modeInstructions?.content ?? '',
    ...(mode.modeInstructions?.metadata ? { metadata: { ...mode.modeInstructions.metadata } } : {}),
    isBuiltin: false,
  };
}

function normalizeChatSessionInputModeInstructions(
  value: unknown,
): ChatSessionInputModeInstructions | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const instructions = value as {
    readonly uri?: unknown;
    readonly name?: unknown;
    readonly content?: unknown;
    readonly metadata?: unknown;
    readonly isBuiltin?: unknown;
  };
  const name = readNonEmptyString(instructions.name);
  if (!name) {
    return undefined;
  }

  const uri = readNonEmptyString(instructions.uri);
  const metadata = normalizeInstructionMetadata(instructions.metadata);
  const content = typeof instructions.content === 'string'
    ? instructions.content
    : '';
  const isBuiltin = typeof instructions.isBuiltin === 'boolean'
    ? instructions.isBuiltin
    : undefined;

  return {
    ...(uri ? { uri } : {}),
    name,
    content,
    ...(metadata ? { metadata } : {}),
    ...(isBuiltin !== undefined ? { isBuiltin } : {}),
  };
}
