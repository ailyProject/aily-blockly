/** Receipt facts about the original compiler capture, independent of current upload authority. */
export interface BuildSnapshot {
  version: 1;
  buildRequestId: string;
  inputDigest: string;
  sourceSha256: string;
  documentSha256?: string;
  workspaceRevision?: number;
  savedAbiHash?: string;
  savedMatch: 'matched' | 'different' | 'unknown';
}
