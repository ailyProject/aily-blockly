import type * as Blockly from 'blockly';
import type { AbsAbiBlock, AbsAbiWorkspace } from '../../../integrations/blockly/abs/abs-state';
import type { AbsNativeBlock } from '../../../integrations/blockly/abs/abs-native-binding';
import { indexAbsAbi } from '../../../integrations/blockly/abs/abs-abi-index';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { normalizeAbsSerializedWorkspace } from '../../../integrations/blockly/abs/abs-serialized-workspace';

export interface NativeShadowSnapshot { state: AbsAbiBlock; instances: AbsNativeBlock[] }

/** Observe native shadow retirement, never instantiate a probe or trust serializer-only nodes. */
export class NativeShadowEvidence {
  private readonly retired = new Map<string, NativeShadowSnapshot & { owner: string }>();
  private owner: string | undefined;
  private disposing = false;

  constructor(private readonly native: typeof Blockly, private readonly workspace: Blockly.Workspace,
    private readonly source: (block: Blockly.Block) => string | undefined,
    private readonly requested: (id: string) => boolean,
    private readonly capture: (block: Blockly.Block, state: AbsAbiBlock) => AbsNativeBlock,
    private readonly inspect: <T>(action: () => T) => T = action => action()) {}

  run<T>(owner: string, action: () => T): T {
    const previous = this.owner; this.owner = owner;
    try { return action(); } finally { this.owner = previous; }
  }

  observe(block: Blockly.Block): void {
    const descriptor = Object.getOwnPropertyDescriptor(block, 'dispose'), original = block.dispose;
    const evidence = this;
    Object.defineProperty(block, 'dispose', { configurable: true, writable: true,
      value: function(this: Blockly.Block, ...args: Parameters<Blockly.Block['dispose']>) {
        // Restore before invoking native disposal, including custom failure paths.
        if (descriptor) Object.defineProperty(block, 'dispose', descriptor); else delete (block as any).dispose;
        const outer = evidence.disposing;
        try {
          if (this === block && !outer && evidence.owner && !block.isDisposed() && block.isShadow()
            && evidence.source(block) === evidence.owner && !evidence.requested(block.id)) {
            const snapshot = evidence.snapshot(block, evidence.owner);
            evidence.retired.set(block.id, { ...snapshot, owner: evidence.owner });
          }
          evidence.disposing = true;
          return Reflect.apply(original, this, args);
        } finally { evidence.disposing = outer; }
      },
    });
  }

  snapshot(root: Blockly.Block, owner: string): NativeShadowSnapshot {
    return this.inspect(() => this.captureTree(root, owner));
  }

  private captureTree(root: Blockly.Block, owner: string): NativeShadowSnapshot {
    const live = root.getDescendants(false);
    if (live.some(block => this.source(block) !== owner || this.requested(block.id))) throw new Error('Native shadow tree contains unowned or requested blocks.');
    const save = () => normalizeAbsSerializedWorkspace({ blocks: { blocks: [this.native.serialization.blocks.save(root)] } });
    const state = save(), index = indexAbsAbi(state);
    const hidden = this.verify(state, live);
    const instances = [...live.map(block => this.capture(block, index.get(block.id)!)), ...hidden.values()];
    if (absJson(save()) !== absJson(state)) throw new Error('Native shadow changed during capture.');
    return { state: state.blocks.blocks[0], instances };
  }

  read(state: AbsAbiBlock, owner: string | undefined): NativeShadowSnapshot {
    const proof = this.retired.get(state.id);
    if (!proof || proof.owner !== owner || absJson(proof.state) !== absJson(state)
      || proof.instances.some(instance => !!this.workspace.getBlockById(instance.id))) {
      throw new Error('Native dormant shadow has no matching retired-instance evidence.');
    }
    return structuredClone({ state: proof.state, instances: proof.instances });
  }

  /** Every serialized edge must agree with its real connection; hidden nodes need
   * an exact retired tree on that connection, not merely a matching type or ID.
   */
  verify(state: AbsAbiWorkspace, live: readonly Blockly.Block[]): Map<string, AbsNativeBlock> {
    const saved = indexAbsAbi(state), visible = new Set(live.map(block => block.id));
    const hidden = new Map<string, AbsNativeBlock>();
    for (const block of live) {
      const entry = saved.get(block.id);
      if (!entry || entry.type !== block.type) throw new Error('Native serialization changed block identity.');
      const inputs = new Map(block.inputList.filter(input => !!input.connection).map(input => [input.name, input.connection!]));
      if (Object.keys(entry.inputs ?? {}).some(name => !inputs.has(name))) throw new Error('Native serialization invented an input.');
      const connections = [...inputs].map(([name, connection]) => ({ connection, value: entry.inputs?.[name] }));
      connections.push({ connection: block.nextConnection, value: entry.next as { block?: AbsAbiBlock; shadow?: AbsAbiBlock } });
      for (const { connection, value } of connections) {
        const target = connection?.targetBlock();
        const actual = target?.isShadow() ? 'shadow' : 'block';
        if ((value?.[actual]?.id ?? null) !== (target?.id ?? null)
          || target?.isShadow() && value?.block) throw new Error('Native serialization changed a connection.');
        const shadow = connection?.getShadowState(true);
        if (absJson(value?.['shadow'] ?? null) !== absJson(shadow ?? null)) throw new Error('Native serialization changed shadow ownership.');
        if (!shadow || target?.isShadow()) continue;
        const proof = this.read(shadow as AbsAbiBlock, this.source(block));
        for (const instance of proof.instances) {
          if (visible.has(instance.id) || hidden.has(instance.id) || !saved.has(instance.id)) throw new Error('Native shadow identity has multiple owners.');
          hidden.set(instance.id, instance);
        }
      }
    }
    if (saved.size !== visible.size + hidden.size) throw new Error('Native serialization created unrequested state.');
    return hidden;
  }
}
