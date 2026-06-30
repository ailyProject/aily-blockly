import type { ComposerKeyAction } from './chat-composer-view';
import type { ChatPendingRequestKind } from './chat-pending-request';

export const AILY_CHAT_INPUT_MAX_CHARS = 32_000;
const INPUT_TRUNCATION_NOTICE_INTERVAL_MS = 2000;

interface ComposerViewStateLike {
  updateAgentSuggestions(inputValue: string): void;
  applyAgentSelection(agentName: string): string;
  resolveComposerKeyAction(input: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    inputValue: string;
    selectionStart: number;
    selectionEnd: number;
    isWaiting: boolean;
    editingPendingKind?: ChatPendingRequestKind | null;
  }): ComposerKeyAction;
  hideAgentSuggestions(): void;
}

interface TextareaRefLike {
  nativeElement?: HTMLTextAreaElement | null;
}

export class ChatComposerShellCoordinator {
  constructor(
    private readonly deps: {
      viewState: ComposerViewStateLike;
      getInputValue: () => string;
      setInputValue: (value: string) => void;
      isWaiting: () => boolean;
      getEditingPendingKind?: () => ChatPendingRequestKind | null | undefined;
      navigateInputHistory?: (
        direction: 'previous' | 'next',
        currentValue: string,
      ) => string | null | undefined;
      submitCurrentInput: (options?: { queueKind?: ChatPendingRequestKind }) => Promise<unknown>;
      getTextareaRef: () => TextareaRefLike | undefined;
      schedule?: (work: () => void) => void;
      notifyInputTruncated?: (maxChars: number) => void;
    },
  ) {}

  private lastInputTruncationNoticeAt = 0;

  updateSuggestions(): void {
    if (typeof this.deps.viewState.updateAgentSuggestions === 'function') {
      this.deps.viewState.updateAgentSuggestions(this.deps.getInputValue());
    }
  }

  updateInputValue(value: string): void {
    this.deps.setInputValue(this.clampInputValue(value));
  }

  selectAgent(agentName: string): void {
    this.deps.setInputValue(this.clampInputValue(this.deps.viewState.applyAgentSelection(agentName)));
    this.schedule(() => {
      this.deps.getTextareaRef()?.nativeElement?.focus();
    });
  }

  applyLineBreak(value: string, caret: number, textarea: HTMLTextAreaElement | null): void {
    const nextValue = this.clampInputValue(value);
    const nextCaret = Math.min(caret, nextValue.length);
    this.deps.setInputValue(nextValue);
    if (!textarea) {
      return;
    }

    this.schedule(() => {
      textarea.selectionStart = nextCaret;
      textarea.selectionEnd = nextCaret;
    });
  }

  async handleKeyDown(event: KeyboardEvent): Promise<void> {
    if (isComposerImeEvent(event)) {
      return;
    }

    const textarea = event.target as HTMLTextAreaElement | null;
    const inputValue = this.deps.getInputValue();
    if (this.tryNavigateInputHistory(event, textarea, inputValue)) {
      return;
    }

    const composerAction = this.deps.viewState.resolveComposerKeyAction({
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      inputValue,
      selectionStart: textarea?.selectionStart ?? inputValue.length,
      selectionEnd: textarea?.selectionEnd ?? inputValue.length,
      isWaiting: this.deps.isWaiting(),
      editingPendingKind: this.deps.getEditingPendingKind?.() ?? null,
    });

    switch (composerAction.kind) {
      case 'select-agent':
        event.preventDefault();
        this.selectAgent(composerAction.agentName);
        return;

      case 'hide-suggestions':
        this.deps.viewState.hideAgentSuggestions();
        event.preventDefault();
        return;

      case 'insert-line-break':
        this.applyLineBreak(composerAction.value, composerAction.caret, textarea);
        event.preventDefault();
        return;

      case 'submit':
        event.preventDefault();
        await this.deps.submitCurrentInput(
          composerAction.queueKind ? { queueKind: composerAction.queueKind } : undefined,
        );
        return;

      default:
        return;
    }
  }

  private tryNavigateInputHistory(
    event: KeyboardEvent,
    textarea: HTMLTextAreaElement | null,
    inputValue: string,
  ): boolean {
    if (!this.deps.navigateInputHistory || event.ctrlKey || event.altKey || event.metaKey) {
      return false;
    }

    const direction = event.key === 'ArrowUp'
      ? 'previous'
      : event.key === 'ArrowDown'
        ? 'next'
        : null;
    if (!direction || !this.isAtHistoryNavigationBoundary(direction, textarea, inputValue)) {
      return false;
    }

    const nextValue = this.deps.navigateInputHistory(direction, inputValue);
    if (nextValue === null || typeof nextValue === 'undefined') {
      return false;
    }

    event.preventDefault();
    const normalizedNextValue = this.clampInputValue(nextValue);
    this.deps.setInputValue(normalizedNextValue);
    if (textarea) {
      const caret = direction === 'previous' ? 0 : normalizedNextValue.length;
      this.schedule(() => {
        textarea.selectionStart = caret;
        textarea.selectionEnd = caret;
      });
    }
    return true;
  }

  private isAtHistoryNavigationBoundary(
    direction: 'previous' | 'next',
    textarea: HTMLTextAreaElement | null,
    inputValue: string,
  ): boolean {
    if (!textarea) {
      return true;
    }

    const selectionStart = textarea.selectionStart ?? inputValue.length;
    const selectionEnd = textarea.selectionEnd ?? inputValue.length;
    if (selectionStart !== selectionEnd) {
      return false;
    }

    return direction === 'previous'
      ? selectionStart === 0
      : selectionEnd === inputValue.length;
  }

  private schedule(work: () => void): void {
    const scheduler = this.deps.schedule ?? ((callback: () => void) => setTimeout(callback, 0));
    scheduler(work);
  }

  private clampInputValue(value: string): string {
    if (value.length <= AILY_CHAT_INPUT_MAX_CHARS) {
      return value;
    }

    this.notifyInputTruncated();
    return value.slice(0, AILY_CHAT_INPUT_MAX_CHARS);
  }

  private notifyInputTruncated(): void {
    if (!this.deps.notifyInputTruncated) {
      return;
    }

    const now = Date.now();
    if (now - this.lastInputTruncationNoticeAt < INPUT_TRUNCATION_NOTICE_INTERVAL_MS) {
      return;
    }

    this.lastInputTruncationNoticeAt = now;
    this.deps.notifyInputTruncated(AILY_CHAT_INPUT_MAX_CHARS);
  }
}

function isComposerImeEvent(event: KeyboardEvent): boolean {
  if (event.isComposing) {
    return true;
  }

  const legacyKeyCode = (event as KeyboardEvent & { keyCode?: number }).keyCode;
  return legacyKeyCode === 229;
}
