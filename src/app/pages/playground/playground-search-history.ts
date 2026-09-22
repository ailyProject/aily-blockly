export interface PlaygroundHistoryState {
  keyword: string;
  page: number;
}

export function normalizePlaygroundPage(page: unknown): number {
  const parsedPage = Number(page);
  return Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
}

export class PlaygroundSearchHistory {
  private entries: PlaygroundHistoryState[] = [{ keyword: '', page: 1 }];

  get canGoBack(): boolean {
    return this.entries.length > 1;
  }

  reset(initialState: PlaygroundHistoryState): void {
    this.entries = [{ ...initialState }];
  }

  visit(state: PlaygroundHistoryState): void {
    const currentState = this.entries[this.entries.length - 1];
    if (currentState.keyword === state.keyword && currentState.page === state.page) {
      return;
    }

    this.entries.push({ ...state });
  }

  back(): PlaygroundHistoryState | null {
    if (!this.canGoBack) {
      return null;
    }

    this.entries.pop();
    return { ...this.entries[this.entries.length - 1] };
  }
}
