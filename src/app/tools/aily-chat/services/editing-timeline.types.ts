export interface EditingSessionTimelineState {
  version: 1;
  sessionId: string;
  workspaceRoot: string;
  checkpoints: TimelineCheckpoint[];
  baselines: TimelineFileBaseline[];
  operations: TimelineFileOperation[];
  requestScopes: TimelineRequestScope[];
  currentPointer: TimelinePointer;
  epochCounter: number;
  createdAt: number;
  updatedAt: number;
}

export interface TimelinePointer {
  epoch: number;
  checkpointId?: string;
  requestId?: string;
  stopId?: string;
}

export interface TimelineRequestScope {
  requestId: string;
  turnId?: string;
  responseId?: string;
  startedAt: number;
  completedAt?: number;
  status: 'open' | 'completed' | 'restored' | 'discarded';
  firstEpoch?: number;
  lastEpoch?: number;
  checkpointIds: string[];
  touchedUris: string[];
}

export interface TimelineCheckpoint {
  checkpointId: string;
  requestId: string;
  turnId?: string;
  stopId?: string;
  label: string;
  description?: string;
  epoch: number;
  createdAt: number;
}

export interface CreateTimelineCheckpointInput {
  checkpointId: string;
  requestId: string;
  turnId?: string;
  stopId?: string;
  label?: string;
  description?: string;
}

export interface TimelineFileBaseline {
  baselineId: string;
  requestId: string;
  uri: string;
  epoch: number;
  contentRef: ContentRef | null;
  contentKind: 'text' | 'binary' | 'notebook';
  languageId?: string;
  existed: boolean;
  createdAt: number;
}

export interface ContentRef {
  hash: string;
  encoding: 'utf8' | 'base64';
  byteLength: number;
}

export type TimelineFileOperation =
  | TimelineCreateFileOperation
  | TimelineDeleteFileOperation
  | TimelineRenameFileOperation
  | TimelineReplaceFileOperation
  | TimelineTextEditFileOperation;

export interface TimelineBaseFileOperation {
  operationId: string;
  requestId: string;
  checkpointId?: string;
  epoch: number;
  uri: string;
  contentKind: 'text' | 'binary' | 'notebook';
  createdAt: number;
}

export interface TimelineCreateFileOperation extends TimelineBaseFileOperation {
  type: 'create';
  afterRef: ContentRef | null;
}

export interface TimelineDeleteFileOperation extends TimelineBaseFileOperation {
  type: 'delete';
  beforeRef: ContentRef | null;
}

export interface TimelineRenameFileOperation extends TimelineBaseFileOperation {
  type: 'rename';
  fromUri: string;
  toUri: string;
}

export interface TimelineReplaceFileOperation extends TimelineBaseFileOperation {
  type: 'replace';
  beforeRef: ContentRef | null;
  afterRef: ContentRef | null;
}

export interface TimelineTextEditFileOperation extends TimelineBaseFileOperation {
  type: 'text-edit';
  beforeRef: ContentRef;
  afterRef: ContentRef;
  edits: NormalizedTextEdit[];
}

export interface NormalizedTextEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
}

export interface TimelineDiffStat {
  uri: string;
  contentKind: 'text' | 'binary' | 'notebook';
  addedLines: number;
  removedLines: number;
  changedLines: number;
  operationTypes: string[];
  changes?: TimelineDiffChange[];
}

export interface ReconstructedFileState {
  uri: string;
  exists: boolean;
  contentKind: 'text' | 'binary' | 'notebook';
  contentRef: ContentRef | null;
  sourceEpoch: number;
}

export interface GitCheckpointApplyTarget {
  repositoryRoot: string;
  targetRef: string;
}

export interface GitCheckpointRestoreApplyMetadata {
  kind: 'git-checkpoint';
  repositoryRoot: string;
  targetRef: string;
  additionalTargets?: GitCheckpointApplyTarget[];
}

export interface RestorePlan {
  checkpointId: string;
  epoch: number;
  files: ReconstructedFileState[];
  applyMetadata?: GitCheckpointRestoreApplyMetadata;
}

export interface EditingFileApplyResult {
  appliedFiles: number;
  errors: string[];
  rolledBackOnError?: boolean;
  rollbackErrors?: string[];
}

export interface TimelineDiffChange {
  type: 'insert' | 'delete' | 'replace';
  originalStartLine: number;
  originalEndLineExclusive: number;
  modifiedStartLine: number;
  modifiedEndLineExclusive: number;
  charChanges?: TimelineDiffCharChange[];
}

export interface TimelineDiffCharChange {
  originalStartLine: number;
  originalStartColumn: number;
  originalEndLine: number;
  originalEndColumn: number;
  modifiedStartLine: number;
  modifiedStartColumn: number;
  modifiedEndLine: number;
  modifiedEndColumn: number;
}

export interface RequestEditSummary {
  requestId: string;
  checkpointId?: string;
  fileCount: number;
  stats: TimelineDiffStat[];
  hasBinaryEdits: boolean;
  hasNotebookEdits: boolean;
  hasRename: boolean;
}

export interface TimelineDiffSummary {
  fileCount: number;
  stats: TimelineDiffStat[];
  hasBinaryEdits: boolean;
  hasNotebookEdits: boolean;
  hasRename: boolean;
}
