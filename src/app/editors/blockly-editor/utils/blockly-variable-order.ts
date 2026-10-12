import * as Blockly from 'blockly';

let installed = false;

/** Blockly 13's native comparator shares its collator across dropdowns. Expose
 * that same function to published Aily libraries using the former static API;
 * each realm initializes independently and later library overrides remain live. */
export function installBlocklyVariableComparator(): void {
  if (installed) return;
  (Blockly.VariableModel as any).compareByName = Blockly.Variables.compareByName;
  installed = true;
}
