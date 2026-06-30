import type { ChatPendingRequestKind } from './chat-pending-request';

export interface AgentSuggestionKeyAction {
  readonly kind: 'none' | 'select' | 'hide';
  readonly agentName?: string;
}

export interface ComposerLineBreakEdit {
  readonly value: string;
  readonly caret: number;
}

export type ComposerKeyAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'select-agent'; readonly agentName: string }
  | { readonly kind: 'hide-suggestions' }
  | { readonly kind: 'insert-line-break'; readonly value: string; readonly caret: number }
  | { readonly kind: 'submit'; readonly queueKind?: ChatPendingRequestKind };

export function resolveAgentSuggestionKeyAction(
  key: string,
  suggestions: readonly string[],
): AgentSuggestionKeyAction {
  if (suggestions.length === 0) {
    return { kind: 'none' };
  }

  if (key === 'Enter') {
    return { kind: 'select', agentName: suggestions[0] };
  }

  if (key === 'Escape') {
    return { kind: 'hide' };
  }

  return { kind: 'none' };
}

export function insertComposerLineBreak(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ComposerLineBreakEdit {
  const nextValue = value.substring(0, selectionStart) + '\n' + value.substring(selectionEnd);
  return {
    value: nextValue,
    caret: selectionStart + 1,
  };
}

export function resolveComposerKeyAction(input: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  suggestions: readonly string[];
  inputValue: string;
  selectionStart: number;
  selectionEnd: number;
  isWaiting: boolean;
  editingPendingKind?: ChatPendingRequestKind | null;
}): ComposerKeyAction {
  const suggestionAction = resolveAgentSuggestionKeyAction(input.key, input.suggestions);
  if (suggestionAction.kind === 'select' && suggestionAction.agentName) {
    return {
      kind: 'select-agent',
      agentName: suggestionAction.agentName,
    };
  }
  if (suggestionAction.kind === 'hide') {
    return { kind: 'hide-suggestions' };
  }

  if (input.key !== 'Enter') {
    return { kind: 'none' };
  }

  if (input.ctrlKey) {
    const edit = insertComposerLineBreak(input.inputValue, input.selectionStart, input.selectionEnd);
    return {
      kind: 'insert-line-break',
      value: edit.value,
      caret: edit.caret,
    };
  }

  if (input.editingPendingKind === 'queued' || input.editingPendingKind === 'steering') {
    const queueKind: ChatPendingRequestKind = input.altKey
      ? input.editingPendingKind === 'steering' ? 'queued' : 'steering'
      : input.editingPendingKind;
    return {
      kind: 'submit',
      queueKind,
    };
  }

  if (input.isWaiting) {
    return {
      kind: 'submit',
      queueKind: input.altKey ? 'queued' : 'steering',
    };
  }

  return { kind: 'submit' };
}
