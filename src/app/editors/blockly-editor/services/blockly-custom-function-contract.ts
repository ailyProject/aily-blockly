import type * as Blockly from 'blockly';
import { sha256Hex } from '../../../utils/crypto.utils';

export type CustomFunctionKind = 'definition' | 'statement-call' | 'value-call';
const kinds: Record<string, CustomFunctionKind> = { custom_function_def: 'definition',
  custom_function_call_advance: 'statement-call', custom_function_call_return_advance: 'value-call' };
const scriptTypes = Object.keys(kinds).filter(type => kinds[type] !== 'definition');

// Audited original and identity-preserving sources, normalized LF.
// Names/version strings alone are not provenance.
const legacySourceHashes = new Set([
  '4d3a8f44d8fbeffc76bdfe6648fa076e2474505ab359a81cd64bfa98aaef592b',
  'f19d9900bbaf14bcb159bc8e4f62bb5cce82af27e7265b90af5369ae2caaa10d',
]);
const sourceHashes = new Set([
  ...legacySourceHashes,
  // Audited local-symbol scope provider; native function/model effects are unchanged.
  '95a7020bc863c88fd49da23fec16479931a4f24a791558d8f2cb9787089e8ed7',
]);
export interface CustomFunctionRegistration {
  get(type: string): { kind: CustomFunctionKind; parameterTypes: string[] } | undefined;
  assertCurrent(): void;
  synchronize(workspace: Blockly.Workspace, state: any): void;
  prepareSerialization(workspace: Blockly.Workspace, commitLoadedNames?: boolean): void;
}
const registrations = new WeakMap<object, { owner: object; capture(): CustomFunctionRegistration }>();
export function captureCustomFunctionRegistration(registry: object): CustomFunctionRegistration | undefined {
  return registrations.get(registry)?.capture();
}
export function clearCustomFunctionRegistration(registry: object, owner: object): void {
  if (registrations.get(registry)?.owner === owner) registrations.delete(registry);
}

/** Attest the actual loaded source and registration surfaces, within the existing project Realm. */
export async function registerCustomFunctionContract(source: string, realm: any, registry: Record<string, any>, owner: object, isCurrent: () => boolean) {
  if (!source.includes('var functionParamsMutator =')) return;
  // The loader executes generator.js before registering block.json. Only the
  // caller definitions belong to the script; the definition has catalog provenance.
  const objects = [realm.functionParamsMutator, realm.functionCallSyncMutator, ...scriptTypes.map(type => registry[type])];
  const descriptors = objects.map(object => object && Object.getOwnPropertyDescriptors(object));
  const prototypes = objects.map(object => object && Object.getPrototypeOf(object));
  const functions = [...new Set([...source.matchAll(/function\s+(\w+)\s*\(/g)].map(match => match[1]))]
    .filter(name => typeof Object.getOwnPropertyDescriptor(realm, name)?.value === 'function')
    .map(name => [name, realm[name]] as const);
  const extension = realm.Blockly.Extensions.TEST_ONLY?.allExtensions?.function_params_mutator;
  const intact = () => isCurrent() && objects.every((object, index) => {
    if (!object || Object.getPrototypeOf(object) !== prototypes[index]) return false;
    const now = Object.getOwnPropertyDescriptors(object), before = descriptors[index]!;
    return Reflect.ownKeys(now).length === Reflect.ownKeys(before).length && Reflect.ownKeys(before).every(key =>
      ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(part => Reflect.get(now, key)?.[part] === Reflect.get(before, key)[part]));
  }) && scriptTypes.every((type, index) => registry[type] === objects[index + 2])
    && realm.functionParamsMutator === objects[0] && realm.functionCallSyncMutator === objects[1]
    && functions.every(([name, value]) => Object.getOwnPropertyDescriptor(realm, name)?.value === value)
    && typeof extension === 'function' && realm.Blockly.Extensions.TEST_ONLY?.allExtensions?.function_params_mutator === extension;

  const sourceHash = await sha256Hex(source.replace(/\r\n/g, '\n'));
  if (!sourceHashes.has(sourceHash) || !intact()) return;
  const registration = { owner, capture: () => {
    let used = false;
    const definition = registry['custom_function_def'];
    const init = definition && Object.getOwnPropertyDescriptor(definition, 'init')?.value;
    const prototype = definition && Object.getPrototypeOf(definition);
    const options = () => realm.__BLOCKLY_LIB_I18N__?.['@aily-project/lib-core-functions']?.extensions?.function_params_mutator?.param_type_options
      ?? realm._PARAM_TYPE_OPTIONS_FALLBACK;
    const initialOptions = JSON.stringify(options());
    const current = () => intact() && JSON.stringify(options()) === initialOptions
      && definition && registry['custom_function_def'] === definition && Object.getPrototypeOf(definition) === prototype
      && Reflect.ownKeys(definition).length === 1 && typeof init === 'function'
      && Object.getOwnPropertyDescriptor(definition, 'init')?.value === init;
    const assertCurrent = () => { if (used && !current()) throw new Error('Custom function runtime contract changed.'); };
    const get: CustomFunctionRegistration['get'] = type => {
      if (!Object.hasOwn(kinds, type) || !current()) return undefined;
      const values = options();
      if (!Array.isArray(values) || values.some(value => !Array.isArray(value) || typeof value[1] !== 'string')) return undefined;
      used = true;
      return { kind: kinds[type], parameterTypes: [...new Set<string>(values.map(value => value[1]).filter(value => value !== '---'))] };
    };
    const synchronize: CustomFunctionRegistration['synchronize'] = (workspace, state) => {
      if (!get('custom_function_def')) return;
      assertCurrent();
      const registryState = Object.create(null);
      const visit = (block: any) => {
        if (get(block.type)?.kind === 'definition') {
          const instance: any = workspace.getBlockById(block.id);
          if (!instance) throw new Error('Missing custom function instance after loading.');
          instance._funcLastName = block.fields.FUNC_NAME;
          registryState[block.fields.FUNC_NAME] = { name: block.fields.FUNC_NAME, params: block.extraState.params,
            returnType: block.fields.RETURN_TYPE, variableId: block.extraState.funcVarId, paramVarIds: block.extraState.paramVarIds };
        }
        for (const input of Object.values<any>(block.inputs ?? {})) for (const child of [input.block, input.shadow]) if (child) visit(child);
        if (block.next?.block) visit(block.next.block);
      };
      for (const block of state.blocks.blocks) visit(block);
      // Derived lookup only: never create/rename/delete models or invoke library initialization/toolbox callbacks.
      realm.customFunctionRegistry = JSON.parse(JSON.stringify(registryState));
      assertCurrent();
    };
    return { get, assertCurrent, synchronize, prepareSerialization: (workspace, commitLoadedNames = false) => {
      if (!get('custom_function_def')) return;
      // The library's delayed listener attachment can clear its lookup after
      // loading. Derive it from definitions before serializing any callers;
      // never depend on a timer/FinishedLoading or serialize callers to rebuild it.
      const blocks = workspace.getAllBlocks(false).filter(block => get(block.type)?.kind === 'definition').map(block => ({
        type: block.type, id: block.id,
        // A text editor may contain an uncommitted rename. Ordinary snapshots
        // must not advance the library's onFinishEditing_ name checkpoint.
        fields: { FUNC_NAME: commitLoadedNames ? block.getFieldValue('FUNC_NAME') : (block as any)._funcLastName || block.getFieldValue('FUNC_NAME'),
          RETURN_TYPE: block.getFieldValue('RETURN_TYPE') },
        extraState: objects[0].saveExtraState.call(block),
      }));
      synchronize(workspace, { blocks: { blocks } });
    } };
  } };
  registrations.set(registry, registration);

  // Keep selected, audited older library versions interoperable with model
  // symbols. The compatibility boundary owns this proven private binding
  // schema; the generator itself only consumes the public local-scope API.
  const generator = realm.Arduino;
  if (legacySourceHashes.has(sourceHash) && typeof generator?.registerModelSymbolLocalScope === 'function') {
    generator.registerModelSymbolLocalScope('core-functions.legacy-parameters', (block: Blockly.Block, model: any) => {
      if (kinds[block.type] !== 'definition' || model.getType() !== '' || realm.Arduino !== generator
        || registrations.get(registry) !== registration || !isCurrent()) return false;
      if (registration.capture().get(block.type)?.kind !== 'definition') return false;
      const instance = block as any, variables = block.workspace.getVariableMap();
      // Never serialize here: the library's saveExtraState ensures IDs and can
      // mutate metadata. Resolve the existing native binding without effects.
      return (instance.params_ || []).some((parameter: any, index: number) => {
        const id = (instance.paramVarIds_ || [])[index];
        const bound = (id && variables.getVariableById(id)) || variables.getVariable(parameter.name, '');
        return !!bound && bound.getId() === model.getId();
      });
    });
  }
}
