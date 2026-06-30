export type ChatRuntimeProjectionPhase = 'live' | 'terminal';

export type ChatRuntimeProjectionSource =
  | 'visible-render'
  | 'detached-render'
  | 'restore'
  | 'history'
  | 'handoff'
  | 'execution';

export type ChatRuntimeProjectionListPolicy = 'none' | 'metadata' | 'terminal';

export type ChatRuntimeProjectionPersistencePolicy =
  | 'none'
  | 'recovery-snapshot'
  | 'authoritative';

export interface ChatRuntimeTurnResponseSyncOptions {
  readonly phase: ChatRuntimeProjectionPhase;
  readonly source: ChatRuntimeProjectionSource;
  readonly listPolicy: ChatRuntimeProjectionListPolicy;
  readonly persistencePolicy: ChatRuntimeProjectionPersistencePolicy;
}

export interface ChatRuntimeProjectionChangeOptions {
  readonly reason: 'live_transcript' | 'terminal_transcript';
  readonly highFrequency: boolean;
  readonly listAffecting?: boolean;
}

export function liveTranscriptProjection(
  source: ChatRuntimeProjectionSource = 'visible-render',
): ChatRuntimeTurnResponseSyncOptions {
  return {
    phase: 'live',
    source,
    listPolicy: 'none',
    persistencePolicy: 'recovery-snapshot',
  };
}

export function terminalTranscriptProjection(
  source: ChatRuntimeProjectionSource = 'visible-render',
): ChatRuntimeTurnResponseSyncOptions {
  return {
    phase: 'terminal',
    source,
    listPolicy: 'terminal',
    persistencePolicy: 'authoritative',
  };
}

export function runtimeChangeOptionsFromTranscriptProjection(
  projection: ChatRuntimeTurnResponseSyncOptions,
): ChatRuntimeProjectionChangeOptions {
  return {
    reason: projection.phase === 'live' ? 'live_transcript' : 'terminal_transcript',
    highFrequency: projection.phase === 'live',
    listAffecting: projection.listPolicy === 'terminal'
      ? true
      : projection.listPolicy === 'none'
        ? false
        : undefined,
  };
}
