export type RelatedContentScope = 'project' | 'session';

export interface ProjectRelatedFileEntry {
  readonly type: 'file' | 'folder' | 'link';
  readonly name: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly originalPath?: string;
  readonly isExternal?: boolean;
}

export interface ProjectRelatedContentGroup {
  readonly type: ProjectRelatedFileEntry['type'];
  readonly entries: readonly ProjectRelatedFileEntry[];
}
