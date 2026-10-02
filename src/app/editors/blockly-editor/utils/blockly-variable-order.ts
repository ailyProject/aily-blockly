import * as Blockly from 'blockly';

let installed = false;

/** Same ordering as Blockly's localeCompare(..., undefined, { sensitivity: 'base' }).
 * Share the collator, not sorted variables: names/models remain live on every read.
 * Each JavaScript realm installs independently at its own bootstrap boundary. */
export function installBlocklyVariableComparator(): void {
  if (installed) return;
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
  Blockly.VariableModel.compareByName = (left, right) => collator.compare(left.name, right.name);
  installed = true;
}
