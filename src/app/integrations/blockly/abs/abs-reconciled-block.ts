import { absJson } from './abs-json';
import type { AbsAbiBlock } from './abs-state';

/** The caller MUST replace block edges before returning or running an adapter.
 * Shadow trees stay detached even when visible: replacing a visible shadow can
 * retain it as a dormant fallback. Unknown adapters still use a full clone. */
export function copyAbsBlockForRebuild(previous: AbsAbiBlock): AbsAbiBlock {
  const { inputs, next, ...attributes } = previous;
  const block: AbsAbiBlock = JSON.parse(absJson(attributes));
  if (inputs) block.inputs = Object.fromEntries(Object.entries(inputs).map(([name, input]) => {
    const { block: child, shadow, ...metadata } = input;
    return [name, { ...JSON.parse(absJson(metadata)),
      ...(Object.hasOwn(input, 'block') ? { block: child } : {}),
      ...(Object.hasOwn(input, 'shadow') ? { shadow: shadow ? JSON.parse(absJson(shadow)) : shadow } : {}),
    }];
  }));
  if (next) {
    const { block: child, ...metadata } = next;
    block.next = { ...JSON.parse(absJson(metadata)), block: child };
  }
  return block;
}
