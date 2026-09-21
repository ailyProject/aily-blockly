/** Wire contract for a verified legacy projection, not the future lossless v2/map protocol. */
export interface AbsHostProjectionRequest {
  version: 1;
  requestId: string;
  expectedAbiHash: string;
  includeHeader?: boolean;
  publish?: boolean;
}

export interface AbsHostProjectionReceipt {
  version: 1;
  requestId: string;
  project: string;
  scope: { pageId: string; contextEpoch: number; workspaceRevision: number };
  source: { abiHash: string };
  output: { file: 'project.abs'; hash: string; bytes: number; persisted: boolean };
  validation: { ok: true; scope: 'legacy-syntax-and-project-data' };
}

export interface AbsWorkspaceExport {
  abs: string;
  receipt?: AbsHostProjectionReceipt;
}

export function assertAbsHostProjectionRequest(value: unknown): asserts value is AbsHostProjectionRequest {
  const request = value as AbsHostProjectionRequest;
  if (!request || request.version !== 1 || typeof request.requestId !== 'string'
    || !/^[a-zA-Z0-9-]{16,80}$/.test(request.requestId)
    || !/^sha256:[a-f0-9]{64}$/.test(request.expectedAbiHash)
    || (request.includeHeader !== undefined && typeof request.includeHeader !== 'boolean')
    || (request.publish !== undefined && typeof request.publish !== 'boolean')) {
    throw new Error('Invalid ABS host projection v1 request.');
  }
}
