export type ChatInputNoticeTone = 'info' | 'warning' | 'error' | 'muted';

export interface ChatInputNotice {
  readonly id: string;
  readonly source: 'auth-quota' | 'request-quota' | 'remote-capability' | 'mode-guidance';
  readonly kind:
    | 'exhausted'
    | 'approaching'
    | 'rate-limit'
    | 'offline'
    | 'signed-out'
    | 'unavailable'
    | 'mode-guidance';
  readonly title: string;
  readonly subtitle?: string;
  readonly tone: ChatInputNoticeTone;
  readonly iconClass: string;
  readonly actionLabel?: string;
  readonly autoDismissOnMessage?: boolean;
}

export function isSameChatInputNotice(
  left: ChatInputNotice | null,
  right: ChatInputNotice | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return left.id === right.id
    && left.source === right.source
    && left.kind === right.kind
    && left.title === right.title
    && left.subtitle === right.subtitle
    && left.tone === right.tone
    && left.iconClass === right.iconClass
    && left.actionLabel === right.actionLabel
    && left.autoDismissOnMessage === right.autoDismissOnMessage;
}
