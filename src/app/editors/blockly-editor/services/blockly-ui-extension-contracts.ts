import * as Blockly from 'blockly';
import { provesBlocklyUiOnly } from './blockly-ui-effect-proof';

// Version-local Blockly adapter: this installed version exposes registration identities
// only through TEST_ONLY. Missing access fails closed; never run callbacks to infer a shape.
const registry = () => (Blockly.Extensions as any).TEST_ONLY?.allExtensions;
const originalRegistry = registry();
const originalApply = Blockly.Extensions.apply;
const builtin = new Map<string, unknown>([
  // Bundled implementation only installs customContextMenu, no persisted state or onchange.
  ['contextMenu_variableSetterGetter', originalRegistry?.['contextMenu_variableSetterGetter']],
  // Captures the current tooltip and sets a parent-aware tooltip callback only.
  ['parent_tooltip_when_inline', originalRegistry?.['parent_tooltip_when_inline']],
  ['controls_if_tooltip', originalRegistry?.['controls_if_tooltip']],
  ['text_quotes', originalRegistry?.['text_quotes']],
  ['logic_op_tooltip', originalRegistry?.['logic_op_tooltip']],
  ['controls_whileUntil_tooltip', originalRegistry?.['controls_whileUntil_tooltip']],
  ['controls_for_tooltip', originalRegistry?.['controls_for_tooltip']],
  ['contextMenu_newGetVariableBlock', originalRegistry?.['contextMenu_newGetVariableBlock']],
]);

export function captureBlocklyUiExtensionContracts() {
  const used = new Map<string, unknown>();
  const current = (name: string) => Object.getOwnPropertyDescriptor(registry() ?? {}, name)?.value;
  const intact = (name: string, callback: unknown) => registry() === originalRegistry
    && current(name) === callback && Blockly.Extensions.apply === originalApply;
  return {
    supports: (name: string) => {
      const callback = current(name);
      if (typeof callback !== 'function' || !intact(name, callback)
        || callback !== builtin.get(name) && !provesBlocklyUiOnly(callback)) return false;
      used.set(name, callback); return true;
    },
    assertCurrent: () => {
      if ([...used].some(([name, callback]) => !intact(name, callback))) throw new Error('Prepared Blockly UI extension registration changed.');
    },
  };
}
