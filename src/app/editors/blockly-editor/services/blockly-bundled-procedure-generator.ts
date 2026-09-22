import * as Blockly from 'blockly';
import { captureBundledProcedureRegistration } from '../components/blockly/plugins/block-plus-minus/src/procedures.js';

const adaptedCall = Symbol('bundled-procedure-call');

/** The host owns native legacy callers and their ARG<n> inputs. Library-defined
 * callers have independent contracts. The read-only view keeps legacy generators'
 * INPUT<n> reads working without changing blocks, library handlers or naming rules.
 * Install on the owning realm's Generator after loading library code handlers.
 */
export function adaptBundledArduinoProcedureCalls(generator: any): void {
  const registration = captureBundledProcedureRegistration(Blockly.Blocks);
  for (const type of ['procedures_callreturn', 'procedures_callnoreturn']) {
    const original = generator.forBlock?.[type];
    if (!registration.get(type) || typeof original !== 'function' || original[adaptedCall]) continue;
    const wrapped = function (this: unknown, block: Blockly.Block, ...args: unknown[]) {
      if (!registration.get(type)) return original.call(this, block, ...args);
      const input = (name: string) => block.getInput(name)
        ?? (/^INPUT\d+$/.test(name) ? block.getInput(name.replace(/^INPUT/, 'ARG')) : null);
      const view = new Proxy(block, { get(target, key) {
        if (key === 'getInput') return input;
        if (key === 'getInputTargetBlock') return (name: string) => input(name)?.connection?.targetBlock() ?? null;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return original.call(this, view, ...args);
    };
    Object.defineProperty(wrapped, adaptedCall, { value: true });
    generator.forBlock[type] = wrapped;
  }
}
