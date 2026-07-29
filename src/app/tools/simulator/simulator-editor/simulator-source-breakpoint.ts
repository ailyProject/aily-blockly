export interface DebugSourceArtifact {
  file: string;
  revision: string;
  sizeBytes: number;
  content: string;
}

export interface SourceBreakpointPayload {
  kind: 'source';
  file: string;
  line: number;
  sourceRevision?: string;
}

export type DebugSourceBreakpointState =
  | 'unavailable'
  | 'disconnected'
  | 'connecting'
  | 'stopped'
  | 'running'
  | 'exited'
  | 'error';

export interface DebugSourceLocation {
  file: string;
  line: number;
}

export interface DebugStopContextSnapshot {
  state: DebugSourceBreakpointState;
  frame: {
    level: number;
    address: string | null;
    functionName: string | null;
    location: DebugSourceLocation | null;
    blockId?: string;
  } | null;
}

export function hasDebugStoppedContextChanged(
  previous: DebugStopContextSnapshot,
  next: DebugStopContextSnapshot,
): boolean {
  if (next.state !== 'stopped') return false;
  if (previous.state !== 'stopped') return true;
  const previousFrame = previous.frame;
  const nextFrame = next.frame;
  if (!previousFrame || !nextFrame) return previousFrame !== nextFrame;
  return previousFrame.level !== nextFrame.level
    || previousFrame.address !== nextFrame.address
    || previousFrame.functionName !== nextFrame.functionName
    || previousFrame.location?.file !== nextFrame.location?.file
    || previousFrame.location?.line !== nextFrame.location?.line
    || previousFrame.blockId !== nextFrame.blockId;
}

export function prepareArtifactSourceBreakpointForGateway(
  payload: SourceBreakpointPayload,
  state: DebugSourceBreakpointState,
  selectedLocation: DebugSourceLocation | null,
  artifact: DebugSourceArtifact | null,
): { kind: 'source'; file: string; line: number } {
  if (payload.sourceRevision === undefined) {
    return {
      kind: 'source',
      file: payload.file,
      line: payload.line,
    };
  }
  const sourceLines = artifact?.content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n') ?? [];
  const currentLine = Number(selectedLocation?.line);
  const startLine = Math.max(1, currentLine - 10);
  const endLine = Math.min(sourceLines.length, currentLine + 10);
  if (
    state !== 'stopped'
    || !artifact
    || payload.sourceRevision !== artifact.revision
    || portableBasename(payload.file) !== portableBasename(artifact.file)
    || portableBasename(selectedLocation?.file ?? '')
      !== portableBasename(artifact.file)
    || !Number.isSafeInteger(currentLine)
    || currentLine < 1
    || currentLine > sourceLines.length
    || payload.line < startLine
    || payload.line > endLine
  ) {
    throw new Error(
      '源码断点上下文已失效，请等待当前 Artifact 源码刷新后重试。',
    );
  }
  return {
    kind: 'source',
    file: artifact.file,
    line: payload.line,
  };
}

function portableBasename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
}
