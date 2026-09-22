import type * as Blockly from 'blockly';
import type { NativeVariableState } from './blockly-native-candidate-protocol';
import { assertAbsReadback } from '../../../integrations/blockly/abs/abs-readback';
import { AbsSymbols } from '../../../integrations/blockly/abs/abs-symbols';
import type { AbsFieldDefinition, AbsFieldToken } from '../../../integrations/blockly/abs/abs-field-values';
import { adoptAbsNativeModels, type AbsNativeModelDeclaration } from '../../../integrations/blockly/abs/abs-native-model-declarations';

/** Exact owned inputs, extended only by an observed initializer registration. */
export class NativeCandidateModels {
  private readonly expected: NativeVariableState[];

  constructor(readonly workspace: Blockly.Workspace, variables: readonly NativeVariableState[] = []) {
    this.expected = structuredClone([...variables]);
  }

  load(): void {
    for (const variable of this.expected) this.workspace.createVariable(variable.name, variable.type ?? '', variable.id);
    this.assertCurrent();
  }

  resolve(token: AbsFieldToken, definition: AbsFieldDefinition): unknown {
    return new AbsSymbols({ blocks: { blocks: [] }, variables: this.expected }, null, { fields: {} }).resolve(token, definition.symbol!);
  }

  declare(start: number, blockType: string, name: string, type: string, requestId: string): AbsNativeModelDeclaration {
    this.assertCurrent();
    const existing = this.expected.find(model => model.name.toLowerCase() === String(name).toLowerCase());
    const declaration = { start, blockType, name, type, id: existing?.id ?? `abs-model:${requestId}:${start}:${this.expected.length}` };
    const state = { blocks: { blocks: [] }, variables: this.expected };
    adoptAbsNativeModels(state, [declaration]);
    if (!existing) {
      this.workspace.createVariable(name, type, declaration.id);
      this.expected.push({ id: declaration.id, name, type });
    }
    this.assertCurrent();
    return declaration;
  }

  assertCurrent(serialized?: unknown): void {
    const actual = serialized ?? this.workspace.getAllVariables().map(model => ({ id: model.getId(), name: model.name, type: model.type }));
    try {
      assertAbsReadback({ blocks: { blocks: [] }, variables: this.expected }, { blocks: { blocks: [] }, variables: actual });
    } catch (error) {
      throw new Error(`Native candidate changed unrequested blocks or models (variable ownership): ${String(error)}`);
    }
  }
}
