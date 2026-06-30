import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { parseAgentDefinition, type AgentSource } from 'aily-lex/browser';

import { normalizeAgentIdentifier } from '../core/agent-identifiers';
import {
  DEFAULT_CHAT_SESSION_TYPE,
  type ChatResolvedModeVisibility,
  createChatResolvedModesCollection,
  deserializeChatResolvedModesCache,
  normalizeChatSessionType,
  resolveChatCurrentMode,
  serializeChatResolvedModesCache,
  type ChatResolvedMode,
  type ChatResolvedModesCollection,
  type ChatRuntimeModeCollection,
} from '../core/chat-mode';
import { AilyHost } from '../core/host';
import { AilyChatConfigService } from './aily-chat-config.service';

const CACHED_CUSTOM_MODES_CONFIG_KEY = 'aiChatCachedCustomModes';
export const CHAT_CUSTOM_MODE_SOURCE_CUSTOM_AGENT_PROVIDER = 'customAgentProvider';
export const CHAT_CUSTOM_MODE_SOURCE_SESSION_CUSTOMIZATION = 'sessionCustomization';
export type ChatCustomModeSourceKind =
  | typeof CHAT_CUSTOM_MODE_SOURCE_CUSTOM_AGENT_PROVIDER
  | typeof CHAT_CUSTOM_MODE_SOURCE_SESSION_CUSTOMIZATION;

export type ChatSessionCustomizationType = 'agent' | 'instructions' | 'skill' | 'hook' | 'plugins';
export type ChatSessionCustomizationItemSource = AgentSource | 'url';

export interface ChatSessionCustomizationProviderMetadata {
  readonly label: string;
  readonly iconId?: string;
  readonly supportedTypes?: readonly ChatSessionCustomizationType[];
}

type ChatRegisteredAgentModeSourceSubscription =
  | { dispose?: () => void; unsubscribe?: () => void }
  | (() => void)
  | void;

export interface ChatCustomAgentProviderSource {
  getAll(): readonly unknown[];
  onDidChange?: (listener: () => void) => ChatRegisteredAgentModeSourceSubscription;
}

export interface ChatSessionCustomizationItem {
  readonly type: ChatSessionCustomizationType;
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly sessionTypes?: readonly string[];
  readonly groupKey?: string;
  readonly badge?: string;
  readonly badgeTooltip?: string;
  readonly source?: ChatSessionCustomizationItemSource;
}

export interface ChatSessionCustomizationAgentCatalogEntry {
  readonly target: string;
  readonly label: string;
  readonly description?: string;
  readonly uri: string;
  readonly sessionTypes?: readonly string[];
  readonly visibility?: ChatResolvedModeVisibility;
  readonly enabled?: boolean;
  readonly hidden?: boolean;
  readonly source?: ChatSessionCustomizationItemSource;
}

export interface ChatSessionCustomizationItemProvider {
  provideChatSessionCustomizations():
    | readonly ChatSessionCustomizationItem[]
    | undefined
    | PromiseLike<readonly ChatSessionCustomizationItem[] | undefined>;
  onDidChange?: (listener: () => void) => ChatRegisteredAgentModeSourceSubscription;
}

export interface ChatSessionCustomizationProviderBinding {
  readonly sessionType?: string;
  readonly metadata: ChatSessionCustomizationProviderMetadata;
  readonly itemProvider: ChatSessionCustomizationItemProvider;
}

export interface ChatSessionCustomizationContentProvider {
  provideChatSessionCustomizationContent(
    uri: string,
  ): Promise<string | undefined> | string | undefined;
}

function disposeRegisteredAgentModeSourceSubscription(
  subscription: ChatRegisteredAgentModeSourceSubscription | null,
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

function tryResolveFilePathFromUri(uri: string): string | undefined {
  const normalizedUri = uri.trim();
  if (!normalizedUri) {
    return undefined;
  }

  try {
    const parsed = new URL(normalizedUri);
    if (parsed.protocol !== 'file:') {
      return undefined;
    }

    let filePath = decodeURIComponent(parsed.pathname);
    if (parsed.host) {
      filePath = `//${parsed.host}${filePath}`;
    }

    if (/^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }

    return filePath;
  } catch {
    return undefined;
  }
}

@Injectable({ providedIn: 'root' })
export class ChatRuntimeModeService {
  private _runtimeModeCollection: ChatResolvedModesCollection = createChatResolvedModesCollection();
  private _currentSessionType = DEFAULT_CHAT_SESSION_TYPE;
  private readonly didChangeSubject = new Subject<void>();
  private readonly runtimeModeCollectionView: ChatRuntimeModeCollection = this.createRuntimeModeCollectionView();
  private readonly customAgentProviderModes = new Map<string, unknown>();
  private readonly customizationHarnessAgentModes = new Map<string, unknown>();
  private _pendingRefresh = Promise.resolve();
  private boundCustomAgentProviderSource: ChatCustomAgentProviderSource | null = null;
  private boundCustomAgentProviderSourceSubscription: ChatRegisteredAgentModeSourceSubscription | null = null;
  private customAgentProviderBindingGeneration = 0;
  private boundSessionCustomizationProviders: readonly ChatSessionCustomizationProviderBinding[] = [];
  private boundSessionCustomizationProvider: ChatSessionCustomizationProviderBinding | null = null;
  private boundSessionCustomizationProviderSubscription: ChatRegisteredAgentModeSourceSubscription | null = null;
  private sessionCustomizationBindingGeneration = 0;
  private boundSessionCustomizationContentProvider: ChatSessionCustomizationContentProvider | null = null;
  private sessionCustomizationContentBindingGeneration = 0;
  private useCustomizationHarnessForCustomAgents = false;
  private hasSessionCustomizationItemProvider = false;
  private activeCustomModeSourceState: ChatCustomModeSourceKind = CHAT_CUSTOM_MODE_SOURCE_CUSTOM_AGENT_PROVIDER;
  private activeSessionCustomizationProviderMetadataState: ChatSessionCustomizationProviderMetadata | undefined;
  private activeSessionCustomizationAgentEntriesState: readonly ChatSessionCustomizationAgentCatalogEntry[] = [];

  constructor(
    private readonly ailyChatConfigService?: AilyChatConfigService,
  ) {
    this.loadCachedCustomModes();
    this.useCustomizationHarnessForCustomAgents = this.readUseCustomizationHarnessForCustomAgents();
    this.ailyChatConfigService?.configChanged$.subscribe(() => {
      const nextUseCustomizationHarness = this.readUseCustomizationHarnessForCustomAgents();
      if (nextUseCustomizationHarness === this.useCustomizationHarnessForCustomAgents) {
        return;
      }

      this.useCustomizationHarnessForCustomAgents = nextUseCustomizationHarness;
      this.refreshRuntimeModeCollection();
    });
  }

  get runtimeModeCollection(): ChatRuntimeModeCollection {
    return this.runtimeModeCollectionView;
  }

  get availableResolvedCustomModes(): readonly ChatResolvedMode[] {
    return this._runtimeModeCollection.custom;
  }

  setCurrentSessionType(sessionType: unknown): void {
    const normalizedSessionType = normalizeChatSessionType(sessionType);
    if (this._currentSessionType === normalizedSessionType) {
      return;
    }

    this._currentSessionType = normalizedSessionType;
    if (this.boundSessionCustomizationProviders.length > 0) {
      void this.activateBoundSessionCustomizationProviderForCurrentSessionType();
      return;
    }

    this.refreshRuntimeModeCollection();
  }

  findResolvedModeById(modeId: string): ChatResolvedMode | undefined {
    return this._runtimeModeCollection.findModeById(modeId);
  }

  findResolvedModeByName(modeName: string): ChatResolvedMode | undefined {
    return this._runtimeModeCollection.findModeByName(modeName);
  }

  findResolvedModeByCustomAgentTarget(agentTarget: string | null | undefined): ChatResolvedMode | undefined {
    const normalizedAgentTarget = normalizeAgentIdentifier(agentTarget);
    if (!normalizedAgentTarget) {
      return undefined;
    }

    return this._runtimeModeCollection.custom.find(mode => mode.customAgentTarget === normalizedAgentTarget);
  }

  getRuntimeAgentModeDefinition(agentId: string | null | undefined): unknown {
    const normalizedAgentId = normalizeAgentIdentifier(agentId);
    if (!normalizedAgentId) {
      return undefined;
    }

    return this.getActiveAgentModes().get(normalizedAgentId);
  }

  setCustomAgentProviderModes(agentModes: readonly unknown[] | PromiseLike<readonly unknown[]>): Promise<void> {
    this.customAgentProviderBindingGeneration += 1;
    this.detachCustomAgentProviderSource();
    if (Array.isArray(agentModes)) {
      this.applyCustomAgentProviderModes(agentModes);
      this._pendingRefresh = Promise.resolve();
      return this._pendingRefresh;
    }
    return this.applyCustomAgentProviderModesRefresh(Promise.resolve(agentModes));
  }

  bindCustomAgentProviderSource(
    agentModeSource: ChatCustomAgentProviderSource | PromiseLike<ChatCustomAgentProviderSource | null> | null,
  ): Promise<void> {
    const bindingGeneration = ++this.customAgentProviderBindingGeneration;
    const refreshPromise = Promise.resolve(agentModeSource)
      .then((resolvedSource) => {
        if (bindingGeneration !== this.customAgentProviderBindingGeneration) {
          return;
        }

        this.detachCustomAgentProviderSource();
        this.boundCustomAgentProviderSource = resolvedSource;
        if (this.boundCustomAgentProviderSource?.onDidChange) {
          const subscription = this.boundCustomAgentProviderSource.onDidChange(() => {
            void this.refreshFromBoundCustomAgentProviderSource();
          });
          if (bindingGeneration === this.customAgentProviderBindingGeneration) {
            this.boundCustomAgentProviderSourceSubscription = subscription ?? null;
          } else {
            disposeRegisteredAgentModeSourceSubscription(subscription ?? null);
          }
        }

        return this.refreshFromBoundCustomAgentProviderSource(bindingGeneration);
      })
      .catch(() => undefined);
    this._pendingRefresh = refreshPromise.then(() => undefined);
    return this._pendingRefresh;
  }

  setSessionCustomizationItems(
    items: readonly ChatSessionCustomizationItem[] | PromiseLike<readonly ChatSessionCustomizationItem[]>,
  ): Promise<void> {
    this.sessionCustomizationBindingGeneration += 1;
    this.boundSessionCustomizationProviders = [];
    this.detachSessionCustomizationProvider();
    return this.applySessionCustomizationItemsRefresh(Promise.resolve(items), true);
  }

  bindSessionCustomizationProvider(
    providerBinding: ChatSessionCustomizationProviderBinding | PromiseLike<ChatSessionCustomizationProviderBinding | null> | null,
  ): Promise<void> {
    const providerBindingsPromise = Promise.resolve(providerBinding).then((resolvedProviderBinding) => {
      return resolvedProviderBinding ? [resolvedProviderBinding] : [];
    });
    return this.bindSessionCustomizationProviders(providerBindingsPromise);
  }

  bindSessionCustomizationProviders(
    providerBindings: readonly ChatSessionCustomizationProviderBinding[] | PromiseLike<readonly ChatSessionCustomizationProviderBinding[] | null> | null,
  ): Promise<void> {
    const bindingGeneration = ++this.sessionCustomizationBindingGeneration;
    const refreshPromise = Promise.resolve(providerBindings)
      .then((resolvedProviderBindings) => {
        if (bindingGeneration !== this.sessionCustomizationBindingGeneration) {
          return;
        }

        this.boundSessionCustomizationProviders = Array.isArray(resolvedProviderBindings)
          ? resolvedProviderBindings.filter((entry): entry is ChatSessionCustomizationProviderBinding => !!entry?.itemProvider)
          : [];
        return this.activateBoundSessionCustomizationProviderForCurrentSessionType(bindingGeneration, true);
      })
      .catch(() => undefined);
    this._pendingRefresh = refreshPromise.then(() => undefined);
    return this._pendingRefresh;
  }

  bindSessionCustomizationContentProvider(
    contentProvider: ChatSessionCustomizationContentProvider | PromiseLike<ChatSessionCustomizationContentProvider | null> | null,
  ): Promise<void> {
    const bindingGeneration = ++this.sessionCustomizationContentBindingGeneration;
    const refreshPromise = Promise.resolve(contentProvider)
      .then((resolvedProvider) => {
        if (bindingGeneration !== this.sessionCustomizationContentBindingGeneration) {
          return;
        }

        this.boundSessionCustomizationContentProvider = resolvedProvider;
        if (this.boundSessionCustomizationProvider) {
          return this.refreshFromBoundSessionCustomizationProvider();
        }
      })
      .catch(() => undefined);
    this._pendingRefresh = refreshPromise.then(() => undefined);
    return this._pendingRefresh;
  }

  get activeCustomModeSource(): ChatCustomModeSourceKind {
    return this.activeCustomModeSourceState;
  }

  get activeSessionCustomizationProviderMetadata(): ChatSessionCustomizationProviderMetadata | undefined {
    return this.activeSessionCustomizationProviderMetadataState;
  }

  get activeSessionCustomizationAgentEntries(): readonly ChatSessionCustomizationAgentCatalogEntry[] {
    return this.activeSessionCustomizationAgentEntriesState;
  }

  private activateBoundSessionCustomizationProviderForCurrentSessionType(
    bindingGeneration = this.sessionCustomizationBindingGeneration,
    forceRefresh = false,
  ): Promise<void> | void {
    if (bindingGeneration !== this.sessionCustomizationBindingGeneration) {
      return;
    }

    const nextProviderBinding = this.selectSessionCustomizationProviderBindingForCurrentSessionType();
    const didProviderChange = this.boundSessionCustomizationProvider !== nextProviderBinding;

    if (didProviderChange) {
      this.detachSessionCustomizationProvider();
      this.boundSessionCustomizationProvider = nextProviderBinding;
    }

    this.hasSessionCustomizationItemProvider = !!nextProviderBinding;
    if (!nextProviderBinding) {
      this.replaceSessionCustomizationAgentModes([], false, [], undefined);
      return;
    }

    if (didProviderChange && nextProviderBinding.itemProvider.onDidChange) {
      const subscription = nextProviderBinding.itemProvider.onDidChange(() => {
        void this.refreshFromBoundSessionCustomizationProvider();
      });
      if (bindingGeneration === this.sessionCustomizationBindingGeneration) {
        this.boundSessionCustomizationProviderSubscription = subscription ?? null;
      } else {
        disposeRegisteredAgentModeSourceSubscription(subscription ?? null);
      }
    }

    if (didProviderChange || forceRefresh) {
      return this.refreshFromBoundSessionCustomizationProvider(bindingGeneration);
    }

    this.refreshRuntimeModeCollection();
  }

  private selectSessionCustomizationProviderBindingForCurrentSessionType(): ChatSessionCustomizationProviderBinding | null {
    const exactMatch = this.boundSessionCustomizationProviders.find((entry) => {
      return normalizeChatSessionType(entry.sessionType) === this._currentSessionType;
    });
    if (exactMatch) {
      return exactMatch;
    }

    return this.boundSessionCustomizationProviders.find((entry) => !entry.sessionType) ?? null;
  }

  private createRuntimeModeCollectionView(): ChatRuntimeModeCollection {
    const service = this;

    return {
      get builtin() {
        return service._runtimeModeCollection.builtin;
      },
      get custom() {
        return service._runtimeModeCollection.custom;
      },
      findModeById(modeId: string): ChatResolvedMode | undefined {
        return service._runtimeModeCollection.findModeById(modeId);
      },
      findModeByName(modeName: string): ChatResolvedMode | undefined {
        return service._runtimeModeCollection.findModeByName(modeName);
      },
      onDidChange: service.didChangeSubject.asObservable(),
      waitForRefresh(): Promise<void> {
        return service._pendingRefresh;
      },
    };
  }

  private detachCustomAgentProviderSource(): void {
    disposeRegisteredAgentModeSourceSubscription(this.boundCustomAgentProviderSourceSubscription);
    this.boundCustomAgentProviderSourceSubscription = null;
    this.boundCustomAgentProviderSource = null;
  }

  private detachSessionCustomizationProvider(): void {
    disposeRegisteredAgentModeSourceSubscription(this.boundSessionCustomizationProviderSubscription);
    this.boundSessionCustomizationProviderSubscription = null;
    this.boundSessionCustomizationProvider = null;
  }

  private refreshFromBoundCustomAgentProviderSource(
    bindingGeneration = this.customAgentProviderBindingGeneration,
  ): Promise<void> {
    if (!this.boundCustomAgentProviderSource) {
      this._pendingRefresh = Promise.resolve();
      return this._pendingRefresh;
    }

    const refreshPromise = Promise.resolve()
      .then(() => {
        if (bindingGeneration !== this.customAgentProviderBindingGeneration || !this.boundCustomAgentProviderSource) {
          return;
        }
        this.applyCustomAgentProviderModes(this.boundCustomAgentProviderSource.getAll());
      })
      .catch(() => undefined);
    this._pendingRefresh = refreshPromise.then(() => undefined);
    return this._pendingRefresh;
  }

  private refreshFromBoundSessionCustomizationProvider(
    bindingGeneration = this.sessionCustomizationBindingGeneration,
  ): Promise<void> {
    if (!this.boundSessionCustomizationProvider) {
      this._pendingRefresh = Promise.resolve();
      return this._pendingRefresh;
    }

    const refreshPromise = Promise.resolve()
      .then(() => this.boundSessionCustomizationProvider?.itemProvider.provideChatSessionCustomizations())
      .then((items) => {
        if (bindingGeneration !== this.sessionCustomizationBindingGeneration || !this.boundSessionCustomizationProvider) {
          return;
        }

        return this.applySessionCustomizationItems(
          items ?? [],
          true,
          this.boundSessionCustomizationProvider.metadata,
        );
      })
      .catch(() => undefined);
    this._pendingRefresh = refreshPromise.then(() => undefined);
    return this._pendingRefresh;
  }

  private applyCustomAgentProviderModesRefresh(agentModesPromise: Promise<readonly unknown[]>): Promise<void> {
    const refreshPromise = agentModesPromise
      .then((agentModes) => {
        this.applyCustomAgentProviderModes(agentModes);
      })
      .catch(() => undefined);
    this._pendingRefresh = refreshPromise.then(() => undefined);
    return this._pendingRefresh;
  }

  private applySessionCustomizationItemsRefresh(
    itemsPromise: Promise<readonly ChatSessionCustomizationItem[]>,
    hasSource: boolean,
  ): Promise<void> {
    const refreshPromise = itemsPromise
      .then((items) => {
        return this.applySessionCustomizationItems(items, hasSource);
      })
      .catch(() => undefined);
    this._pendingRefresh = refreshPromise.then(() => undefined);
    return this._pendingRefresh;
  }

  private applyCustomAgentProviderModes(agentModes: readonly unknown[]): void {
    this.replaceAgentModes(this.customAgentProviderModes, agentModes);
    this.refreshRuntimeModeCollection();
  }

  private async applySessionCustomizationItems(
    items: readonly ChatSessionCustomizationItem[],
    hasSource: boolean,
    metadata?: ChatSessionCustomizationProviderMetadata,
  ): Promise<void> {
    const filteredItems = filterSessionCustomizationItemsBySupportedTypes(items, metadata);
    const agentProjections = await Promise.all(
      filteredItems.map((item) => this.resolveSessionCustomizationAgentProjection(item)),
    );
    const agentModes = agentProjections
      .map(projection => projection.mode)
      .filter((agentMode): agentMode is Record<string, unknown> => (
        !!agentMode
        && typeof agentMode === 'object'
        && !Array.isArray(agentMode)
      ));
    const agentEntries = agentProjections
      .map(projection => projection.entry)
      .filter((entry): entry is ChatSessionCustomizationAgentCatalogEntry => !!entry);
    this.replaceSessionCustomizationAgentModes(agentModes, hasSource, agentEntries, metadata);
  }

  private replaceSessionCustomizationAgentModes(
    agentModes: readonly unknown[],
    hasSource: boolean,
    agentEntries: readonly ChatSessionCustomizationAgentCatalogEntry[] = [],
    metadata?: ChatSessionCustomizationProviderMetadata,
  ): void {
    this.hasSessionCustomizationItemProvider = hasSource;
    this.replaceAgentModes(this.customizationHarnessAgentModes, agentModes);
    const sourceChanged = this.replaceActiveCustomModeSource(this.getActiveCustomModeSource());
    const metadataChanged = this.replaceSessionCustomizationProviderMetadata(metadata);
    const catalogChanged = this.replaceSessionCustomizationAgentEntries(agentEntries);
    const modesChanged = this.refreshRuntimeModeCollection();
    if ((sourceChanged || metadataChanged || catalogChanged) && !modesChanged) {
      this.didChangeSubject.next();
    }
  }

  private replaceActiveCustomModeSource(source: ChatCustomModeSourceKind): boolean {
    if (this.activeCustomModeSourceState === source) {
      return false;
    }

    this.activeCustomModeSourceState = source;
    return true;
  }

  private replaceSessionCustomizationProviderMetadata(
    metadata: ChatSessionCustomizationProviderMetadata | undefined,
  ): boolean {
    const normalizedMetadata = metadata
      ? {
        label: metadata.label,
        ...(metadata.iconId ? { iconId: metadata.iconId } : {}),
        ...(metadata.supportedTypes ? { supportedTypes: [...metadata.supportedTypes] } : {}),
      }
      : undefined;
    if (JSON.stringify(this.activeSessionCustomizationProviderMetadataState) === JSON.stringify(normalizedMetadata)) {
      return false;
    }

    this.activeSessionCustomizationProviderMetadataState = normalizedMetadata;
    return true;
  }

  private async resolveSessionCustomizationAgentProjection(
    item: ChatSessionCustomizationItem,
  ): Promise<{ mode?: Record<string, unknown>; entry?: ChatSessionCustomizationAgentCatalogEntry }> {
    if (item.type !== 'agent') {
      return {};
    }

    const normalizedUri = item.uri.trim();
    if (!normalizedUri) {
      return {};
    }

    const content = await this.tryReadSessionCustomizationItemContent(normalizedUri);
    const parsed = typeof content === 'string'
      ? parseSessionCustomizationAgentDefinition(content, item, normalizedUri)
      : undefined;

    return {
      ...(parsed ? { mode: parsed } : {}),
      entry: buildSessionCustomizationAgentCatalogEntry(item, normalizedUri, parsed),
    };
  }

  private replaceSessionCustomizationAgentEntries(
    entries: readonly ChatSessionCustomizationAgentCatalogEntry[],
  ): boolean {
    const nextEntries = normalizeSessionCustomizationAgentCatalogEntries(entries);
    if (JSON.stringify(this.activeSessionCustomizationAgentEntriesState) === JSON.stringify(nextEntries)) {
      return false;
    }

    this.activeSessionCustomizationAgentEntriesState = nextEntries;
    return true;
  }

  private async tryReadSessionCustomizationItemContent(uri: string): Promise<string | undefined> {
    try {
      const content = await Promise.resolve(
        this.boundSessionCustomizationContentProvider?.provideChatSessionCustomizationContent(uri),
      );
      if (typeof content === 'string') {
        return content;
      }
    } catch {
      // Fall through to the host editor/document seam.
    }

    const host = AilyHost.get();

    try {
      const documentContent = await Promise.resolve(host.editor?.readTextDocument?.(uri));
      if (typeof documentContent === 'string') {
        return documentContent;
      }
    } catch {
      // Fall through to file-backed resolution.
    }

    const filePath = tryResolveFilePathFromUri(uri);
    if (!filePath) {
      return undefined;
    }

    try {
      if (typeof host.fs.readFile === 'function') {
        return await host.fs.readFile(filePath, 'utf-8');
      }

      return host.fs.readFileSync(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  private replaceAgentModes(target: Map<string, unknown>, agentModes: readonly unknown[]): void {
    const nextRegisteredAgentModes = new Map<string, unknown>();
    for (const agentMode of agentModes) {
      const agentId = this.readRegisteredAgentModeId(agentMode);
      if (agentId) {
        nextRegisteredAgentModes.set(agentId, agentMode);
      }
    }

    target.clear();
    for (const [agentId, agentMode] of nextRegisteredAgentModes.entries()) {
      target.set(agentId, agentMode);
    }
  }

  private refreshRuntimeModeCollection(): boolean {
    const nextRuntimeModeCollection = this.buildRuntimeModeCollection(this.getActiveAgentModes());
    const previousCache = JSON.stringify(serializeChatResolvedModesCache(this._runtimeModeCollection.custom));
    const nextCache = JSON.stringify(serializeChatResolvedModesCache(nextRuntimeModeCollection.custom));
    const sourceChanged = this.replaceActiveCustomModeSource(this.getActiveCustomModeSource());

    this._runtimeModeCollection = nextRuntimeModeCollection;

    if (previousCache !== nextCache) {
      this.saveCachedCustomModes();
      this.didChangeSubject.next();
      return true;
    }

    if (sourceChanged) {
      this.didChangeSubject.next();
      return true;
    }

    return false;
  }

  private getActiveCustomModeSource(): ChatCustomModeSourceKind {
    return this.useCustomizationHarnessForCustomAgents && this.hasSessionCustomizationItemProvider
      ? CHAT_CUSTOM_MODE_SOURCE_SESSION_CUSTOMIZATION
      : CHAT_CUSTOM_MODE_SOURCE_CUSTOM_AGENT_PROVIDER;
  }

  private getActiveAgentModes(): ReadonlyMap<string, unknown> {
    return this.getActiveCustomModeSource() === CHAT_CUSTOM_MODE_SOURCE_SESSION_CUSTOMIZATION
      ? this.customizationHarnessAgentModes
      : this.customAgentProviderModes;
  }

  private readUseCustomizationHarnessForCustomAgents(): boolean {
    return this.ailyChatConfigService?.useChatSessionCustomizationsForCustomAgents === true;
  }

  private buildRuntimeModeCollection(agentModes: ReadonlyMap<string, unknown>): ChatResolvedModesCollection {
    const customModes = Array.from(agentModes.entries())
      .map(([agentId, agentMode]) => resolveChatCurrentMode(
        {
          modeId: 'agent',
          customAgentTarget: agentId,
        },
        {
          resolveAgentModeDefinition: () => agentMode,
        },
      ))
      .filter((mode): mode is ChatResolvedMode => !mode.isBuiltin)
      .filter((mode) => mode.enabled !== false)
      .filter((mode) => mode.visibility?.userInvocable !== false)
      .filter((mode) => matchesRuntimeModeSessionType(mode.sessionTypes, this._currentSessionType));

    return createChatResolvedModesCollection(customModes);
  }

  private loadCachedCustomModes(): void {
    const configData = AilyHost.get().config.data;
    const cachedCustomModes = deserializeChatResolvedModesCache(
      configData?.[CACHED_CUSTOM_MODES_CONFIG_KEY],
    );
    this._runtimeModeCollection = createChatResolvedModesCollection(cachedCustomModes);
  }

  private saveCachedCustomModes(): void {
    const config = AilyHost.get().config;
    if (!config.data) {
      return;
    }

    const nextCache = serializeChatResolvedModesCache(this._runtimeModeCollection.custom);
    const previousCache = serializeChatResolvedModesCache(
      deserializeChatResolvedModesCache(config.data[CACHED_CUSTOM_MODES_CONFIG_KEY]),
    );
    if (JSON.stringify(previousCache) === JSON.stringify(nextCache)) {
      return;
    }

    config.data[CACHED_CUSTOM_MODES_CONFIG_KEY] = nextCache;
    config.save?.();
  }

  private readRegisteredAgentModeId(agentMode: unknown): string | undefined {
    if (!agentMode || typeof agentMode !== 'object' || Array.isArray(agentMode)) {
      return undefined;
    }

    const candidate = agentMode as { readonly agentType?: unknown; readonly name?: unknown };
    const rawAgentId = typeof candidate.agentType === 'string' && candidate.agentType.trim()
      ? candidate.agentType
      : typeof candidate.name === 'string' && candidate.name.trim()
        ? candidate.name
        : undefined;
    return normalizeAgentIdentifier(rawAgentId) || undefined;
  }
}

function normalizeAgentCustomizationSource(
  source: ChatSessionCustomizationItemSource | undefined,
): AgentSource {
  if (source === 'project' || source === 'user' || source === 'host') {
    return source;
  }

  return 'host';
}

function filterSessionCustomizationItemsBySupportedTypes(
  items: readonly ChatSessionCustomizationItem[],
  metadata?: ChatSessionCustomizationProviderMetadata,
): readonly ChatSessionCustomizationItem[] {
  const supportedTypes = metadata?.supportedTypes;
  if (!Array.isArray(supportedTypes) || supportedTypes.length === 0) {
    return items;
  }

  const allowedTypes = new Set(supportedTypes);
  return items.filter(item => allowedTypes.has(item.type));
}

function matchesRuntimeModeSessionType(
  sessionTypes: readonly string[] | undefined,
  sessionType: string | undefined,
): boolean {
  if (!Array.isArray(sessionTypes) || sessionTypes.length === 0) {
    return true;
  }

  const normalizedSessionType = normalizeChatSessionType(sessionType);
  return sessionTypes.some((candidate) => normalizeChatSessionType(candidate) === normalizedSessionType);
}

function buildSessionCustomizationAgentCatalogEntry(
  item: ChatSessionCustomizationItem,
  uri: string,
  parsed?: Record<string, unknown>,
): ChatSessionCustomizationAgentCatalogEntry | undefined {
  const rawTarget = typeof parsed?.['agentType'] === 'string' && parsed['agentType'].trim()
    ? parsed['agentType'].trim()
    : typeof item.name === 'string' && item.name.trim()
      ? item.name.trim()
      : deriveSessionCustomizationAgentName(uri);
  const target = normalizeAgentIdentifier(rawTarget);
  if (!target) {
    return undefined;
  }

  const label = typeof parsed?.['name'] === 'string' && parsed['name'].trim()
    ? parsed['name'].trim()
    : typeof item.name === 'string' && item.name.trim()
      ? item.name.trim()
      : target;
  const description = typeof parsed?.['description'] === 'string' && parsed['description'].trim()
    ? parsed['description'].trim()
    : typeof item.description === 'string' && item.description.trim()
      ? item.description.trim()
      : undefined;
  const sessionTypes = readFrontmatterStringArray(parsed?.['sessionTypes'])
    ?? readFrontmatterStringArray(item.sessionTypes);
  const visibility = readSessionCustomizationAgentVisibility(parsed?.['visibility']);
  const enabled = parsed?.['enabled'] === false ? false : undefined;
  const hidden = parsed?.['hidden'] === true ? true : undefined;

  return {
    target,
    label,
    uri,
    ...(description ? { description } : {}),
    ...(sessionTypes ? { sessionTypes } : {}),
    ...(visibility ? { visibility } : {}),
    ...(enabled === false ? { enabled: false } : {}),
    ...(hidden === true ? { hidden: true } : {}),
    ...(item.source ? { source: item.source } : {}),
  };
}

function readSessionCustomizationAgentVisibility(
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

function normalizeSessionCustomizationAgentCatalogEntries(
  entries: readonly ChatSessionCustomizationAgentCatalogEntry[],
): readonly ChatSessionCustomizationAgentCatalogEntry[] {
  const entryByTarget = new Map<string, ChatSessionCustomizationAgentCatalogEntry>();

  for (const entry of entries) {
    const target = normalizeAgentIdentifier(entry.target);
    if (!target) {
      continue;
    }

    const existing = entryByTarget.get(target);
    if (!existing) {
      entryByTarget.set(target, {
        target,
        label: entry.label?.trim() || target,
        uri: entry.uri,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.sessionTypes ? { sessionTypes: [...entry.sessionTypes] } : {}),
        ...(entry.visibility ? { visibility: { ...entry.visibility } } : {}),
        ...(entry.enabled === false ? { enabled: false } : {}),
        ...(entry.hidden === true ? { hidden: true } : {}),
        ...(entry.source ? { source: entry.source } : {}),
      });
      continue;
    }

    entryByTarget.set(target, {
      ...existing,
      label: existing.label || entry.label || target,
      description: existing.description ?? entry.description,
      sessionTypes: existing.sessionTypes ?? entry.sessionTypes,
      visibility: existing.visibility ?? entry.visibility,
      enabled: existing.enabled ?? entry.enabled,
      hidden: existing.hidden ?? entry.hidden,
      source: existing.source ?? entry.source,
    });
  }

  return Array.from(entryByTarget.values())
    .sort((left, right) => left.label.localeCompare(right.label));
}

function parseSessionCustomizationAgentDefinition(
  content: string,
  item: ChatSessionCustomizationItem,
  uri: string,
): Record<string, unknown> | undefined {
  const source = normalizeAgentCustomizationSource(item.source);
  const itemName = typeof item.name === 'string' && item.name.trim()
    ? item.name.trim()
    : undefined;
  const lexDefinition = parseAgentDefinition(
    content,
    source,
    { uri },
  ) as unknown as Record<string, unknown> | null;
  if (!lexDefinition) {
    return undefined;
  }

  const lexName = typeof lexDefinition?.['name'] === 'string' && lexDefinition['name'].trim()
    ? lexDefinition['name'].trim()
    : undefined;
  const lexAgentType = typeof lexDefinition?.['agentType'] === 'string' && lexDefinition['agentType'].trim()
    ? lexDefinition['agentType'].trim()
    : undefined;
  const description = (typeof lexDefinition?.['description'] === 'string' && lexDefinition['description'].trim() ? lexDefinition['description'].trim() : undefined)
    ?? (typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined)
    ?? (typeof lexDefinition?.['whenToUse'] === 'string' && lexDefinition['whenToUse'].trim() ? lexDefinition['whenToUse'].trim() : undefined);
  const mergedName = lexName ?? itemName ?? lexAgentType ?? deriveSessionCustomizationAgentName(uri);
  const mergedAgentType = lexAgentType ?? deriveSessionCustomizationAgentName(uri);
  const mergedSystemPrompt = typeof lexDefinition?.['systemPrompt'] === 'string' ? lexDefinition['systemPrompt'] : '';
  const mergedModeInstructions = lexDefinition?.['modeInstructions'] && typeof lexDefinition['modeInstructions'] === 'object'
    ? lexDefinition['modeInstructions']
    : {
      content: mergedSystemPrompt,
      toolReferences: [],
    };
  const mergedTools = Array.isArray(lexDefinition?.['tools']) ? lexDefinition['tools'] : ['*'];
  const mergedSessionTypes = readFrontmatterStringArray(lexDefinition?.['sessionTypes'])
    ?? readFrontmatterStringArray(item.sessionTypes);

  return {
    ...(lexDefinition ?? {}),
    agentType: mergedAgentType,
    name: mergedName,
    description,
    whenToUse: typeof lexDefinition?.['whenToUse'] === 'string' && lexDefinition['whenToUse'].trim()
      ? lexDefinition['whenToUse']
      : description ?? '',
    systemPrompt: mergedSystemPrompt,
    modeInstructions: mergedModeInstructions,
    uri,
    source,
    tools: mergedTools,
    ...(item.enabled === false ? { enabled: false } : {}),
    ...(mergedSessionTypes ? { sessionTypes: mergedSessionTypes } : {}),
  };
}

function readFrontmatterStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map(entry => entry.trim());
  return result.length > 0 ? result : undefined;
}

function deriveSessionCustomizationAgentName(uri: string): string {
  const trimmedUri = uri.trim();
  const slashIndex = Math.max(trimmedUri.lastIndexOf('/'), trimmedUri.lastIndexOf('\\'));
  const filename = slashIndex >= 0 ? trimmedUri.slice(slashIndex + 1) : trimmedUri;
  return filename.replace(/\.agent\.md$/i, '').trim() || 'agent';
}
