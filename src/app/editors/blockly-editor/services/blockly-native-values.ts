import { materializePreparedProjectDataPayload, isAilyDataRef, collectProjectDataReferences } from '@domain/project/project-data/public-api';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import type { NativeCandidateRequest } from './blockly-native-candidate-protocol';

/** A disposable value snapshot, not a Project Data store or a second asset format. */
export function nativeCandidateValues(entries: NativeCandidateRequest['values'] = []) {
  const byId = new Map<string, NonNullable<NativeCandidateRequest['values']>[number]>();
  for (const entry of entries) {
    if (!entry || !isAilyDataRef(entry.ref) || byId.has(entry.ref.$ailyData.id)) throw new Error('Native candidate resource snapshot has invalid or duplicate references.');
    byId.set(entry.ref.$ailyData.id, structuredClone(entry));
  }
  const get = (ref: Parameters<typeof isAilyDataRef>[0]): unknown => {
    if (!isAilyDataRef(ref)) throw new Error('Native candidate resource reference is invalid.');
    const entry = byId.get(ref.$ailyData.id);
    if (!entry || absJson(entry.ref) !== absJson(ref)) throw new Error('Native candidate resource was not prepared or its metadata changed.');
    return structuredClone(entry.value); // Callbacks cannot mutate another consumer's snapshot.
  };
  return {
    get,
    materialize: <T>(value: T): T => materializePreparedProjectDataPayload(value, get),
    assertReferences: (value: unknown): void => { for (const ref of collectProjectDataReferences(value)) get(ref); },
  };
}
