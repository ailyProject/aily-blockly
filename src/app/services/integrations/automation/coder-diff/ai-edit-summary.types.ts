export interface EditFileSummary {
  path: string;
  fullPath: string;
  type: 'create' | 'modify' | 'delete';
  contentKind: 'text' | 'binary' | 'notebook';
  added: number;
  removed: number;
}

export interface EditsSummary {
  checkpointId: string;
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
  files: EditFileSummary[];
}
