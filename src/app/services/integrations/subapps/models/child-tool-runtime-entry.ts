export type RecordedChildToolRuntimeEntryState = 'current' | 'stale' | 'unknown';

export interface RecordedChildToolRuntimeEntryInput {
  expectedEntry: string;
  expectedPackagePath: string;
  expectedDevSessionId?: string;
  recordedEntry: string;
  recordedPackagePath: string;
  recordedDevSessionId?: string;
}

export function classifyRecordedChildToolRuntimeEntry(
  input: RecordedChildToolRuntimeEntryInput,
): RecordedChildToolRuntimeEntryState {
  if (input.expectedDevSessionId && input.recordedDevSessionId !== input.expectedDevSessionId) {
    return 'stale';
  }
  if (input.recordedEntry && input.recordedEntry !== input.expectedEntry) {
    return 'stale';
  }
  if (
    input.recordedPackagePath
    && input.expectedPackagePath
    && input.recordedPackagePath !== input.expectedPackagePath
  ) {
    return 'stale';
  }
  if (
    input.recordedEntry === input.expectedEntry
    && !!input.expectedPackagePath
    && input.recordedPackagePath === input.expectedPackagePath
  ) {
    return 'current';
  }
  return 'unknown';
}
