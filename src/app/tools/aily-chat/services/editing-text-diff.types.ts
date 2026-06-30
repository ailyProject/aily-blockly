export interface EditingTextDiffOptions {
  ignoreTrimWhitespace: boolean;
  maxComputationTimeMs: number;
  computeMoves: boolean;
  extendToSubwords?: boolean;
}

export interface EditingTextCharChange {
  originalStartLineNumber: number;
  originalStartColumn: number;
  originalEndLineNumber: number;
  originalEndColumn: number;
  modifiedStartLineNumber: number;
  modifiedStartColumn: number;
  modifiedEndLineNumber: number;
  modifiedEndColumn: number;
}

export interface EditingTextLineChange {
  originalStartLineNumber: number;
  originalEndLineNumberExclusive: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumberExclusive: number;
  charChanges?: EditingTextCharChange[];
}

export interface EditingTextMove {
  originalStartLineNumber: number;
  originalEndLineNumberExclusive: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumberExclusive: number;
  changes: EditingTextLineChange[];
}

export interface EditingTextDiffResult {
  identical: boolean;
  quitEarly: boolean;
  changes: EditingTextLineChange[];
  moves: EditingTextMove[];
}

export interface EditingTextDiffWorkerRequest {
  id: number;
  type: 'computeDiff';
  payload: {
    original: string;
    modified: string;
    options: EditingTextDiffOptions;
  };
}

export interface EditingTextDiffWorkerResponse {
  id: number;
  type: 'computeDiff';
  result?: EditingTextDiffResult;
  error?: string;
}