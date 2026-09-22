import * as Blockly from 'blockly';
import { observeBlocklyFieldShape } from './blockly-field-shape-contracts';

/** One observer at normal Realm registration, independent effect contracts. */
export function createBlocklyExtensionFacade(realm: object, isCurrent: () => boolean): typeof Blockly.Extensions {
  const methods = { register: Blockly.Extensions.register, registerMutator: Blockly.Extensions.registerMutator };
  const wrappers = new Map<string, { method: Function; invoke: Function }>();
  return new Proxy(Blockly.Extensions, { get: (target, key) => {
    if (!isCurrent()) throw new Error('Extension registration belongs to an inactive runtime.');
    const method = Reflect.get(target, key);
    if ((key !== 'register' && key !== 'registerMutator') || typeof method !== 'function') return method;
    if (wrappers.get(key)?.method !== method) wrappers.set(key, { method, invoke: (...args: unknown[]) => {
      if (!isCurrent()) throw new Error('Extension registration belongs to an inactive runtime.');
      // Capture at property-read time, preserving decorators and their saved APIs.
      const result = Reflect.apply(method, target, args);
      if (method === methods[key]) {
        const intact = () => isCurrent() && Blockly.Extensions[key] === method;
        observeBlocklyFieldShape(key, args, realm, intact);
      }
      return result;
    } });
    return wrappers.get(key)!.invoke;
  } });
}
