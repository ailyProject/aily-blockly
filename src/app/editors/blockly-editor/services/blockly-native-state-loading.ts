import type * as Blockly from 'blockly';
import { collectProjectBlocks } from '@domain/project/project-data/public-api';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { serializeRuntimeFieldContract } from './blockly-runtime-block-metadata';
import { NativeOwnedOperation, retireNativeInputDefault, withNativeBlockCreation } from './blockly-native-block-effects';

type FieldOrder = (block: Blockly.Block) => readonly string[] | undefined;

/** Restore requested fields against the live shape, never a probe or a guessed slot.
 * A field is loaded once per actual Field instance. A selector may replace an
 * earlier field; that new instance must receive its saved value too.
 */
export function restoreNativeFields(block: Blockly.Block, values: Record<string, any>, order?: FieldOrder,
  loadState: (field: Blockly.Field, value: unknown) => void = (field, value) => field.loadState(value)): string[] {
  const names = Object.keys(values);
  const applied = new Map<string, { field: Blockly.Field; value: string }>();
  let remaining = names.length * (names.length + 1);
  while (true) {
    const sequence = [...new Set([...(order?.(block) ?? []), ...names])];
    const name = sequence.find(name => {
      if (!Object.hasOwn(values, name)) return false;
      const field = block.getField(name);
      if (!field || applied.get(name)?.field === field) return false;
      const contract = serializeRuntimeFieldContract(field, values[name]);
      // An existing dropdown can depend on a later selector without being
      // replaced. Wait for its requested option instead of accepting a default.
      return contract.type !== 'field_dropdown' || contract.options!.some(option => option[1] === values[name]);
    });
    if (name === undefined) break;
    if (remaining-- <= 0) throw new Error(`Native field restoration did not stabilize: ${block.type}/${block.id}.`);
    const field = block.getField(name)!;
    loadState(field, structuredClone(values[name]));
    const value = absJson(field.saveState());
    if (serializeRuntimeFieldContract(field, values[name]).type === 'field_dropdown' && value !== absJson(values[name])) {
      throw new Error(`Native dropdown rejected saved value: ${block.type}/${block.id}/${name}.`);
    }
    applied.delete(name);
    applied.set(name, { field, value });
  }
  for (const name of names) {
    const field = block.getField(name), saved = applied.get(name);
    if (!field || !saved) throw new Error(`Cannot restore native field: ${block.type}/${block.id}/${name}.`);
    if (saved.field !== field || saved.value !== absJson(field.saveState())) {
      throw new Error(`Native field changed during restoration: ${block.type}/${block.id}/${name}.`);
    }
  }
  return [...applied.keys()];
}

/** Blockly reserializes shadow defaults during loading. Keep the proven execution
 * order in those in-memory defaults too, so a later native respawn needs no hook.
 * This is not persistent metadata: canonical ABI bytes remain order-independent.
 */
function orderShadowDefaults(blocks: Iterable<Blockly.Block>, orders: ReadonlyMap<string, readonly string[]>): void {
  const owners = new Set<Blockly.Block>();
  for (const block of blocks) {
    if (block.isDisposed()) continue;
    owners.add(block);
    const parent = block.getParent();
    if (parent) owners.add(parent);
  }
  for (const block of owners) {
    for (const connection of [...block.inputList.map(input => input.connection), block.nextConnection]) {
      const shadow = connection?.getShadowState();
      if (!shadow) continue;
      for (const { state } of collectProjectBlocks(shadow)) {
        const order = orders.get(state['id'] as string), fields = state['fields'];
        if (!order || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
        state['fields'] = Object.fromEntries([...new Set([...order, ...Object.keys(fields)])]
          .filter(name => Object.hasOwn(fields, name)).map(name => [name, fields[name]]));
      }
    }
  }
}

/** Synchronous adapter for the bundled native serializer's field/topology boundary.
 *
 * Native Blockly reads state.fields AFTER extraState/parent attachment and BEFORE
 * child inputs. A temporary accessor on the detached loading view restores fields
 * at that exact boundary, then returns an empty record to prevent double loading.
 * The native serializer still owns creation, models, shadows, connections and UI.
 * The shared creation scope associates requested IDs with actual instances and
 * attributes defaults from init/extraState/fields. No registry/prototype is patched.
 * All accessors and the workspace method are restored in finally, including errors.
 */
export function withNativeStateLoading<T>(native: typeof Blockly, workspace: Blockly.Workspace,
  state: unknown, load: () => T, order?: FieldOrder): T {
  const entries = collectProjectBlocks(state).map(({ state }) => state);
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = entry['id'];
    if (typeof id === 'string' && id) {
      if (ids.has(id)) throw new Error(`Duplicate block identity during native loading: ${id}.`);
      ids.add(id);
    }
  }
  const restore: Array<() => void> = [];
  const created = new Map<string, Blockly.Block>();
  const createdBy = new Map<Blockly.Block, string | undefined>();
  const claimed = new WeakSet<Blockly.Block>();
  const orders = new Map<string, readonly string[]>();
  let owned: NativeOwnedOperation;
  try {
    for (const entry of entries) {
      const fields = entry['fields'];
      if (!entry['id']) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, 'id');
        let id: string;
        do { id = native.utils.idGenerator.genUid(); } while (ids.has(id));
        ids.add(id); entry['id'] = id;
        restore.push(() => { if (descriptor) Object.defineProperty(entry, 'id', descriptor); else delete entry['id']; });
      }
      const current = () => {
        const block = created.get(entry['id'] as string);
        if (!block || block.isDisposed()) return undefined;
        if (block.type !== entry['type']) throw new Error('Invalid native loading boundary.');
        claimed.add(block);
        return block;
      };
      // An ABI is complete topology, not a new-block template: an absent slot is
      // empty. Discard only new, unclaimed defaults before native child loading.
      const prepared = new WeakSet<Blockly.Block>();
      for (const key of ['inputs', 'next']) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key), value = entry[key];
        Object.defineProperty(entry, key, { configurable: true, enumerable: !!descriptor?.enumerable, get() {
          const block = current();
          if (block && !prepared.has(block)) {
            owned(entry['id'] as string, () => {
              for (const connection of [...block.inputList.map(input => input.connection), block.nextConnection]) {
                if (connection) retireNativeInputDefault(connection,
                  item => createdBy.get(item) === entry['id'] && !claimed.has(item), true);
              }
            });
            prepared.add(block);
          }
          return value;
        } });
        restore.push(() => { if (descriptor) Object.defineProperty(entry, key, descriptor); else delete entry[key]; });
      }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) continue;
      const descriptor = Object.getOwnPropertyDescriptor(entry, 'fields')!;
      const loaded = new WeakSet<Blockly.Block>();
      let loading = false;
      Object.defineProperty(entry, 'fields', { configurable: true, enumerable: true, get() {
        const block = current();
        // Reads of dormant shadow state before construction are just data reads.
        if (!block) return fields;
        if (loading) throw new Error('Invalid native field loading boundary.');
        if (!loaded.has(block)) {
          loading = true;
          try {
            // Contract/saveState getters do not gain creation ownership.
            orders.set(block.id, restoreNativeFields(block, fields as Record<string, any>, order,
              (field, value) => owned(entry['id'] as string, () => field.loadState(value))));
            loaded.add(block);
          }
          finally { loading = false; }
        }
        return {};
      } });
      restore.push(() => Object.defineProperty(entry, 'fields', descriptor));
    }
    return withNativeBlockCreation(workspace, run => {
      owned = run;
      const result = load();
      orderShadowDefaults(created.values(), orders);
      return result;
    }, (block, id, owner) => {
      createdBy.set(block, owner);
      if (id) created.set(id, block);
      if (typeof block.loadExtraState === 'function') {
        const descriptor = Object.getOwnPropertyDescriptor(block, 'loadExtraState'), original = block.loadExtraState;
        Object.defineProperty(block, 'loadExtraState', { configurable: true, writable: true,
          value: function(this: Blockly.Block, ...args: unknown[]) {
            return owned(owner, () => Reflect.apply(original, this, args));
          },
        });
        restore.push(() => { if (descriptor) Object.defineProperty(block, 'loadExtraState', descriptor); else delete block.loadExtraState; });
      }
    });
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}
