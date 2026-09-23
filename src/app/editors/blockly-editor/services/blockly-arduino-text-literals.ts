import { cppStringLiteral } from '../components/blockly/generators/arduino/cpp-string-literal';

const adapted = Symbol('arduino-text-literal');

/** Published AI-VOX libraries, including projects pinned to xzai 0.0.6, model
 * the headers initializer as a text block and then strip the surrounding
 * quotes themselves. Preserve only that legacy raw-code input while ordinary
 * Blockly text continues to use standard C++ escaping. */
function isLegacyRawCppTextInput(block: any): boolean {
  const parentConnection = block?.outputConnection?.targetConnection;
  const parent = parentConnection?.getSourceBlock?.();
  if (parent?.type !== 'aivox_config_websocket') return false;
  const parentInput = parent.inputList?.find((input: any) => input?.connection === parentConnection);
  return parentInput?.name === 'ai_vox_websocket_param';
}

/** Repair legacy raw literal emission at the shared runtime boundary. Preserve
 * handler effects/order and already encoded or non-literal implementations. */
export function adaptArduinoTextLiterals(generator: any): void {
  const original = generator?.forBlock?.text;
  if (typeof original !== 'function' || original[adapted]) return;
  const wrapped = function(this: unknown, block: any, ...args: unknown[]) {
    const result = original.call(this, block, ...args);
    const text = block.getFieldValue('TEXT');
    if (typeof text !== 'string' || !Array.isArray(result) || result[0] !== '"' + text + '"') return result;
    if (isLegacyRawCppTextInput(block)) return result;
    return [cppStringLiteral(text), ...result.slice(1)];
  };
  Object.defineProperty(wrapped, adapted, { value: true });
  generator.forBlock.text = wrapped;
}
