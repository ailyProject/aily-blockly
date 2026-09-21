import type * as Blockly from 'blockly';
import type { NativeCandidateBlock, NativeCandidateResult } from './blockly-native-candidate-protocol';
import type { createNativeStructureObserver } from './blockly-native-structure';
import { NativeCandidateModels } from './blockly-native-models';
import { retireNativeInputDefault, withNativeBlockCreation, type NativeOwnedOperation } from './blockly-native-block-effects';
import { NativeDefaultCreations } from './blockly-native-defaults';
import type { AbsNativeCreation } from '../../../integrations/blockly/abs/abs-native-binding';
import { NativeShadowEvidence, type NativeShadowSnapshot } from './blockly-native-shadows';
import { captureNativeBlock } from './blockly-native-instance';
import { normalizeAbsSerializedWorkspace } from '../../../integrations/blockly/abs/abs-serialized-workspace';
import { indexAbsAbi } from '../../../integrations/blockly/abs/abs-abi-index';
import { AbsSyncError, type AbsAbiBlock } from '../../../integrations/blockly/abs/abs-state';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { initializeNativeCandidateBlock } from './blockly-native-graphics';

const sameJsonValue = (actual: unknown, expected: unknown): boolean =>
  actual !== undefined && expected !== undefined && absJson(actual) === absJson(expected);

/** One strict native executor for explicit diagnostic fields and ABS-bound requests. */
export class NativeCandidateWorkspace {
  private readonly requested = new Map<string, NativeCandidateBlock>();
  private readonly connections = new Map<Blockly.Block, Map<string, string | null>>();
  private readonly createdBy = new Map<Blockly.Block, string | undefined>();
  readonly creations: NativeDefaultCreations;
  readonly shadows: NativeShadowEvidence;
  private creationScope: NativeOwnedOperation | undefined;

  constructor(readonly native: typeof Blockly, readonly workspace: Blockly.Workspace,
    readonly observer: ReturnType<typeof createNativeStructureObserver>, readonly assertClean: () => void,
    readonly models = new NativeCandidateModels(workspace), replay?: AbsNativeCreation[], declarations = new Map<string, Record<string, any>>()) {
    this.creations = new NativeDefaultCreations(native, replay);
    this.shadows = new NativeShadowEvidence(native, workspace, block => this.createdBy.get(block), id => this.requested.has(id),
      (block, state) => captureNativeBlock(this, declarations, block, state),
      action => this.creationScope ? this.creationScope(undefined, action) : action());
  }

  private owned<T>(owner: string, operation: () => T): T {
    return this.shadows.run(owner, () => withNativeBlockCreation(this.workspace, run => {
      const previous = this.creationScope; this.creationScope = run;
      try { return run(owner, operation); } finally { this.creationScope = previous; }
    }, (block, _id, source) => {
      this.createdBy.set(block, source);
      this.shadows.observe(block);
      if (this.createdBy.size > 2000) throw new Error('Native candidate exceeds created-block limits.');
    }, (type, id, source) => {
      const definition = this.native.Blocks[type];
      if (definition) this.observer.observeNativeBlockDefinition(definition);
      const assigned = this.creations.allocate(type, id, source);
      if (assigned && this.workspace.getBlockById(assigned)) throw new Error('Native creation cannot reuse a live block identity.');
      return assigned;
    }));
  }

  create(operation: NativeCandidateBlock, start?: number): Blockly.Block {
    if (typeof operation.id !== 'string' || !operation.id || this.requested.has(operation.id)) throw new Error('Native candidate IDs must be unique and explicit.');
    if (this.requested.size >= 2000) throw new Error('Native candidate exceeds block limits.');
    const definition = this.native.Blocks[operation.type];
    if (!definition) throw new Error(`Native block is unavailable: ${operation.type}.`);
    this.observer.observeNativeBlockDefinition(definition);
    const request = { ...structuredClone(operation), fields: [] };
    this.requested.set(operation.id, request);
    if (start !== undefined) this.creations.owner(operation.id, start);
    const block = this.owned(operation.id, () => this.workspace.newBlock(operation.type, operation.id));
    this.assertClean();
    if (Object.hasOwn(operation, 'extraState')) {
      if (typeof block.loadExtraState !== 'function') throw new Error('Block does not support extraState.');
      this.owned(block.id, () => block.loadExtraState!(structuredClone(request.extraState))); this.assertClean();
    }
    for (const field of operation.fields) this.field(block, field.name, field.value);
    return block;
  }

  /** Like native deserialization, initialize views after fields/models are bound.
   * Initializing a FieldVariable sooner invents its default variable model. */
  initializeViews(): void {
    for (const block of this.workspace.getAllBlocks(false)) {
      const owner = this.createdBy.get(block);
      if (!owner) throw new Error('Native view initialization requires block ownership.');
      this.owned(owner, () => initializeNativeCandidateBlock(block));
      this.assertClean();
    }
  }

  /** Connection ownership, not block type, determines which defaults can survive. */
  defaultInputs(): Array<{ owner: number; input: string; blocks: Blockly.Block[] }> {
    const defaults: Array<{ owner: number; input: string; blocks: Blockly.Block[] }> = [];
    const admitted = new Set<string>(this.requested.keys());
    for (const id of this.requested.keys()) {
      const block = this.workspace.getBlockById(id), owner = this.creations.source(id);
      if (!block) throw new Error('Native candidate lost a requested block.');
      for (const input of block.inputList) {
        const child = input.connection?.targetBlock();
        if (!child || this.requested.has(child.id)) continue;
        const tree = child.getDescendants(false);
        if (owner === undefined || this.connections.get(block)?.has(input.name) || child.getParent() !== block
          || tree.some(item => this.createdBy.get(item) !== id || admitted.has(item.id))) {
          throw new Error('Native default subtree has unrequested blocks without unique connection ownership.');
        }
        tree.forEach(item => admitted.add(item.id));
        defaults.push({ owner, input: input.name, blocks: tree });
      }
    }
    const live = this.workspace.getAllBlocks(false);
    if (live.length !== admitted.size || live.some(block => !admitted.has(block.id))) {
      throw new Error('Native candidate created unrequested blocks or models; effect ownership is not prepared.');
    }
    return defaults;
  }

  field(block: Blockly.Block, name: string, value: unknown): void {
    const request = this.requested.get(block.id)!;
    if (request.fields.some(field => field.name === name)) throw new Error(`Duplicate native field ${name}.`);
    const field = block.getField(name);
    if (!field || field.SERIALIZABLE === false) throw new Error(`Native field is unavailable: ${name}.`);
    const requestedValue = structuredClone(value);
    this.owned(block.id, () => field.loadState(structuredClone(requestedValue))); this.assertClean();
    if (!sameJsonValue(field.saveState(), requestedValue)) throw new Error(`Native field did not retain requested value: ${name}.`);
    request.fields.push({ name, value: requestedValue });
  }

  connect(block: Blockly.Block, name: string, child: Blockly.Block | null, retainShadow?: (snapshot: NativeShadowSnapshot) => void): void {
    const connection = name === 'next' ? block.nextConnection : block.getInput(name)?.connection;
    if (!connection) throw new Error(`Native input is unavailable: ${name}.`);
    const targets = this.connections.get(block) ?? new Map();
    if (targets.has(name)) throw new Error(`Duplicate native input ${name}.`);
    targets.set(name, child?.id ?? null); this.connections.set(block, targets);
    const other = child && (connection.type === this.native.ConnectionType.INPUT_VALUE ? child.outputConnection : child.previousConnection);
    if (child && (!other || !this.workspace.connectionChecker.canConnect(connection, other, false))) {
      const valueInput = connection.type === this.native.ConnectionType.INPUT_VALUE;
      const topLevel = !child.previousConnection && !child.outputConnection;
      throw new AbsSyncError('ABS_CONNECTION_INCOMPATIBLE', `Incompatible native connection: ${block.type}.${name} cannot accept ${child.type}.`, undefined, [], {
        blockType: child.type, parentBlockType: block.type, field: name,
        expectedTypes: connection.getCheck() ?? [], actualTypes: other?.getCheck() ?? [],
        reason: !other ? (valueInput ? 'missing-output-connection' : 'missing-previous-connection') : 'connection-check-failed',
        hint: topLevel ? `${child.type} has no previous/output connection. Place this hat/root block at the top level, not inside a statement chain.`
          : `Use a compatible ${valueInput ? 'value block with an output connection' : 'statement block with a previous connection'} in ${block.type}.${name}. Changing variable models or the ABS baseline cannot repair a connection.`,
      });
    }
    const owns = (item: Blockly.Block) => this.createdBy.get(item) === block.id && !this.requested.has(item.id);
    const root = connection.targetBlock();
    let preserve = false;
    if (child && name !== 'next' && retainShadow) {
      if (root?.isShadow() && root.getParent() === block && root.getDescendants(false).every(owns)) {
        retainShadow(this.shadows.snapshot(root, block.id)); preserve = true;
      } else if (connection.getShadowState()) {
        retainShadow(this.shadows.read(connection.getShadowState() as AbsAbiBlock, block.id)); preserve = true;
      }
    }
    this.owned(block.id, () => retireNativeInputDefault(connection, owns, preserve));
    if (child) {
      this.owned(block.id, () => connection.connect(other!));
    }
    if ((connection.targetBlock()?.id ?? null) !== (child?.id ?? null)) throw new Error(`Native input did not retain requested connection: ${name}.`);
    this.assertClean();
  }

  result(): NativeCandidateResult {
    const blocks = this.workspace.getAllBlocks(false);
    const assertOwnership = () => {
      this.defaultInputs(); this.creations.assertComplete();
      this.models.assertCurrent();
    };
    const assertValues = () => {
      for (const block of blocks) {
        for (const { name, value } of this.requested.get(block.id)?.fields ?? []) {
          if (!sameJsonValue(block.getField(name)?.saveState(), value)) throw new Error(`Native configuration overwrote field: ${name}.`);
        }
        for (const [name, id] of this.connections.get(block) ?? []) {
          const target = name === 'next' ? block.getNextBlock() : block.getInputTargetBlock(name);
          if ((target?.id ?? null) !== id) throw new Error(`Native configuration overwrote connection: ${name}.`);
        }
      }
      this.assertClean();
    };
    assertOwnership(); assertValues();
    const state = this.native.serialization.workspaces.save(this.workspace);
    assertOwnership();
    if (Object.keys(state).some(key => !['blocks', 'variables'].includes(key))) throw new Error('Native serialization created unrequested models.');
    this.models.assertCurrent(state['variables'] ?? []);
    const normalized = normalizeAbsSerializedWorkspace(state), saved = indexAbsAbi(normalized);
    this.shadows.verify(normalized, blocks);
    for (const operation of this.requested.values()) {
      const block = saved.get(operation.id);
      if (block?.type !== operation.type) throw new Error('Native serialization changed block identity.');
      for (const field of operation.fields) {
        if (!sameJsonValue(block.fields?.[field.name], field.value)) throw new Error(`Native serialization changed requested field: ${field.name}.`);
      }
      if (Object.hasOwn(operation, 'extraState') && !sameJsonValue(block.extraState, operation.extraState)) {
        throw new Error('Native serialization did not retain requested extraState.');
      }
    }
    for (const [block, connections] of this.connections) {
      for (const [name, id] of connections) {
        const entry = saved.get(block.id);
        const target = name === 'next' ? entry.next?.block : entry.inputs?.[name]?.block;
        if ((target?.id ?? null) !== id) throw new Error(`Native serialization changed requested connection: ${name}.`);
      }
    }
    assertValues();
    const structures = blocks.map(block => {
      const trace = this.observer.readNativeBlockStructure(block);
      if (!trace) throw new Error('Native declaration trace is unavailable.');
      return { id: block.id, type: block.type, rows: trace.map(({ input, fields }) => ({
        input: { name: input.name, connection: input.connection ? { type: input.connection.type } : undefined },
        fields: fields.filter(field => !!field.name).map(field => ({ name: field.name!, SERIALIZABLE: field.SERIALIZABLE !== false })),
      })) };
    });
    this.assertClean();
    return { state, structures };
  }
}
