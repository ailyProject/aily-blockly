import { cloneBlocklyJson } from '@domain/project/project-document-json';
import { AbsAbiWorkspace } from './abs-state';

/** Match Blockly's persisted JSON boundary, not raw optional members from custom saveState(). */
export function normalizeAbsSerializedWorkspace(value: Record<string, unknown>): AbsAbiWorkspace {
  const document = cloneBlocklyJson(value, member => {
    if (['function', 'symbol', 'bigint'].includes(typeof member)
      || (typeof member === 'number' && !Number.isFinite(member))) {
      throw new Error('Blockly serializer returned a non-JSON value.');
    }
    // Optional undefined object properties are omitted, as in the actual ABI JSON file.
  }) as unknown as AbsAbiWorkspace;
  return { ...document, blocks: document.blocks ?? { blocks: [] } };
}
