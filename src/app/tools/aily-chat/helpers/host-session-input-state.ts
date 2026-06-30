import {
  readTurnRequestModeInfo,
  resolveTurnRequestModeKind,
} from 'aily-lex/browser';

import {
  createChatSessionModeDescriptor,
  createChatSessionModeDescriptorFromResolvedMode,
  createChatSessionInputStateFromResolvedMode,
  createChatSessionInputState,
  DEFAULT_CHAT_SESSION_PERMISSION_MODE,
  normalizeChatSessionProviderOptionGroups,
  normalizeChatSelectedMode,
  normalizeChatSessionModeDescriptor,
  normalizeChatSessionInputMode,
  normalizeChatSessionInputState,
  normalizeChatSessionPermissionMode,
  isPlanChatAgentTarget,
  resolveChatModeId,
  type ChatSessionPermissionMode,
  type ChatSessionModeDescriptor,
  type ChatSessionProviderOptionGroup,
  type ChatSessionProviderOptionItem,
  type ChatResolvedMode,
  type ChatSelectedMode,
  type ChatSessionInputState,
} from '../core/chat-mode';
import {
  hasHostSessionExplicitTurnRequestRouting,
  normalizeHostSessionRequestRoutingSummary,
  resolveHostSessionRequestRoutingSummary,
  type HostSessionRequestRoutingSummary,
} from './host-session-request-routing';
import type { HostSessionRecord } from '../services/chat-history.service';

export interface HostSessionSelectedModeResolveOptions {
  readonly resolveModeById?: (modeId: string) => (
    Pick<ChatResolvedMode, 'kind' | 'customAgentTarget'>
    & Partial<Pick<ChatResolvedMode, 'id' | 'isBuiltin' | 'name' | 'modeInstructions' | 'uri'>>
  ) | undefined;
  readonly resolveModeByName?: (modeName: string) => (
    Pick<ChatResolvedMode, 'kind' | 'customAgentTarget'>
    & Partial<Pick<ChatResolvedMode, 'id' | 'isBuiltin' | 'name' | 'modeInstructions' | 'uri'>>
  ) | undefined;
}

export interface HostSessionProviderOptions {
  readonly folderPath: string | null;
  readonly permissionMode: ChatSessionPermissionMode;
  readonly permissionLevel?: string;
  readonly approvalsReviewer?: 'user' | 'auto_review';
  readonly approvalPolicy?: 'on_request' | 'never';
}

export const HOST_SESSION_FOLDER_OPTION_ID = 'folder';
export const HOST_SESSION_PERMISSION_MODE_OPTION_ID = 'permissionMode';
export const HOST_SESSION_APPROVALS_REVIEWER_OPTION_ID = 'approvalsReviewer';

const HOST_SESSION_PERMISSION_MODE_ITEMS: readonly ChatSessionProviderOptionItem[] = [
  { id: 'default', name: 'Ask before edits', slashCommand: 'ask' },
  { id: 'acceptEdits', name: 'Edit automatically', slashCommand: 'edit' },
  { id: 'plan', name: 'Plan mode', slashCommand: 'plan' },
  { id: 'bypassPermissions', name: 'Bypass all permissions', slashCommand: 'yolo' },
];

const HOST_SESSION_APPROVALS_REVIEWER_ITEMS: readonly ChatSessionProviderOptionItem[] = [
  { id: 'user', name: '人工审批 (User)' },
  { id: 'auto_review', name: '自动审查 (Auto Review)' },
];

interface HostSessionMetadataLike {
  readonly projectPath?: unknown;
  readonly mode?: unknown;
  readonly modeDescriptor?: {
    readonly id?: unknown;
    readonly kind?: unknown;
    readonly isBuiltin?: unknown;
    readonly name?: unknown;
    readonly modeInstructions?: {
      readonly uri?: unknown;
      readonly name?: unknown;
      readonly content?: unknown;
      readonly metadata?: unknown;
      readonly isBuiltin?: unknown;
    };
  } | undefined;
  readonly requestRouting?: {
    readonly selectedModeId?: unknown;
    readonly requestModeId?: unknown;
    readonly customAgentTarget?: unknown;
  } | undefined;
  readonly inputState?: {
    readonly mode?: {
      readonly id?: unknown;
      readonly kind?: unknown;
      readonly modeInstructions?: {
        readonly uri?: unknown;
        readonly name?: unknown;
        readonly content?: unknown;
        readonly metadata?: unknown;
        readonly isBuiltin?: unknown;
      };
    };
    readonly groups?: unknown;
  } | undefined;
}

export function buildHostSessionCurrentPickerInputState(
  selectedModeOrModeId: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> | unknown,
  customAgentTargetOrProviderOptions?: unknown,
  maybeProviderOptions?: Partial<HostSessionProviderOptions> | null,
): ChatSessionInputState {
  const selectedMode = isSelectedModeSnapshot(selectedModeOrModeId)
    ? normalizeChatSelectedMode(selectedModeOrModeId)
    : normalizeChatSelectedMode({
        modeId: selectedModeOrModeId,
        customAgentTarget: customAgentTargetOrProviderOptions,
      });

  const providerOptions = isSelectedModeSnapshot(selectedModeOrModeId)
    ? customAgentTargetOrProviderOptions as Partial<HostSessionProviderOptions> | null | undefined
    : maybeProviderOptions;

  return createChatSessionInputState(selectedMode, {
    groups: buildHostSessionProviderOptionGroups(providerOptions),
  });
}

export function buildHostSessionCurrentPickerInputStateFromResolvedMode(
  mode: Pick<ChatResolvedMode, 'id' | 'kind' | 'isBuiltin' | 'name' | 'modeInstructions' | 'uri'> | null | undefined,
  providerOptions?: Partial<HostSessionProviderOptions> | null,
): ChatSessionInputState {
  return createChatSessionInputStateFromResolvedMode(mode, {
    groups: buildHostSessionProviderOptionGroups(providerOptions),
  });
}

export function buildHostSessionCurrentModeDescriptor(
  selectedModeOrModeId: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> | unknown,
  customAgentTarget?: unknown,
): ChatSessionModeDescriptor {
  const selectedMode = isSelectedModeSnapshot(selectedModeOrModeId)
    ? normalizeChatSelectedMode(selectedModeOrModeId)
    : normalizeChatSelectedMode({
        modeId: selectedModeOrModeId,
        customAgentTarget,
      });

  return createChatSessionModeDescriptor(selectedMode);
}

export function buildHostSessionCurrentModeDescriptorFromResolvedMode(
  mode: Pick<ChatResolvedMode, 'id' | 'kind' | 'isBuiltin' | 'name' | 'modeInstructions' | 'uri'> | null | undefined,
): ChatSessionModeDescriptor {
  return createChatSessionModeDescriptorFromResolvedMode(mode);
}

export function buildHostSessionProviderOptionGroups(
  value?: Partial<HostSessionProviderOptions> | null,
): readonly ChatSessionProviderOptionGroup[] {
  const providerOptions = normalizeHostSessionProviderOptions(value);
  const groups: ChatSessionProviderOptionGroup[] = [];
  const folderGroup = createFolderOptionGroup(providerOptions.folderPath);
  if (folderGroup) {
    groups.push(folderGroup);
  }

  groups.push(createPermissionModeOptionGroup(providerOptions.permissionMode));
  groups.push(createApprovalsReviewerOptionGroup(providerOptions.approvalsReviewer));
  return groups;
}

export function resolveHostSessionProviderOptionGroups(
  inputState: HostSessionMetadataLike['inputState'] | ChatSessionInputState | null | undefined,
  fallback?: Partial<HostSessionProviderOptions> | null,
): readonly ChatSessionProviderOptionGroup[] {
  const storedGroups = normalizeChatSessionProviderOptionGroups(inputState);
  const fallbackGroups = buildHostSessionProviderOptionGroups(fallback);
  if (storedGroups.length === 0) {
    return fallbackGroups;
  }

  if (fallbackGroups.length === 0) {
    return storedGroups;
  }

  const storedById = new Map(storedGroups.map((group) => [group.id, group]));
  const mergedGroups = fallbackGroups.map((group) => storedById.get(group.id) ?? group);
  for (const group of storedGroups) {
    if (!fallbackGroups.some((fallbackGroup) => fallbackGroup.id === group.id)) {
      mergedGroups.push(group);
    }
  }

  return mergedGroups;
}

export function normalizeHostSessionProviderOptions(
  value?: Partial<HostSessionProviderOptions> | null,
  fallback?: Partial<HostSessionProviderOptions> | null,
): HostSessionProviderOptions {
  const permissionLevel = normalizeHostSessionPermissionLevel(value?.permissionLevel)
    ?? normalizeHostSessionPermissionLevel(fallback?.permissionLevel);
  const approvalsReviewer = normalizeHostSessionApprovalsReviewer(value?.approvalsReviewer)
    ?? normalizeHostSessionApprovalsReviewer(fallback?.approvalsReviewer);
  const approvalPolicy = normalizeHostSessionApprovalPolicy(value?.approvalPolicy)
    ?? normalizeHostSessionApprovalPolicy(fallback?.approvalPolicy);

  return {
    folderPath: normalizeHostSessionFolderPath(value?.folderPath) ?? normalizeHostSessionFolderPath(fallback?.folderPath) ?? null,
    permissionMode: normalizeChatSessionPermissionMode(
      value?.permissionMode,
      normalizeChatSessionPermissionMode(fallback?.permissionMode, DEFAULT_CHAT_SESSION_PERMISSION_MODE),
    ),
    ...(permissionLevel ? { permissionLevel } : {}),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
  };
}

export function resolveHostSessionProviderOptionsFromMetadata(
  metadata: HostSessionMetadataLike | null | undefined,
): HostSessionProviderOptions {
  const requestRouting = normalizeHostSessionRequestRoutingSummary(metadata?.requestRouting, metadata?.mode);

  return resolveHostSessionProviderOptionsFromInputState(metadata?.inputState, {
    folderPath: normalizeHostSessionFolderPath(metadata?.projectPath),
    permissionMode: DEFAULT_CHAT_SESSION_PERMISSION_MODE,
    permissionLevel: requestRouting.permissionLevel,
    approvalsReviewer: requestRouting.approvalsReviewer,
    approvalPolicy: requestRouting.approvalPolicy,
  });
}

export function resolveHostSessionProviderOptions(
  record: Pick<HostSessionRecord, 'metadata' | 'turnResponses'>,
): HostSessionProviderOptions {
  const requestRouting = resolveHostSessionRequestRoutingSummary(record);

  return normalizeHostSessionProviderOptions(
    resolveHostSessionProviderOptionsFromMetadata(record.metadata),
    requestRouting.permissionLevel || requestRouting.approvalsReviewer || requestRouting.approvalPolicy
      ? {
          ...(requestRouting.permissionLevel ? { permissionLevel: requestRouting.permissionLevel } : {}),
          ...(requestRouting.approvalsReviewer ? { approvalsReviewer: requestRouting.approvalsReviewer } : {}),
          ...(requestRouting.approvalPolicy ? { approvalPolicy: requestRouting.approvalPolicy } : {}),
        }
      : undefined,
  );
}

export function resolveHostSessionProviderOptionsFromInputState(
  inputState: HostSessionMetadataLike['inputState'] | ChatSessionInputState | null | undefined,
  fallback?: Partial<HostSessionProviderOptions> | null,
): HostSessionProviderOptions {
  const normalizedFallback = normalizeHostSessionProviderOptions(undefined, fallback);

  return {
    folderPath: normalizeHostSessionFolderPath(readSelectedGroupOptionId(inputState, HOST_SESSION_FOLDER_OPTION_ID))
      ?? normalizedFallback.folderPath,
    permissionMode: normalizeChatSessionPermissionMode(
      readSelectedGroupOptionId(inputState, HOST_SESSION_PERMISSION_MODE_OPTION_ID),
      normalizedFallback.permissionMode,
    ),
    ...(normalizedFallback.permissionLevel ? { permissionLevel: normalizedFallback.permissionLevel } : {}),
    ...(normalizeHostSessionApprovalsReviewer(readSelectedGroupOptionId(inputState, HOST_SESSION_APPROVALS_REVIEWER_OPTION_ID))
      ?? normalizedFallback.approvalsReviewer
      ? { approvalsReviewer: normalizeHostSessionApprovalsReviewer(readSelectedGroupOptionId(inputState, HOST_SESSION_APPROVALS_REVIEWER_OPTION_ID)) ?? normalizedFallback.approvalsReviewer }
      : {}),
    ...(normalizedFallback.approvalPolicy ? { approvalPolicy: normalizedFallback.approvalPolicy } : {}),
  };
}

export function createHostSessionProviderOptionsKey(
  value?: Partial<HostSessionProviderOptions> | null,
): string {
  const providerOptions = normalizeHostSessionProviderOptions(value);
  const segments = [
    providerOptions.folderPath ?? '',
    providerOptions.permissionMode,
    providerOptions.permissionLevel ?? '',
    providerOptions.approvalsReviewer ?? '',
    providerOptions.approvalPolicy ?? '',
  ];

  while (segments.length > 2 && segments[segments.length - 1] === '') {
    segments.pop();
  }

  return segments.join('::');
}

export function resolveHostSessionSelectedModeFromMetadata(
  metadata: HostSessionMetadataLike | null | undefined,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSelectedMode {
  const requestRouting = normalizeHostSessionRequestRoutingSummary(metadata?.requestRouting, metadata?.mode);
  const modeDescriptor = resolveStoredModeDescriptor(metadata?.modeDescriptor, metadata?.inputState, requestRouting, options);
  if (modeDescriptor) {
    return resolveSelectedModeFromDescriptor(modeDescriptor, requestRouting, options);
  }

  return normalizeChatSelectedMode({
    modeId: requestRouting.selectedModeId,
    customAgentTarget: requestRouting.customAgentTarget,
  });
}

export function resolveHostSessionSummaryModeFromMetadata(
  metadata: HostSessionMetadataLike | null | undefined,
): ChatSelectedMode {
  const requestRouting = normalizeHostSessionRequestRoutingSummary(metadata?.requestRouting, metadata?.mode);
  return normalizeChatSelectedMode({
    modeId: requestRouting.selectedModeId,
    customAgentTarget: requestRouting.customAgentTarget,
  });
}

export function normalizeHostSessionInputStateFromMetadata(
  metadata: HostSessionMetadataLike | null | undefined,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSessionInputState {
  const selectedMode = resolveHostSessionSelectedModeFromMetadata(metadata, options);
  const providerOptions = resolveHostSessionProviderOptionsFromMetadata(metadata);
  const groups = resolveHostSessionProviderOptionGroups(metadata?.inputState, providerOptions);
  const modeDescriptor = resolveStoredModeDescriptor(
    metadata?.modeDescriptor,
    metadata?.inputState,
    normalizeHostSessionRequestRoutingSummary(metadata?.requestRouting, metadata?.mode),
    options,
  );
  if (modeDescriptor) {
    return normalizeChatSessionInputState({
      mode: {
        id: modeDescriptor.id,
        kind: modeDescriptor.kind,
        ...(modeDescriptor.modeInstructions
          ? {
              modeInstructions: {
                ...(modeDescriptor.modeInstructions.uri ? { uri: modeDescriptor.modeInstructions.uri } : {}),
                name: modeDescriptor.modeInstructions.name,
                content: modeDescriptor.modeInstructions.content,
                ...(modeDescriptor.modeInstructions.metadata ? { metadata: { ...modeDescriptor.modeInstructions.metadata } } : {}),
                ...(modeDescriptor.modeInstructions.isBuiltin !== undefined ? { isBuiltin: modeDescriptor.modeInstructions.isBuiltin } : {}),
              },
            }
          : {}),
      },
      groups,
    }, selectedMode);
  }

  return createChatSessionInputState(selectedMode, {
    groups,
  });
}

export function resolveHostSessionModeDescriptorFromMetadata(
  metadata: HostSessionMetadataLike | null | undefined,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSessionModeDescriptor | undefined {
  if (!metadata?.modeDescriptor && !metadata?.inputState && !metadata?.requestRouting) {
    return undefined;
  }

  return resolveStoredModeDescriptor(
    metadata?.modeDescriptor,
    metadata?.inputState,
    normalizeHostSessionRequestRoutingSummary(metadata?.requestRouting, metadata?.mode),
    options,
  );
}

export function resolveHostSessionSelectedMode(
  record: Pick<HostSessionRecord, 'metadata' | 'turnResponses'>,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSelectedMode {
  const requestRouting = resolveHostSessionRequestRoutingSummary(record);
  const modeDescriptor = resolveLatestTurnModeDescriptor(record.turnResponses, options)
    ?? resolveStoredModeDescriptor(record.metadata?.modeDescriptor, record.metadata?.inputState, requestRouting, options);
  const descriptorSelectedMode = modeDescriptor
    ? resolveSelectedModeFromDescriptor(modeDescriptor, requestRouting, options)
    : undefined;
  if (hasHostSessionExplicitTurnRequestRouting(record.turnResponses)) {
    return normalizeChatSelectedMode({
      modeId: requestRouting.selectedModeId,
      customAgentTarget: requestRouting.customAgentTarget ?? descriptorSelectedMode?.customAgentTarget,
    });
  }
  if (modeDescriptor) {
    return descriptorSelectedMode!;
  }

  return normalizeChatSelectedMode({
    modeId: requestRouting.selectedModeId,
    customAgentTarget: requestRouting.customAgentTarget,
  });
}

export function resolveHostSessionInputState(
  record: Pick<HostSessionRecord, 'metadata' | 'turnResponses'>,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSessionInputState {
  const selectedMode = resolveHostSessionSelectedMode(record, options);
  const providerOptions = resolveHostSessionProviderOptions(record);
  const groups = resolveHostSessionProviderOptionGroups(record.metadata?.inputState, providerOptions);
  const modeDescriptor = resolveLatestTurnModeDescriptor(record.turnResponses, options)
    ?? resolveStoredModeDescriptor(
    record.metadata?.modeDescriptor,
    record.metadata?.inputState,
    resolveHostSessionRequestRoutingSummary(record),
    options,
  );
  if (modeDescriptor) {
    return normalizeChatSessionInputState({
      mode: {
        id: modeDescriptor.id,
        kind: modeDescriptor.kind,
        ...(modeDescriptor.modeInstructions
          ? {
              modeInstructions: {
                ...(modeDescriptor.modeInstructions.uri ? { uri: modeDescriptor.modeInstructions.uri } : {}),
                name: modeDescriptor.modeInstructions.name,
                content: modeDescriptor.modeInstructions.content,
                ...(modeDescriptor.modeInstructions.metadata ? { metadata: { ...modeDescriptor.modeInstructions.metadata } } : {}),
                ...(modeDescriptor.modeInstructions.isBuiltin !== undefined ? { isBuiltin: modeDescriptor.modeInstructions.isBuiltin } : {}),
              },
            }
          : {}),
      },
      groups,
    }, selectedMode);
  }

  return createChatSessionInputState(selectedMode, {
    groups,
  });
}

export function resolveHostSessionModeDescriptor(
  record: Pick<HostSessionRecord, 'metadata' | 'turnResponses'>,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSessionModeDescriptor | undefined {
  if (!record.metadata?.modeDescriptor && !record.metadata?.inputState && !record.metadata?.requestRouting && !record.turnResponses?.length) {
    return undefined;
  }

  return resolveLatestTurnModeDescriptor(record.turnResponses, options)
    ?? resolveStoredModeDescriptor(
    record.metadata?.modeDescriptor,
    record.metadata?.inputState,
    resolveHostSessionRequestRoutingSummary(record),
    options,
  );
}

function resolveLatestTurnModeDescriptor(
  turnResponses: HostSessionRecord['turnResponses'],
  options?: HostSessionSelectedModeResolveOptions,
): ChatSessionModeDescriptor | undefined {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return undefined;
  }

  for (let index = turnResponses.length - 1; index >= 0; index -= 1) {
    const metadata = asRecord(turnResponses[index]?.request?.metadata);
    if (!metadata) {
      continue;
    }

    const descriptor = resolveTurnModeDescriptorFromMetadata(metadata, options);
    if (descriptor) {
      return descriptor;
    }
  }

  return undefined;
}

function isSelectedModeSnapshot(
  value: unknown,
): value is Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'modeId' in value;
}

function resolveSelectedModeFromDescriptor(
  modeDescriptor: ChatSessionModeDescriptor,
  requestRouting: HostSessionRequestRoutingSummary,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSelectedMode {
  if (isLegacyFallbackPlanModeDescriptor(modeDescriptor)) {
    return { modeId: 'plan' };
  }

  if (modeDescriptor.kind !== 'agent' || modeDescriptor.isBuiltin !== false) {
    return normalizeChatSelectedMode({ modeId: modeDescriptor.kind });
  }

  const resolvedMode = resolveStoredModeDescriptorById(modeDescriptor, options);
  const customAgentTarget = resolvedMode?.kind === 'agent'
    ? resolvedMode.customAgentTarget
    : undefined;

  return normalizeChatSelectedMode({
    modeId: 'agent',
    customAgentTarget: normalizeHostSessionCustomAgentTarget(
      customAgentTarget,
      modeDescriptor.modeInstructions?.name,
      modeDescriptor.name,
      requestRouting.customAgentTarget,
      modeDescriptor.id,
    ),
  });
}

function resolveStoredSelectedModeFromInputState(
  inputState: HostSessionMetadataLike['inputState'] | undefined,
  requestRouting: HostSessionRequestRoutingSummary,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSelectedMode | undefined {
  const storedMode = readStoredInputMode(inputState);
  if (!storedMode) {
    return undefined;
  }

  const storedBuiltinModeId = resolveChatModeId(storedMode.id);
  const storedModeKind = storedMode.kind ?? storedBuiltinModeId;
  if (storedModeKind && storedModeKind !== 'agent') {
    return normalizeChatSelectedMode({ modeId: storedModeKind });
  }

  if (!storedMode.id || storedBuiltinModeId === 'agent') {
    return normalizeChatSelectedMode({ modeId: 'agent' });
  }

  const resolvedMode = options?.resolveModeById?.(storedMode.id);
  if (resolvedMode) {
    return normalizeChatSelectedMode({
      modeId: resolvedMode.kind,
      customAgentTarget: resolvedMode.kind === 'agent'
        ? resolvedMode.customAgentTarget
        : undefined,
    });
  }

  const resolvedModeByUri = storedMode.modeInstructions?.uri
    ? options?.resolveModeById?.(storedMode.modeInstructions.uri)
    : undefined;
  if (resolvedModeByUri) {
    return normalizeChatSelectedMode({
      modeId: resolvedModeByUri.kind,
      customAgentTarget: resolvedModeByUri.kind === 'agent'
        ? resolvedModeByUri.customAgentTarget
        : undefined,
    });
  }

  const resolvedModeByName = storedMode.modeInstructions?.name
    ? options?.resolveModeByName?.(storedMode.modeInstructions.name)
    : undefined;
  if (resolvedModeByName) {
    return normalizeChatSelectedMode({
      modeId: resolvedModeByName.kind,
      customAgentTarget: resolvedModeByName.kind === 'agent'
        ? resolvedModeByName.customAgentTarget
        : undefined,
    });
  }

  if (storedMode.modeInstructions?.name) {
    return normalizeChatSelectedMode({
      modeId: 'agent',
      customAgentTarget: storedMode.modeInstructions.name,
    });
  }

  if (requestRouting.customAgentTarget) {
    return normalizeChatSelectedMode({
      modeId: 'agent',
      customAgentTarget: requestRouting.customAgentTarget,
    });
  }

  return normalizeChatSelectedMode({
    modeId: 'agent',
    customAgentTarget: storedMode.id,
  });
}

function resolveStoredModeDescriptor(
  value: HostSessionMetadataLike['modeDescriptor'] | undefined,
  inputState: HostSessionMetadataLike['inputState'] | ChatSessionInputState | undefined,
  requestRouting: HostSessionRequestRoutingSummary,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSessionModeDescriptor | undefined {
  const normalizedDescriptor = hydrateStoredModeDescriptor(normalizeChatSessionModeDescriptor(value), options);
  if (normalizedDescriptor) {
    if (isLegacyFallbackPlanModeDescriptor(normalizedDescriptor)) {
      return createChatSessionModeDescriptor({ modeId: 'plan' });
    }

    return normalizedDescriptor;
  }

  const legacySelectedMode = resolveStoredSelectedModeFromInputState(
    inputState as HostSessionMetadataLike['inputState'],
    requestRouting,
    options,
  );
  if (legacySelectedMode) {
    const legacyStoredMode = readStoredInputMode(inputState as HostSessionMetadataLike['inputState']);
    const hydratedLegacyDescriptor = legacyStoredMode
      ? hydrateLegacyModeDescriptor(legacyStoredMode, legacySelectedMode, options)
      : undefined;
    if (hydratedLegacyDescriptor) {
      return hydratedLegacyDescriptor;
    }

    return createChatSessionModeDescriptor(legacySelectedMode);
  }

  return createChatSessionModeDescriptor({
    modeId: requestRouting.selectedModeId,
    customAgentTarget: requestRouting.customAgentTarget,
  });
}

function resolveTurnModeDescriptorFromMetadata(
  metadata: Readonly<Record<string, unknown>>,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSessionModeDescriptor | undefined {
  const modeInfo = readTurnRequestModeInfo(metadata);
  const modeKind = resolveTurnRequestModeKind(modeInfo) ?? resolveChatModeId(metadata['modeId']);
  const isCustomMode = modeInfo?.modeId === 'custom' || modeInfo?.isBuiltin === false;
  const modeUri = typeof modeInfo?.modeInstructions?.uri === 'string' && modeInfo.modeInstructions.uri.trim().length > 0
    ? modeInfo.modeInstructions.uri.trim()
    : undefined;
  const modeName = typeof modeInfo?.modeInstructions?.name === 'string' && modeInfo.modeInstructions.name.trim().length > 0
    ? modeInfo.modeInstructions.name.trim()
    : typeof modeInfo?.modeName === 'string' && modeInfo.modeName.trim().length > 0
      ? modeInfo.modeName.trim()
      : undefined;

  if (isCustomMode) {
    const resolvedMode = (modeUri ? options?.resolveModeById?.(modeUri) : undefined)
      ?? (modeName ? options?.resolveModeByName?.(modeName) : undefined);
    if (resolvedMode) {
      return createChatSessionModeDescriptorFromResolvedMode({
        id: typeof resolvedMode.id === 'string' && resolvedMode.id.trim().length > 0
          ? resolvedMode.id.trim()
          : modeUri ?? modeName ?? 'agent',
        kind: resolvedMode.kind ?? modeKind ?? 'agent',
        isBuiltin: resolvedMode.isBuiltin ?? false,
        name: resolvedMode.name ?? modeName ?? modeUri ?? 'agent',
        modeInstructions: resolvedMode.modeInstructions,
        uri: resolvedMode.uri ?? modeUri,
      });
    }

    if (modeUri || modeName) {
      return {
        id: modeUri ?? modeName!,
        kind: modeKind ?? 'agent',
        isBuiltin: false,
        ...(modeName ? { name: modeName } : {}),
        ...(modeName
          ? {
              modeInstructions: {
                ...(modeUri ? { uri: modeUri } : {}),
                name: modeName,
                content: modeInfo?.modeInstructions?.content ?? '',
                ...(modeInfo?.modeInstructions?.metadata ? { metadata: { ...modeInfo.modeInstructions.metadata } } : {}),
                isBuiltin: false,
              },
            }
          : {}),
      };
    }
  }

  if (modeKind) {
    return createChatSessionModeDescriptorFromResolvedMode({
      id: modeKind,
      kind: modeKind,
      isBuiltin: true,
      name: modeKind,
    });
  }

  return undefined;
}

function readStoredInputMode(
  inputState: HostSessionMetadataLike['inputState'] | undefined,
): ReturnType<typeof normalizeChatSessionInputMode> {
  return normalizeChatSessionInputMode(inputState?.mode);
}

function hydrateLegacyModeDescriptor(
  storedMode: NonNullable<ReturnType<typeof normalizeChatSessionInputMode>>,
  selectedMode: ChatSelectedMode,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSessionModeDescriptor | undefined {
  if (isLegacyFallbackPlanInputMode(storedMode)) {
    return createChatSessionModeDescriptor({ modeId: 'plan' });
  }

  const resolvedMode = resolveStoredModeById(storedMode, options);
  if (!resolvedMode) {
    if (storedMode.kind === 'agent' && storedMode.modeInstructions?.name) {
      return {
        id: storedMode.modeInstructions.uri ?? storedMode.id,
        kind: 'agent',
        isBuiltin: false,
        name: storedMode.modeInstructions.name,
        modeInstructions: {
          ...(storedMode.modeInstructions.uri ? { uri: storedMode.modeInstructions.uri } : {}),
          name: storedMode.modeInstructions.name,
          content: storedMode.modeInstructions.content,
          ...(storedMode.modeInstructions.metadata ? { metadata: storedMode.modeInstructions.metadata } : {}),
          ...(storedMode.modeInstructions.isBuiltin !== undefined ? { isBuiltin: storedMode.modeInstructions.isBuiltin } : {}),
        },
      };
    }

    if (storedMode.kind === 'agent' && storedMode.id) {
      const customAgentTarget = selectedMode.modeId === 'agent'
        ? selectedMode.customAgentTarget
        : undefined;

      return {
        id: storedMode.id,
        kind: 'agent',
        isBuiltin: false,
        ...(customAgentTarget ? { name: customAgentTarget } : {}),
        ...(customAgentTarget
          ? {
              modeInstructions: {
                uri: storedMode.id,
                name: customAgentTarget,
                content: '',
                isBuiltin: false,
              },
            }
          : {}),
      };
    }

    return createChatSessionModeDescriptor(selectedMode);
  }

  const resolvedModeId = typeof resolvedMode.id === 'string' && resolvedMode.id.trim()
    ? resolvedMode.id.trim()
    : storedMode.id;
  const resolvedModeKind = resolvedMode.kind ?? storedMode.kind;
  if (!resolvedModeKind) {
    return createChatSessionModeDescriptor(selectedMode);
  }

  if (resolvedModeKind !== 'agent' || resolvedMode.isBuiltin !== false) {
    return createChatSessionModeDescriptorFromResolvedMode({
      id: resolvedModeId || resolvedModeKind,
      kind: resolvedModeKind,
      isBuiltin: true,
      name: resolvedModeKind,
    });
  }

  const resolvedModeName = typeof resolvedMode.name === 'string' && resolvedMode.name.trim()
    ? resolvedMode.name.trim()
    : storedMode.modeInstructions?.name;
  if (!resolvedModeName) {
    return createChatSessionModeDescriptor(selectedMode);
  }

  return createChatSessionModeDescriptorFromResolvedMode({
    id: resolvedModeId || resolvedModeKind,
    kind: resolvedModeKind,
    isBuiltin: false,
    name: resolvedModeName,
    modeInstructions: resolvedMode.modeInstructions ?? (storedMode.modeInstructions
      ? {
          content: storedMode.modeInstructions.content,
          toolReferences: [],
          ...(storedMode.modeInstructions.metadata ? { metadata: storedMode.modeInstructions.metadata } : {}),
        }
      : undefined),
    uri: resolvedMode.uri ?? storedMode.modeInstructions?.uri,
  });
}

function hydrateStoredModeDescriptor(
  modeDescriptor: ChatSessionModeDescriptor | undefined,
  options?: HostSessionSelectedModeResolveOptions,
): ChatSessionModeDescriptor | undefined {
  if (!modeDescriptor) {
    return undefined;
  }

  if (isLegacyFallbackPlanModeDescriptor(modeDescriptor)) {
    return createChatSessionModeDescriptor({ modeId: 'plan' });
  }

  const resolvedMode = resolveStoredModeDescriptorById(modeDescriptor, options);
  if (!resolvedMode) {
    return modeDescriptor;
  }

  const resolvedModeId = typeof resolvedMode.id === 'string' && resolvedMode.id.trim()
    ? resolvedMode.id.trim()
    : modeDescriptor.id;
  const resolvedModeKind = resolvedMode.kind ?? modeDescriptor.kind;
  if (!resolvedModeKind) {
    return modeDescriptor;
  }

  if (resolvedModeKind !== 'agent' || resolvedMode.isBuiltin !== false) {
    return createChatSessionModeDescriptorFromResolvedMode({
      id: resolvedModeId || resolvedModeKind,
      kind: resolvedModeKind,
      isBuiltin: true,
      name: resolvedModeKind,
    });
  }

  const resolvedModeName = typeof resolvedMode.name === 'string' && resolvedMode.name.trim()
    ? resolvedMode.name.trim()
    : modeDescriptor.modeInstructions?.name ?? modeDescriptor.name;
  if (!resolvedModeName) {
    return modeDescriptor;
  }

  return createChatSessionModeDescriptorFromResolvedMode({
    id: resolvedModeId || resolvedModeKind,
    kind: resolvedModeKind,
    isBuiltin: false,
    name: resolvedModeName,
    modeInstructions: resolvedMode.modeInstructions ?? (modeDescriptor.modeInstructions
      ? {
          content: modeDescriptor.modeInstructions.content,
          toolReferences: [],
          ...(modeDescriptor.modeInstructions.metadata ? { metadata: modeDescriptor.modeInstructions.metadata } : {}),
        }
      : undefined),
    uri: resolvedMode.uri ?? modeDescriptor.modeInstructions?.uri,
  });
}

function isLegacyFallbackPlanModeDescriptor(modeDescriptor: ChatSessionModeDescriptor | undefined): boolean {
  if (!modeDescriptor || modeDescriptor.kind !== 'agent' || modeDescriptor.isBuiltin !== false) {
    return false;
  }

  const instructions = modeDescriptor.modeInstructions;
  if (!isPlanChatAgentTarget(instructions?.name ?? modeDescriptor.name ?? modeDescriptor.id)) {
    return false;
  }

  return isLegacyFallbackPlanInstructions(instructions);
}

function isLegacyFallbackPlanInputMode(
  storedMode: NonNullable<ReturnType<typeof normalizeChatSessionInputMode>>,
): boolean {
  if (storedMode.kind !== 'agent') {
    return false;
  }

  if (!isPlanChatAgentTarget(storedMode.modeInstructions?.name ?? storedMode.id)) {
    return false;
  }

  return isLegacyFallbackPlanInstructions(storedMode.modeInstructions);
}

function isLegacyFallbackPlanInstructions(
  instructions: { readonly content?: string; readonly metadata?: unknown; readonly isBuiltin?: boolean; readonly name?: string } | undefined,
): boolean {
  const metadata = asRecord(instructions?.metadata);
  return (instructions?.content ?? '').trim().length === 0
    && metadata?.['fallbackOnly'] === true
    && metadata?.['disableModelInvocation'] === true;
}

function resolveStoredModeDescriptorById(
  modeDescriptor: ChatSessionModeDescriptor,
  options?: HostSessionSelectedModeResolveOptions,
): ReturnType<NonNullable<HostSessionSelectedModeResolveOptions['resolveModeById']>> | undefined {
  const resolvedById = modeDescriptor.id
    ? options?.resolveModeById?.(modeDescriptor.id)
    : undefined;
  if (resolvedById) {
    return resolvedById;
  }

  const resolvedByUri = modeDescriptor.modeInstructions?.uri
    ? options?.resolveModeById?.(modeDescriptor.modeInstructions.uri)
    : undefined;
  if (resolvedByUri) {
    return resolvedByUri;
  }

  return (modeDescriptor.modeInstructions?.name ?? modeDescriptor.name)
    ? options?.resolveModeByName?.((modeDescriptor.modeInstructions?.name ?? modeDescriptor.name)!)
    : undefined;
}

function resolveStoredModeById(
  storedMode: NonNullable<ReturnType<typeof normalizeChatSessionInputMode>>,
  options?: HostSessionSelectedModeResolveOptions,
): ReturnType<NonNullable<HostSessionSelectedModeResolveOptions['resolveModeById']>> | undefined {
  const resolvedById = storedMode.id
    ? options?.resolveModeById?.(storedMode.id)
    : undefined;
  if (resolvedById) {
    return resolvedById;
  }

  const resolvedByUri = storedMode.modeInstructions?.uri
    ? options?.resolveModeById?.(storedMode.modeInstructions.uri)
    : undefined;
  if (resolvedByUri) {
    return resolvedByUri;
  }

  return storedMode.modeInstructions?.name
    ? options?.resolveModeByName?.(storedMode.modeInstructions.name)
    : undefined;
}

function normalizeHostSessionCustomAgentTarget(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function createFolderOptionGroup(
  folderPath: string | null | undefined,
): ChatSessionProviderOptionGroup | undefined {
  const normalizedFolderPath = normalizeHostSessionFolderPath(folderPath);
  if (!normalizedFolderPath) {
    return undefined;
  }

  const folderItem: ChatSessionProviderOptionItem = {
    id: normalizedFolderPath,
    name: readHostSessionFolderLabel(normalizedFolderPath),
    locked: true,
  };

  return {
    id: HOST_SESSION_FOLDER_OPTION_ID,
    name: 'Folder',
    description: 'Pick Folder',
    items: [folderItem],
    selected: folderItem,
  };
}

function createPermissionModeOptionGroup(
  permissionMode: ChatSessionPermissionMode,
): ChatSessionProviderOptionGroup {
  const selectedItem = HOST_SESSION_PERMISSION_MODE_ITEMS.find((item) => item.id === permissionMode)
    ?? HOST_SESSION_PERMISSION_MODE_ITEMS[0];

  return {
    id: HOST_SESSION_PERMISSION_MODE_OPTION_ID,
    name: 'Permission Mode',
    description: 'Execution mode. Autopilot keeps running tasks and is separate from approval review.',
    kind: 'permissions',
    items: HOST_SESSION_PERMISSION_MODE_ITEMS.map((item) => ({ ...item })),
    selected: { ...selectedItem },
  };
}

function createApprovalsReviewerOptionGroup(
  approvalsReviewer: 'user' | 'auto_review' | undefined,
): ChatSessionProviderOptionGroup {
  const selectedItem = HOST_SESSION_APPROVALS_REVIEWER_ITEMS.find((item) => item.id === approvalsReviewer)
    ?? HOST_SESSION_APPROVALS_REVIEWER_ITEMS[0];

  return {
    id: HOST_SESSION_APPROVALS_REVIEWER_OPTION_ID,
    name: 'Approval Reviewer',
    description: 'Safety reviewer for approval requests. Auto Review does not enable Autopilot execution.',
    kind: 'permissions',
    items: HOST_SESSION_APPROVALS_REVIEWER_ITEMS.map((item) => ({ ...item })),
    selected: { ...selectedItem },
  };
}

function readSelectedGroupOptionId(
  inputState: HostSessionMetadataLike['inputState'] | ChatSessionInputState | null | undefined,
  groupId: string,
): string | undefined {
  const groups = inputState?.groups;
  if (!Array.isArray(groups)) {
    return undefined;
  }

  for (const group of groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      continue;
    }

    const normalizedGroupId = typeof group['id'] === 'string'
      ? group['id'].trim()
      : '';
    if (normalizedGroupId !== groupId) {
      continue;
    }

    const selected = group['selected'];
    if (selected && typeof selected === 'object' && !Array.isArray(selected) && typeof selected['id'] === 'string') {
      const selectedId = selected['id'].trim();
      if (selectedId) {
        return selectedId;
      }
    }

    if (Array.isArray(group['items'])) {
      const firstItem = group['items'][0];
      if (firstItem && typeof firstItem === 'object' && !Array.isArray(firstItem) && typeof firstItem['id'] === 'string') {
        const firstItemId = firstItem['id'].trim();
        if (firstItemId) {
          return firstItemId;
        }
      }
    }
  }

  return undefined;
}

function normalizeHostSessionFolderPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.replace(/\\/g, '/').replace(/\/+$/, '').trim();
  return normalizedValue.length > 0 ? normalizedValue : null;
}

function readHostSessionFolderLabel(folderPath: string): string {
  const normalizedPath = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalizedPath;
}

function normalizeHostSessionPermissionLevel(value: unknown): string | undefined {
  const normalizedValue = typeof value === 'string'
    ? value.trim()
    : '';
  return normalizedValue || undefined;
}

function normalizeHostSessionApprovalsReviewer(value: unknown): 'user' | 'auto_review' | undefined {
  return value === 'auto_review' || value === 'user'
    ? value
    : undefined;
}

function normalizeHostSessionApprovalPolicy(value: unknown): 'on_request' | 'never' | undefined {
  return value === 'never' || value === 'on_request'
    ? value
    : undefined;
}
