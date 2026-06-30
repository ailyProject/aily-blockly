export interface ChatInputHistoryEntry {
  readonly inputText: string;
}

export const CHAT_INPUT_HISTORY_MAX_ENTRIES = 40;

function entriesEqual(a: ChatInputHistoryEntry | undefined, b: ChatInputHistoryEntry | undefined): boolean {
  return !!a && !!b && a.inputText === b.inputText;
}

export class ChatInputHistoryNavigator {
  private history: ChatInputHistoryEntry[] = [];
  private currentIndex = 0;
  private overlayEntries: Array<ChatInputHistoryEntry | undefined> = [];

  constructor(
    initialEntries: readonly ChatInputHistoryEntry[] = [],
    private readonly onDidChange?: (entries: readonly ChatInputHistoryEntry[]) => void,
  ) {
    this.replaceEntries(initialEntries);
  }

  get values(): readonly ChatInputHistoryEntry[] {
    return this.history;
  }

  isAtStart(): boolean {
    return this.currentIndex === 0;
  }

  isAtEnd(): boolean {
    return this.currentIndex === Math.max(this.history.length, this.overlayEntries.length);
  }

  overlay(entry: ChatInputHistoryEntry): void {
    this.overlayEntries[this.currentIndex] = entry;
  }

  resetCursor(): void {
    this.currentIndex = this.history.length;
  }

  previous(): ChatInputHistoryEntry | undefined {
    this.currentIndex = Math.max(this.currentIndex - 1, 0);
    return this.current();
  }

  next(): ChatInputHistoryEntry | undefined {
    this.currentIndex = Math.min(this.currentIndex + 1, this.history.length);
    return this.current();
  }

  current(): ChatInputHistoryEntry | undefined {
    return this.overlayEntries[this.currentIndex] ?? this.history[this.currentIndex];
  }

  append(entry: ChatInputHistoryEntry): void {
    this.overlayEntries = [];
    this.currentIndex = this.history.length;

    if (!entriesEqual(this.history.at(-1), entry)) {
      this.history = this.history.concat(entry).slice(-CHAT_INPUT_HISTORY_MAX_ENTRIES);
      this.emitChange();
    }

    this.currentIndex = this.history.length;
  }

  replaceEntries(entries: readonly ChatInputHistoryEntry[]): void {
    this.history = normalizeEntries(entries);
    this.currentIndex = this.history.length;
    this.overlayEntries = [];
  }

  clear(): void {
    this.history = [];
    this.currentIndex = 0;
    this.overlayEntries = [];
    this.emitChange();
  }

  private emitChange(): void {
    this.onDidChange?.(this.history);
  }
}

function normalizeEntries(entries: readonly ChatInputHistoryEntry[]): ChatInputHistoryEntry[] {
  const normalized: ChatInputHistoryEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.inputText !== 'string') {
      continue;
    }
    normalized.push({ inputText: entry.inputText });
  }
  return normalized.slice(-CHAT_INPUT_HISTORY_MAX_ENTRIES);
}
