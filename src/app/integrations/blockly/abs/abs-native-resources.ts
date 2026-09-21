import { collectProjectDataReferences, projectDataRuntime } from '@domain/project/project-data/public-api';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';

/** Host I/O remains under its existing session/lease; only resolved values cross the realm boundary. */
export async function captureAbsNativeValues(syntax: unknown, assertCurrent: () => void) {
  const entries: NonNullable<NativeCandidateRequest['values']> = [];
  for (const ref of collectProjectDataReferences(syntax)) {
    assertCurrent();
    const value = await projectDataRuntime.resolve(ref);
    assertCurrent();
    entries.push({ ref: structuredClone(ref), value: structuredClone(value) });
  }
  assertCurrent();
  return entries;
}
