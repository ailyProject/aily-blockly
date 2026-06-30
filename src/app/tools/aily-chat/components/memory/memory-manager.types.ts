export type ChatMemoryScope = 'global' | 'project' | 'session';

export interface ChatMemoryEntry {
  readonly scope: ChatMemoryScope;
  readonly absolutePath: string;
  readonly publicPath: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly content: string;
  readonly updatedAt: number;
}

export interface ChatMemoryNavigationItem {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly projectPath?: string;
  readonly sessionId?: string;
}
