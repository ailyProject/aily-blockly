import { captureBlocklyUiExtensionContracts } from './blockly-ui-extension-contracts';
import { captureBundledProcedureRegistration } from '../components/blockly/plugins/block-plus-minus/src/procedures.js';
import { captureCustomFunctionRegistration, CustomFunctionRegistration } from './blockly-custom-function-contract';
import { captureVariableDeclarationRegistration, VariableDeclarationRegistration } from './blockly-variable-declaration-contract';
import { captureStructuralMutators, StructuralMutationRecipe } from '../components/blockly/plugins/block-plus-minus/src/structural-mutators';
import { captureBlocklyFieldShapes, BlocklyFieldShapeRule } from './blockly-field-shape-contracts';
import { observeNativeBlockDefinition, readNativeBlockStructure, readNativeBlockJson } from './blockly-native-structure';

export interface DeclarativeBlockSnapshot {
  readonly types: readonly string[];
  registered(type: string): boolean;
  get(type: string): Record<string, any> | undefined;
  supportsUiExtension?(name: string): boolean;
  structuralMutator?(name: string): StructuralMutationRecipe | undefined;
  fieldShape?(name: string): readonly BlocklyFieldShapeRule[] | undefined;
  nativeStructure?: typeof readNativeBlockStructure;
  nativeJson?: typeof readNativeBlockJson;
  procedure?(type: string): { role: 'definition' | 'call'; returns: boolean } | undefined;
  customFunctions?: CustomFunctionRegistration;
  variableDeclarations?: VariableDeclarationRegistration;
  assertCurrent(): void;
}

/** Registration provenance, not inferred metadata or a workspace of probe blocks.
 * Owned and cleared by the project editor, alongside the existing runtime registry.
 */
export class BlocklyDeclarativeBlockCatalog {
  private revision = 0;
  private readonly nativeDefinitions = new Set<object>();
  private readonly retiredDefinitions = new WeakSet<object>();
  private readonly entries = new Map<string, { json: string; source: object; definition: object; prototype: object | null; init: unknown }>();

  record(source: Record<string, any>, definition: object): void {
    this.retiredDefinitions.delete(definition);
    observeNativeBlockDefinition(definition);
    this.entries.set(source['type'], { source, definition, prototype: Object.getPrototypeOf(definition), init: Object.getOwnPropertyDescriptor(definition, 'init')?.value,
      json: JSON.stringify(source) });
    this.revision++;
  }

  clear(): void {
    for (const definition of this.nativeDefinitions) this.retiredDefinitions.add(definition);
    for (const entry of this.entries.values()) this.retiredDefinitions.add(entry.definition);
    this.nativeDefinitions.clear(); this.entries.clear(); this.revision++;
  }

  capture(registry: Record<string, any>): DeclarativeBlockSnapshot {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(registry))) {
      if (descriptor.value && typeof descriptor.value === 'object') this.nativeDefinitions.add(descriptor.value);
    }
    const extensions = captureBlocklyUiExtensionContracts();
    const mutations = captureStructuralMutators();
    const fieldShapes = captureBlocklyFieldShapes();
    const procedures = captureBundledProcedureRegistration(registry);
    const customFunctions = captureCustomFunctionRegistration(registry);
    const variableDeclarations = captureVariableDeclarationRegistration(registry);
    const revision = this.revision;
    const used = new Map<string, object>();
    const intact = (type: string, entry: ReturnType<typeof this.entries.get>) => !!entry
      && registry[type] === entry.definition && Reflect.ownKeys(entry.definition).length === 1
      && Object.getPrototypeOf(entry.definition) === entry.prototype
      && Object.getOwnPropertyDescriptor(entry.definition, 'init')?.value === entry.init
      && typeof entry.init === 'function' && JSON.stringify(entry.source) === entry.json;
    const assertCurrent = () => {
      extensions.assertCurrent();
      mutations.assertCurrent();
      fieldShapes.assertCurrent();
      procedures.assertCurrent();
      customFunctions?.assertCurrent();
      variableDeclarations?.assertCurrent();
      if (revision !== this.revision || [...used].some(([type, entry]) => this.entries.get(type) !== entry || !intact(type, this.entries.get(type)))) {
        throw new Error('Declarative Blockly definitions changed during candidate preparation.');
      }
    };
    const nativeStructure: typeof readNativeBlockStructure = block => {
      const entry = this.entries.get(block.type);
      if (this.retiredDefinitions.has(registry[block.type])) return undefined;
      if (entry && !intact(block.type, entry)) return undefined;
      return readNativeBlockStructure(block, registry[block.type] ?? null);
    };
    return {
      types: Object.keys(registry).sort(),
      registered: type => typeof Object.getOwnPropertyDescriptor(registry[type] ?? {}, 'init')?.value === 'function',
      assertCurrent,
      supportsUiExtension: extensions.supports,
      structuralMutator: mutations.get,
      fieldShape: fieldShapes.get,
      nativeStructure,
      nativeJson: block => nativeStructure(block) ? readNativeBlockJson(block) : undefined,
      procedure: procedures.get,
      customFunctions,
      variableDeclarations,
      get: type => {
        assertCurrent();
        const entry = this.entries.get(type);
        if (!intact(type, entry)) return undefined;
        used.set(type, entry!);
        return JSON.parse(entry!.json);
      },
    };
  }
}
