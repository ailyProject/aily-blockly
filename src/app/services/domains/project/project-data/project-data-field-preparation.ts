import type * as Blockly from 'blockly';
import type { AilyDataRef } from './project-data.types';

export type PreparedDataReader = (ref: AilyDataRef) => unknown;
type Preparation = (field: Blockly.Field, read: PreparedDataReader) => Promise<void>;
// Populated by bundled field modules, never exposed to replayed library scripts.
const preparations = new WeakMap<object, { hook: Function; prepare: Preparation }>();

export function registerNativeFieldPreparation(prototype: object, prepare: Preparation): void {
  const hook = (prototype as any).prepareForCodeGeneration;
  if (typeof hook !== 'function' || preparations.has(prototype)) throw new Error('Invalid or duplicate native field preparation.');
  preparations.set(prototype, { hook, prepare });
}

/** Only host-owned preparations run here; library hooks are not a readiness protocol. */
export async function prepareNativeProjectDataFields(workspace: Blockly.Workspace,
  read: PreparedDataReader, assertCurrent: () => void): Promise<void> {
  for (const block of workspace.getAllBlocks(false)) for (const input of block.inputList) for (const field of input.fieldRow) {
    const hook = (field as any).prepareForCodeGeneration;
    let owner: object | null = field, registration: { hook: Function; prepare: Preparation } | undefined;
    while (owner && !registration) { registration = preparations.get(owner); owner = Object.getPrototypeOf(owner); }
    if (!registration && typeof hook !== 'function') continue;
    // A required bundled protocol cannot be removed or masked with null/undefined.
    if (!registration || registration.hook !== hook) throw new Error(`Native field has unregistered asynchronous derived-resource preparation: ${block.type}.${field.name}.`);
    assertCurrent();
    await registration.prepare(field, read);
    assertCurrent();
    if ((field as any).prepareForCodeGeneration !== hook) throw new Error('Native field preparation changed during execution.');
  }
}
