import type * as Blockly from 'blockly';
import { collectProjectBlocks } from '@domain/project/project-data/public-api';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { serializeRuntimeFieldContract } from './blockly-runtime-block-metadata';
import { NativeOwnedOperation, retireNativeInputDefault, withNativeBlockCreation } from './blockly-native-block-effects';

type FieldOrder = (block: Blockly.Block) => readonly string[] | undefined;

/** Keep the two observed legacy U8G2 symbols on their live field instances
 * when a published picker omits them. */
function retainLegacyU8g2Font(block: Blockly.Block, field: Blockly.Field, name: string, value: unknown): void {
  if (block.type !== 'u8g2_set_font' || name !== 'FONT') return;
  const oldPicker = !block.getField('SIZE') && !block.getField('FONT_TYPE');
  if (!(value === 'u8g2_font_wqy13_t_chinese2'
    && (oldPicker || block.getFieldValue('SIZE') === '14' && block.getFieldValue('FONT_TYPE') === 'CHINESE'))
    && !(oldPicker && value === 'u8g2_font_wqy12_t_chinese1')) return;
  const dropdown = field as Blockly.FieldDropdown;
  if (typeof dropdown.getOptions !== 'function') return;
  const options = dropdown.getOptions(false);
  if (options.some(option => option[1] === value)) return;
  // Blockly exposes no public method to append one option. This changes only
  // the live field instance, never the registered library definition.
  (dropdown as any).menuGenerator_ = [...options, ['旧项目字体', value]];
}

function retainLegacySscmaSerial(block: Blockly.Block, field: Blockly.Field, name: string, value: unknown): void {
  if (block.type !== 'sscma_begin_serial' || name !== 'SERIAL' || value !== 'SerialCustom') return;
  const dropdown = field as Blockly.FieldDropdown;
  if (typeof dropdown.getOptions !== 'function') return;
  const options = dropdown.getOptions(false);
  if (!options.some(option => option[1] === value)) {
    // The companion serial_begin_esp32_custom block declares this exact port.
    (dropdown as any).menuGenerator_ = [...options, ['SerialCustom（旧项目）', value]];
  }
}

/** A previous U8G2 release stored the buffer mode in RESOLUTION and had no
 * MODE/pin fields. Reverse only the exact default configuration for that live
 * definition; newer releases keep the normalized values unchanged. */
function adaptLegacyU8g2Begin(block: Blockly.Block, values: Record<string, any>): Record<string, any> {
  if (block.type !== 'u8g2_begin' || block.getField('MODE') || values['TYPE'] !== 'SSD1306'
    || values['MODE'] !== 'FULL_BUFFER' || values['RESOLUTION'] !== '128X64_NONAME') return values;
  const resolution = block.getField('RESOLUTION') as Blockly.FieldDropdown | null;
  if (!resolution || typeof resolution.getOptions !== 'function'
    || !resolution.getOptions(false).some(option => option[1] === '128X64_NONAME_F')) return values;
  const adapted = { ...values, RESOLUTION: '128X64_NONAME_F' };
  delete adapted['MODE'];
  for (const [name, value] of Object.entries({ SCL_PIN: 'SCL', SDA_PIN: 'SDA', RESET_PIN: 'U8X8_PIN_NONE' })) {
    if (!block.getField(name) && adapted[name] === value) delete adapted[name];
  }
  return adapted;
}

function adaptLegacyU8g2Font(block: Blockly.Block, values: Record<string, any>): Record<string, any> {
  if (block.type !== 'u8g2_set_font' || block.getField('SIZE') || block.getField('FONT_TYPE')
    || values['FONT_TYPE'] !== 'CHINESE'
    || !(values['SIZE'] === '14' && values['FONT'] === 'u8g2_font_wqy13_t_chinese2'
      || values['SIZE'] === '8' && values['FONT'] === 'u8g2_font_wqy12_t_chinese1')) return values;
  const font = block.getField('FONT') as Blockly.FieldDropdown | null;
  if (!font || typeof font.getOptions !== 'function') return values;
  const adapted = { ...values };
  delete adapted['SIZE']; delete adapted['FONT_TYPE'];
  return adapted;
}

const TFT_SPI_NUMBERS = ['WIDTH', 'HEIGHT', 'MISO', 'MOSI', 'SCLK', 'CS', 'DC', 'RST', 'BL'] as const;

/** lib-tft-espi published both field-based and value-input-based setup blocks.
 * Adapt only scalar number children/fields to the shape actually installed for
 * this project. The saved ABI and library definition remain untouched. */
function adaptLegacyTftSetup(block: Blockly.Block, savedFields: Record<string, any>, savedInputs: Record<string, any>) {
  if (block.type !== 'tftespi_setup') return { fields: savedFields, inputs: savedInputs };
  const fields = { ...savedFields }, inputs = { ...savedInputs };
  for (const name of TFT_SPI_NUMBERS) {
    const hasConnection = !!block.getInput(name)?.connection;
    if (hasConnection && !block.getField(name) && Object.hasOwn(fields, name) && !Object.hasOwn(inputs, name)) {
      const value = String(fields[name]);
      if (!/^-?\d+(?:\.\d+)?$/.test(value)) continue;
      inputs[name] = { shadow: { type: 'math_number', fields: { NUM: Number(value) } } };
      delete fields[name];
    } else if (block.getField(name) && !hasConnection && !Object.hasOwn(fields, name)) {
      const slot = inputs[name];
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)
        || Object.keys(slot).length !== 1) continue;
      const child = slot.block ?? slot.shadow;
      if (!child || child.type !== 'math_number' || !child.fields
        || Object.keys(child.fields).length !== 1 || !Object.hasOwn(child.fields, 'NUM')
        || Object.keys(child).some(key => !['type', 'id', 'fields'].includes(key))) continue;
      const value = Number(child.fields.NUM);
      if (!Number.isFinite(value)) continue;
      fields[name] = String(value);
      delete inputs[name];
    }
  }
  // Older GC9A01 configurations also saved QSPI defaults, which the newer
  // SPI-only definition does not expose. Keep non-default or unknown values
  // strict instead of silently discarding an actual pin choice.
  if (fields['MODEL'] === 'GC9A01_DRIVER') {
    const defaults: Record<string, string> = {
      QSPI_CS: String(savedFields['CS']), QSPI_SCLK: String(savedFields['SCLK']),
      QSPI_RST: String(savedFields['RST']), D0: '-1', D1: '-1', D2: '-1', D3: '-1', TE: '-1',
    };
    for (const [name, value] of Object.entries(defaults)) {
      if (!block.getField(name) && !block.getInput(name) && fields[name] === value) delete fields[name];
    }
  }
  return { fields, inputs };
}

/** Restore requested fields against the live shape, never a probe or a guessed slot.
 * A field is loaded once per actual Field instance. A selector may replace an
 * earlier field; that new instance must receive its saved value too.
 */
export function restoreNativeFields(block: Blockly.Block, values: Record<string, any>, order?: FieldOrder,
  loadState: (field: Blockly.Field, value: unknown) => void = (field, value) => field.loadState(value)): string[] {
  values = adaptLegacyU8g2Font(block, adaptLegacyU8g2Begin(block, values));
  const names = Object.keys(values);
  const applied = new Map<string, { field: Blockly.Field; value: string }>();
  let remaining = names.length * (names.length + 1);
  while (true) {
    const sequence = [...new Set([...(order?.(block) ?? []), ...names])];
    const name = sequence.find(name => {
      if (!Object.hasOwn(values, name)) return false;
      const field = block.getField(name);
      if (!field || applied.get(name)?.field === field) return false;
      retainLegacyU8g2Font(block, field, name, values[name]);
      retainLegacySscmaSerial(block, field, name, values[name]);
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
      const savedInputs = entry['inputs'];
      let tftView: ReturnType<typeof adaptLegacyTftSetup> | undefined;
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
      const loadingView = (block: Blockly.Block) => tftView ??= adaptLegacyTftSetup(
        block, fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {},
        savedInputs && typeof savedInputs === 'object' && !Array.isArray(savedInputs) ? savedInputs : {});
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
          return key === 'inputs' && block && entry['type'] === 'tftespi_setup'
            ? loadingView(block).inputs : value;
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
            orders.set(block.id, restoreNativeFields(block,
              entry['type'] === 'tftespi_setup' ? loadingView(block).fields : fields as Record<string, any>, order,
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
