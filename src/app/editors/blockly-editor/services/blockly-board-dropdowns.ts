import * as Blockly from 'blockly';
import { resolveBoardJsonBindings } from '../components/blockly/board-json-bindings';
import { collectProjectBlocks } from '@domain/project/project-data/public-api';

type Options = ReturnType<Blockly.FieldDropdown['getOptions']>;
type SavedBlock = { type: string; fields: Map<string, string> };
type Selections = { fields: Map<string, SavedBlock>; serial: Map<string, Set<string>> };
type Dropdown = Blockly.FieldDropdown;
const nativeOptions = Blockly.FieldDropdown.prototype.getOptions;

function trackSerial(selections: Selections, id: string, value: string): void {
  let ids = selections.serial.get(value);
  if (!ids) selections.serial.set(value, ids = new Set());
  ids.add(id);
}
const bindings = new WeakMap<object, Map<string, string>>();
const selections = new WeakMap<Blockly.Workspace, Selections>();

/** Only a library's explicit ${board.key} dropdown declaration owns these options. */
export function recordBoardDropdowns(definition: object, source: any): void {
  const fields = new Map<string, string>();
  for (const key of Object.keys(source)) {
    if (!/^args\d+$/.test(key) || !Array.isArray(source[key])) continue;
    for (const arg of source[key]) {
      const boardKey = arg?.type === 'field_dropdown' && typeof arg.options === 'string'
        && /^\$\{board\.([A-Za-z_]\w*)\}$/.exec(arg.options)?.[1];
      if (boardKey && typeof arg.name === 'string') fields.set(arg.name, boardKey);
    }
  }
  if (fields.size) bindings.set(definition, fields);
}

export function rememberSavedBoardSelections(workspace: Blockly.Workspace, document: unknown): void {
  const savedChoices: Selections = { fields: new Map(), serial: new Map() };
  for (const { state } of collectProjectBlocks(document)) {
    if (typeof state['id'] !== 'string' || typeof state['type'] !== 'string') continue;
    const declared = bindings.get(Blockly.Blocks[state['type']]);
    if (!declared) continue;
    const saved = new Map<string, string>();
    for (const [name, key] of declared) {
      const value = (state['fields'] as Record<string, unknown> | undefined)?.[name];
      if (typeof value !== 'string') continue;
      saved.set(name, value);
      if (key === 'serialPort' && name === 'SERIAL') trackSerial(savedChoices, state['id'], value);
    }
    if (saved.size) savedChoices.fields.set(state['id'], { type: state['type'], fields: saved });
  }
  selections.set(workspace, savedChoices);
}

export function forgetSavedBoardSelections(workspace: Blockly.Workspace): void {
  selections.delete(workspace);
}

const hasValue = (options: Options, value: string) =>
  options.some(option => Array.isArray(option) && option[1] === value);

export function retainSavedBoardOption(block: Blockly.Block, field: Blockly.Field, name: string, value: unknown): void {
  const context = selections.get(block.workspace);
  const saved = context?.fields.get(block.id);
  if (!(field instanceof Blockly.FieldDropdown) || field instanceof Blockly.FieldVariable || typeof value !== 'string'
    || saved?.type !== block.type || saved.fields.get(name) !== value
    || !bindings.get(Blockly.Blocks[block.type])?.has(name)) return;
  const read = field.getOptions;
  if (hasValue(read.call(field, false), value)) return;
  field.getOptions = function(useCache) {
    const options = read.call(this, useCache);
    return selections.get(block.workspace) !== context || hasValue(options, value) ? options : [...options, [value, value]];
  };
}

/** Old serial libraries reset an absent selection in their delayed UI callback.
 * Extend that dropdown provider alone. Keep the board's hardware metadata intact. */
export function preserveLegacySerialChoices(realm: any, workspace: () => Blockly.Workspace | null): void {
  const original = realm.generateSerialPortOptionsWithCustom;
  if (typeof original !== 'function') return;
  realm.generateSerialPortOptionsWithCustom = function(...args: unknown[]) {
    const options = Reflect.apply(original, this, args) as Options;
    const current = workspace();
    const serial = current && selections.get(current)?.serial;
    if (!serial || !Array.isArray(options)) return options;
    const missing: string[] = [];
    for (const [value, ids] of serial) {
      if (!hasValue(options, value) && [...ids].some(id => current!.getBlockById(id)?.getFieldValue('SERIAL') === value)) {
        missing.push(value);
      }
    }
    return missing.length ? [...options, ...missing.map(value => [value, value])] : options;
  };
}

export function changedBoardKeys(previous: any, board: any): Set<string> {
  return new Set([...new Set([...Object.keys(previous ?? {}), ...Object.keys(board ?? {})])]
    .filter(key => JSON.stringify(previous?.[key]) !== JSON.stringify(board?.[key])));
}

const liveProviders = new WeakMap<Dropdown, { original: Dropdown['getOptions']; wrapper: Dropdown['getOptions'] }>();

/** Change menus and display labels without running field validators or choosing
 * a new value. Blockly.setOptions() selects the first item and emits an edit. */
export function refreshLiveBoardDropdowns(workspace: Blockly.Workspace, previous: any, board: any, changed: Set<string>): void {
  const menus = new Map<string, Options>();
  const context = selections.get(workspace);
  for (const block of workspace.getAllBlocks(false)) {
    const declared = bindings.get(Blockly.Blocks[block.type]);
    if (!declared) continue;
    for (const [name, key] of declared) {
      if (!changed.has(key) || !Array.isArray(board?.[key])) continue;
      const field = block.getField(name);
      if (!(field instanceof Blockly.FieldDropdown) || field instanceof Blockly.FieldVariable) continue;
      const value = field.getValue();
      if (typeof value !== 'string') continue;
      if (context && key === 'serialPort' && name === 'SERIAL') trackSerial(context, block.id, value);
      if (!menus.has(key)) {
        menus.set(key, resolveBoardJsonBindings({ type: 'field_dropdown', options: '${board.' + key + '}' }, board).options);
      }
      const menu = menus.get(key)!;
      const before = previous?.[key];
      const project = (source: Options) => {
        const next = [...menu];
        const current = field.getValue();
        for (const option of source) {
          if (Array.isArray(option) && !hasValue(next, option[1])
            && (option[1] === current || !Array.isArray(before) || !hasValue(before, option[1]))) next.push(option);
        }
        if (typeof current === 'string' && !hasValue(next, current)) next.push([current, current]);
        return next;
      };
      const oldLabel = field.getText();
      const generator = field['menuGenerator_'];
      if (field.getOptions === nativeOptions && Array.isArray(generator)) {
        field['menuGenerator_'] = project(generator);
      } else {
        // Library providers can add or remove custom ports later. Keep calling
        // them and let a subsequent native setOptions() take full ownership.
        const last = liveProviders.get(field);
        const original = field.getOptions === last?.wrapper ? last.original : field.getOptions;
        const wrapper: Dropdown['getOptions'] = function(useCache) {
          const current = original.call(this, useCache);
          return selections.get(workspace) === context && this['menuGenerator_'] === generator ? project(current) : current;
        };
        liveProviders.set(field, { original, wrapper });
        field.getOptions = wrapper;
      }
      // Base dropdown updates its selected label and ARIA without an edit event.
      Blockly.FieldDropdown.prototype['doValueUpdate_'].call(field, value);
      if (field.getText() !== oldLabel) field.forceRerender();
    }
  }
}
