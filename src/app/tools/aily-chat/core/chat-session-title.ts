export type ChatSessionTitleSource =
  | 'empty'
  | 'default-first-request'
  | 'generated'
  | 'user'
  | 'restored-custom'
  | 'imported-custom'
  | 'legacy-custom';

export interface ChatSessionTitleCandidate {
  readonly text: string;
  readonly source: ChatSessionTitleSource;
  readonly revision: number;
}

export interface ChatSessionDisplayTitle {
  readonly text: string;
  readonly source: ChatSessionTitleSource;
  readonly durable: boolean;
}

export type PersistedChatSessionTitleSource = Exclude<ChatSessionTitleSource, 'empty' | 'default-first-request'>;

export function normalizeChatSessionTitleSource(value: unknown): ChatSessionTitleSource {
  switch (value) {
    case 'default-first-request':
    case 'generated':
    case 'user':
    case 'restored-custom':
    case 'imported-custom':
    case 'legacy-custom':
      return value;
    default:
      return 'empty';
  }
}

export function isCustomSessionTitleSource(source: unknown): boolean {
  const normalizedSource = normalizeChatSessionTitleSource(source);
  return normalizedSource === 'generated'
    || normalizedSource === 'user'
    || normalizedSource === 'restored-custom'
    || normalizedSource === 'imported-custom'
    || normalizedSource === 'legacy-custom';
}

export function normalizePersistedChatSessionTitleSource(value: unknown): PersistedChatSessionTitleSource | undefined {
  const normalizedSource = normalizeChatSessionTitleSource(value);
  switch (normalizedSource) {
    case 'generated':
    case 'user':
    case 'restored-custom':
    case 'imported-custom':
    case 'legacy-custom':
      return normalizedSource;
    default:
      return undefined;
  }
}

export function normalizeChatSessionTitleText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeChatSessionTitleCandidate(candidate: {
  readonly text?: unknown;
  readonly source?: unknown;
  readonly revision?: unknown;
} | null | undefined): ChatSessionTitleCandidate {
  const text = normalizeChatSessionTitleText(candidate?.text);
  const normalizedSource = text
    ? normalizeChatSessionTitleSource(candidate?.source)
    : 'empty';
  return {
    text,
    source: text && normalizedSource !== 'empty'
      ? normalizedSource
      : 'empty',
    revision: typeof candidate?.revision === 'number' && Number.isFinite(candidate.revision)
      ? Math.max(0, Math.floor(candidate.revision))
      : 0,
  };
}

export function getChatSessionTitleSourcePriority(source: unknown): number {
  const normalizedSource = normalizeChatSessionTitleSource(source);
  switch (normalizedSource) {
    case 'user':
    case 'imported-custom':
      return 4;
    case 'generated':
    case 'restored-custom':
    case 'legacy-custom':
      return 3;
    case 'default-first-request':
      return 1;
    default:
      return 0;
  }
}

export function isResolvedSessionTitleSource(source: unknown): boolean {
  const normalizedSource = normalizeChatSessionTitleSource(source);
  return normalizedSource === 'generated'
    || normalizedSource === 'user'
    || normalizedSource === 'restored-custom'
    || normalizedSource === 'imported-custom'
    || normalizedSource === 'legacy-custom';
}
