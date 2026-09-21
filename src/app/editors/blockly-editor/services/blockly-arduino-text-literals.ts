import { cppStringLiteral } from '../components/blockly/generators/arduino/cpp-string-literal';

const adapted = Symbol('arduino-text-literal');

/** Repair legacy raw literal emission at the shared runtime boundary. Preserve
 * handler effects/order and already encoded or non-literal implementations. */
export function adaptArduinoTextLiterals(generator: any): void {
  const original = generator?.forBlock?.text;
  if (typeof original !== 'function' || original[adapted]) return;
  const wrapped = function(this: unknown, block: any, ...args: unknown[]) {
    const result = original.call(this, block, ...args);
    const text = block.getFieldValue('TEXT');
    if (typeof text !== 'string' || !Array.isArray(result) || result[0] !== '"' + text + '"') return result;
    return [cppStringLiteral(text), ...result.slice(1)];
  };
  Object.defineProperty(wrapped, adapted, { value: true });
  generator.forBlock.text = wrapped;
}
