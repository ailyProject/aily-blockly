import * as Blockly from 'blockly';
import { isBlocklyBlockActive } from './blockly-block-activity';

const displayPrepared = new WeakSet<Blockly.Field>();

/** Native ARIA labels normally regenerate the complete option list. Dormant
 * fields already have their exact selected label; use it without asking an
 * unavailable initializer for options. Active fields keep their native method. */
export function prepareInactiveDropdownDisplay(field: Blockly.Field,
  inactive: () => boolean = () => { const block = field.getSourceBlock(); return !!block && !isBlocklyBlockActive(block); }): void {
  if (!(field instanceof Blockly.FieldDropdown) || field instanceof Blockly.FieldVariable) return;
  if (displayPrepared.has(field)) return;
  const original = field.getAriaValue;
  field.getAriaValue = function () {
    if (inactive()) return this.getText() || String(this.getValue() ?? '') || Blockly.Msg['FIELD_LABEL_EMPTY'];
    return Reflect.apply(original, this, []);
  };
  displayPrepared.add(field);
}

/** Restore one exact persisted dormant selection, not a synthetic option domain.
 * The override lives only during native loading. Normal validators still own
 * selector/shape effects, and complete readback must prove no saved data changed.
 * Never use this for a new/edited active selection or a model-backed field. */
export function withPreservedDropdownValue<T>(field: Blockly.Field,
  value: unknown, load: () => T): T {
  if (!(field instanceof Blockly.FieldDropdown) || field instanceof Blockly.FieldVariable
    || !['string', 'number', 'boolean'].includes(typeof value)) return load();
  prepareInactiveDropdownDisplay(field);
  const descriptor = Object.getOwnPropertyDescriptor(field, 'getOptions');
  Object.defineProperty(field, 'getOptions', { configurable: true, writable: true,
    value: () => [[String(value), value]],
  });
  try { return load(); }
  finally {
    if (descriptor) Object.defineProperty(field, 'getOptions', descriptor);
    else delete (field as any).getOptions;
  }
}
