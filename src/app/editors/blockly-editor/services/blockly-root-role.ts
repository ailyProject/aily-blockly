import type * as Blockly from 'blockly';
import { BlocklyRootClassifier, BlocklyRootRole } from './blockly-project-model';
import { captureBundledProcedureRegistration } from '../components/blockly/plugins/block-plus-minus/src/procedures.js';
import { captureCustomFunctionRegistration } from './blockly-custom-function-contract';

/** Existing instances first; static capabilities only as fallback. No probe blocks or cross-session cache. */
export function captureBlocklyRootClassifier(workspace: Blockly.Workspace | null | undefined, registry: Record<string, any>): BlocklyRootClassifier {
  const bundled = captureBundledProcedureRegistration(registry);
  const custom = captureCustomFunctionRegistration(registry);
  const roles = new Map<string, { type: string; role: BlocklyRootRole }>();
  for (const block of workspace?.getAllBlocks(false) ?? []) {
    const instance = block as any;
    const customKind = custom?.get(block.type)?.kind;
    const role = customKind ? customKind === 'definition' ? 'definition' : 'call'
      : typeof instance.isProcedureDef === 'function' && typeof instance.getProcedureModel === 'function'
      ? instance.isProcedureDef() ? 'definition' : 'call'
      : typeof instance.getProcedureDef === 'function' ? 'definition'
      : typeof instance.getProcedureCall === 'function' ? 'call' : 'local';
    roles.set(block.id, { type: block.type, role });
  }
  return block => {
    const captured = roles.get(block.id);
    const kind = custom?.get(block.type)?.kind;
    if (kind) return kind === 'definition' ? 'definition' : 'call';
    if (captured?.type === block.type) return captured.role;
    const definition = Object.hasOwn(registry, block.type) ? registry[block.type] : undefined;
    return typeof definition?.getProcedureDef === 'function' ? 'definition'
      : typeof definition?.getProcedureCall === 'function' ? 'call' : bundled.get(block.type)?.role;
  };
}
