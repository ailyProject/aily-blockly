import type * as Blockly from 'blockly';

export interface NativeInputDeclaration {
  input: Blockly.Input;
  fields: readonly Blockly.Field[];
}
interface NativeStructureTrace {
  definition: object;
  init: Function;
  inputs: NativeInputDeclaration[];
  methods: Array<{ target: any; name: string; wrapper: Function }>;
  jsonArguments?: Array<{ type: string; name: string }>;
}
/** Each native Realm owns its observations; only actual construction is recorded. */
export function createNativeStructureObserver() {
  const traces = new WeakMap<Blockly.Block, NativeStructureTrace>();
  const definitions = new WeakMap<object, Function>();

  /** Observe real construction once. No callback inspection, probes or global prototype patches. */
  function observeNativeBlockDefinition(definition: object): void {
    const descriptor = Object.getOwnPropertyDescriptor(definition, 'init');
    const original = descriptor?.value;
    if (typeof original !== 'function' || definitions.get(definition) === original || !descriptor!.writable && !descriptor!.configurable) return;
    const init = function(this: Blockly.Block, ...args: unknown[]) {
      observeBlock(this, definition, init);
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(definition, 'init', Object.assign({}, descriptor, { value: init }));
    definitions.set(definition, init);
  }

  function observeBlock(block: Blockly.Block, definition: object, init: Function): void {
    if (traces.has(block)) return;
    const trace: NativeStructureTrace = { inputs: [], methods: [], definition, init };
    traces.set(block, trace);
    // jsonInit may be called directly by a JS-defined block, without defineBlocksWithJsonArray.
    // Capture declaration order before construction; never clone field values/callbacks or inspect source code.
    const jsonInit = block.jsonInit;
    const jsonWrapper = function(this: Blockly.Block, json: Record<string, any>) {
      if (this === block) {
        trace.jsonArguments ??= [];
        for (const key of Object.keys(json).filter(key => /^args\d+$/.test(key)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))) {
          if (!Array.isArray(json[key])) continue;
          for (const arg of json[key]) if (typeof arg?.name === 'string' && typeof arg?.type === 'string') {
            trace.jsonArguments.push({ type: arg.type, name: arg.name });
          }
        }
      }
      return Reflect.apply(jsonInit, this, [json]);
    };
    Object.defineProperty(block, 'jsonInit', { value: jsonWrapper, configurable: true, writable: true });
    trace.methods.push({ target: block, name: 'jsonInit', wrapper: jsonWrapper });
    const wrap = (target: any, name: string, after: (args: any[], result: any) => void) => {
      const method = target[name];
      if (typeof method !== 'function') return;
      const wrapper = function(this: any, ...args: unknown[]) {
        const result = Reflect.apply(method, this, args);
        if (this === target) after(args, result);
        return result;
      };
      Object.defineProperty(target, name, { value: wrapper, configurable: true, writable: true });
      trace.methods.push({ target, name, wrapper });
    };
    wrap(block, 'appendInput', ([input]) => {
      const entry: NativeInputDeclaration = { input, fields: [...input.fieldRow] };
      trace.inputs.push(entry);
      for (const name of ['appendField', 'insertFieldAt', 'removeField']) {
        wrap(input, name, () => { entry.fields = [...input.fieldRow]; });
      }
    });
    wrap(block, 'removeInput', ([name]) => {
      const removed = new Set(trace.inputs.filter(entry => entry.input.name === name).map(entry => entry.input));
      trace.inputs = trace.inputs.filter(entry => !removed.has(entry.input));
      trace.methods = trace.methods.filter(entry => !removed.has(entry.target));
    });
    wrap(block, 'moveNumberedInputBefore', ([from, to]) => {
      const [entry] = trace.inputs.splice(from, 1);
      if (entry) trace.inputs.splice(to > from ? to - 1 : to, 0, entry);
    });
  }

  /** inputList is only an integrity check, never the source of argument order. */
  function readNativeBlockStructure(block: Blockly.Block, definition?: object | null): readonly NativeInputDeclaration[] | undefined {
    const trace = traces.get(block);
    if (!trace || trace.inputs.length !== block.inputList.length
      || definition !== undefined && (trace.definition !== definition || Object.getOwnPropertyDescriptor(definition ?? {}, 'init')?.value !== trace.init)
      || trace.methods.some(({ target, name, wrapper }) => target[name] !== wrapper)
      || trace.inputs.some((entry, i) => block.inputList[i] !== entry.input
        || entry.fields.length !== entry.input.fieldRow.length || entry.fields.some((field, j) => entry.input.fieldRow[j] !== field))) return undefined;
    return trace.inputs;
  }
  function readNativeBlockJson(block: Blockly.Block): Record<string, any> | undefined {
    if (!readNativeBlockStructure(block)) return undefined;
    const args = traces.get(block)?.jsonArguments;
    return args && { type: block.type, args0: args.map(arg => ({ ...arg })) };
  }
  return { observeNativeBlockDefinition, readNativeBlockStructure, readNativeBlockJson };
}

export const { observeNativeBlockDefinition, readNativeBlockStructure, readNativeBlockJson } = createNativeStructureObserver();
