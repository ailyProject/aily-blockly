import type { RenderEvent, TurnResponsePart } from 'aily-lex/browser';

import type { ChatPart } from './chat-parts';
import {
  ChatPartStore,
  type ChatPartStoreChangeTracker,
} from './chat-part-store';
import type { ChatMessageHandle, OpaqueChatMessageHandle } from '../helpers/chat-message-handle';
import { RenderEventPartAdapter, type RenderEventPartStoreAccess } from './render-event-part-adapter';
import { chatPartToTurnResponsePart, turnResponsePartToChatPart, turnResponsePartToChatParts } from './turn-response-part-mapper';
import { appendThinkContent, storeThinkContent } from './think-content-store';
import { appendMarkdownContent, storeMarkdownContent } from './markdown-content-store';

const VISIBLE_MARKDOWN_REF_THRESHOLD = 32 * 1024;

export type DetachedRuntimeProjectionTargetHandle<TMessage extends object = object> =
  | ChatMessageHandle<TMessage & { content: string }>
  | OpaqueChatMessageHandle<TMessage & { content: string }>;

type DetachedProjectionChangeTracker = Pick<
  ChatPartStoreChangeTracker,
  'drainPartIndexChangesForHandle' | 'clear' | 'dispose'
>;

type DetachedHostStreamChangeTracker = Pick<
  ChatPartStoreChangeTracker,
  'drainChangesForHandle' | 'clear' | 'dispose'
>;

type DetachedRuntimeStore = RenderEventPartStoreAccess & Pick<
  ChatPartStore,
  | 'createDetachedHandle'
  | 'addPartToHandle'
  | 'createChangeTracker'
  | 'clearMessageHandle'
  | 'destroy'
  | 'finalizeRunningPartsForHandle'
  | 'getPartsForHandle'
  | 'projectPartChangesFromHandle'
>;

type DetachedRuntimeProjectionTargetStore = Pick<
  ChatPartStore,
  'projectPartChangesFromHandle'
>;

/**
 * Encapsulates the detached ChatPartStore + synthetic handle compatibility
 * boundary used by live streaming and replay-only turn projection.
 */
export class DetachedChatPartRuntime {
  private readonly store: DetachedRuntimeStore = new ChatPartStore();
  private readonly adapter = new RenderEventPartAdapter(this.store);
  private readonly detachedHandle = this.store.createDetachedHandle();
  private readonly changeTracker: DetachedProjectionChangeTracker = this.store.createChangeTracker();
  private readonly hostStreamChangeTracker: DetachedHostStreamChangeTracker = this.store.createChangeTracker();

  drainTurnResponsePartChanges(): Array<{
    partIndex: number;
    kind: 'add' | 'update' | 'append';
    part: TurnResponsePart;
  }> {
    const detachedParts = this.getDetachedParts();
    return this.hostStreamChangeTracker.drainChangesForHandle(this.detachedHandle)
      .map(change => {
        const part = detachedParts[change.partIndex];
        if (!part) {
          return null;
        }

        return {
          partIndex: change.partIndex,
          kind: change.kind,
          part: chatPartToTurnResponsePart(part),
        };
      })
      .filter((change): change is {
        partIndex: number;
        kind: 'add' | 'update' | 'append';
        part: TurnResponsePart;
      } => !!change);
  }

  process(event: RenderEvent): boolean {
    return this.adapter.process(event, this.detachedHandle);
  }

  finalizeRunningParts(options: { readonly status?: 'completed' | 'cancelled' | 'error' } = {}): void {
    this.adapter.finalize(this.detachedHandle);
    this.store.finalizeRunningPartsForHandle(this.detachedHandle, { status: options.status });
  }

  collectTurnResponseParts(): TurnResponsePart[] {
    return this.getDetachedParts().map(chatPartToTurnResponsePart);
  }

  hydrateTurnResponseParts(parts: readonly TurnResponsePart[]): void {
    this.reset();

    for (const part of parts) {
      for (const chatPart of turnResponsePartToChatParts(part)) {
        this.store.addPartToHandle(this.detachedHandle, chatPart);
      }
    }

    // Hydration is a baseline restore, not a live delta.
    this.changeTracker.clear();
    this.hostStreamChangeTracker.clear();
  }

  projectPendingPartsTo(
    targetStore: DetachedRuntimeProjectionTargetStore,
    targetHandle: DetachedRuntimeProjectionTargetHandle | null,
  ): boolean {
    const changes = coalesceProjectionChanges(
      this.changeTracker.drainPartIndexChangesForHandle(this.detachedHandle),
    );
    if (changes.length === 0) {
      return false;
    }

    return targetStore.projectPartChangesFromHandle(
      this.store,
      this.detachedHandle,
      changes,
      targetHandle,
      cloneChatPart,
    );
  }

  clear(): void {
    this.store.clearMessageHandle(this.detachedHandle);
    this.changeTracker.clear();
    this.hostStreamChangeTracker.clear();
  }

  reset(): void {
    this.clear();
    this.adapter.reset();
  }

  destroy(): void {
    this.adapter.dispose();
    this.changeTracker.dispose();
    this.hostStreamChangeTracker.dispose();
    this.store.destroy();
  }

  private getDetachedParts(): ChatPart[] {
    return this.store.getPartsForHandle(this.detachedHandle);
  }
}

function cloneChatPart(part: ChatPart, existing?: ChatPart): ChatPart {
  if (part.type === 'markdown') {
    const existingMarkdown = existing?.type === 'markdown' ? existing : undefined;
    if (part.content.length > VISIBLE_MARKDOWN_REF_THRESHOLD || !!existingMarkdown?.contentRef) {
      const contentRef = existingMarkdown?.contentRef || createVisibleContentRef('markdown');
      const existingLength = typeof existingMarkdown?.contentLength === 'number'
        ? existingMarkdown.contentLength
        : -1;
      if (existingMarkdown?.contentRef === contentRef && existingLength >= 0 && part.content.length >= existingLength) {
        const appendFrom = Math.max(0, Math.min(existingLength, part.content.length));
        appendMarkdownContent(contentRef, part.content.slice(appendFrom));
      } else {
        storeMarkdownContent(contentRef, part.content);
      }
      return {
        ...part,
        content: '',
        contentRef,
        contentLength: part.content.length,
      };
    }
  }

  if (part.type === 'thinking') {
    const existingThinking = existing?.type === 'thinking' ? existing : undefined;
    const contentRef = existingThinking?.contentRef || createVisibleContentRef('thinking');
    const existingLength = typeof existingThinking?.contentLength === 'number'
      ? existingThinking.contentLength
      : -1;
    if (existingThinking?.contentRef === contentRef && existingLength >= 0 && part.content.length >= existingLength) {
      const appendFrom = Math.max(0, Math.min(existingLength, part.content.length));
      appendThinkContent(contentRef, part.content.slice(appendFrom));
    } else {
      storeThinkContent(contentRef, part.content);
    }
    return {
      ...part,
      content: '',
      contentRef,
      contentLength: part.content.length,
    };
  }

  return turnResponsePartToChatPart(chatPartToTurnResponsePart(part), existing);
}

function createVisibleContentRef(kind: 'markdown' | 'thinking'): string {
  const randomId = Math.random().toString(36).slice(2);
  return `visible-${kind}:${Date.now().toString(36)}:${randomId}`;
}

function coalesceProjectionChanges<TChange extends Pick<{ partIndex: number }, 'partIndex'>>(
  changes: readonly TChange[],
): Array<Pick<TChange, 'partIndex'>> {
  if (changes.length <= 1) {
    return [...changes];
  }

  const seen = new Set<number>();
  const coalesced: Array<Pick<TChange, 'partIndex'>> = [];
  for (let index = changes.length - 1; index >= 0; index--) {
    const partIndex = changes[index]?.partIndex;
    if (!Number.isInteger(partIndex) || seen.has(partIndex)) {
      continue;
    }

    seen.add(partIndex);
    coalesced.push({ partIndex });
  }

  coalesced.reverse();
  return coalesced;
}
