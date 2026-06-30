import { evaluateChatActionWhenClause, type ChatActionWhenContextMap } from './chat-action-when';

export interface ChatActionSurfaceDescriptor<
  TContext,
  TSurfaceId extends string,
  TActionId extends string,
  TRequest,
> {
  readonly id: TActionId;
  readonly surfaceId?: TSurfaceId;
  readonly surfaceWhen?: string;
  readonly when?: string;
  readonly enabledWhen?: string;
  readonly group?: string;
  readonly order?: number;
  run(context: TContext, request: TRequest): boolean;
}

export interface ChatResolvedActionSurfaceEntry<TContext, TDescriptor> {
  readonly descriptor: TDescriptor;
  readonly context: TContext;
  readonly enabled: boolean;
}

interface ChatActionSurfaceRegistryOptions<
  TContext,
  TSurfaceId extends string,
  TActionId extends string,
  TRequest,
  TDescriptor extends ChatActionSurfaceDescriptor<TContext, TSurfaceId, TActionId, TRequest>,
> {
  readonly getContext: () => TContext;
  readonly descriptors: readonly TDescriptor[];
  readonly createContextKeyMap: (context: TContext) => ChatActionWhenContextMap;
}

export class ChatActionSurfaceRegistry<
  TContext,
  TSurfaceId extends string,
  TActionId extends string,
  TRequest,
  TDescriptor extends ChatActionSurfaceDescriptor<TContext, TSurfaceId, TActionId, TRequest>,
> {
  constructor(
    private readonly options: ChatActionSurfaceRegistryOptions<
      TContext,
      TSurfaceId,
      TActionId,
      TRequest,
      TDescriptor
    >,
  ) {}

  getSurfaceEntries(surfaceId: TSurfaceId): readonly ChatResolvedActionSurfaceEntry<TContext, TDescriptor>[] {
    const context = this.options.getContext();
    const contextKeys = this.options.createContextKeyMap(context);

    return this.options.descriptors
      .filter(descriptor => (
        descriptor.surfaceId === surfaceId
        && evaluateChatActionWhenClause(descriptor.surfaceWhen ?? descriptor.when, contextKeys)
      ))
      .sort(compareChatActionSurfaceDescriptors)
      .map(descriptor => ({
        descriptor,
        context,
        enabled: evaluateChatActionWhenClause(descriptor.enabledWhen, contextKeys),
      }));
  }

  runActionById(actionId: TActionId, request: TRequest): boolean {
    const descriptor = this.options.descriptors.find(candidate => candidate.id === actionId);
    if (!descriptor) {
      return false;
    }

    const context = this.options.getContext();
    const contextKeys = this.options.createContextKeyMap(context);
    if (!evaluateChatActionWhenClause(descriptor.when, contextKeys)) {
      return false;
    }
    if (!evaluateChatActionWhenClause(descriptor.enabledWhen, contextKeys)) {
      return false;
    }

    return descriptor.run(context, request);
  }
}

function compareChatActionSurfaceDescriptors<
  TContext,
  TSurfaceId extends string,
  TActionId extends string,
  TRequest,
>(
  left: ChatActionSurfaceDescriptor<TContext, TSurfaceId, TActionId, TRequest>,
  right: ChatActionSurfaceDescriptor<TContext, TSurfaceId, TActionId, TRequest>,
): number {
  const leftGroup = left.group ?? '';
  const rightGroup = right.group ?? '';
  if (leftGroup !== rightGroup) {
    return leftGroup.localeCompare(rightGroup);
  }

  const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return 0;
}