import * as Blockly from 'blockly';

/** Published variable generators assumed every category had static contents.
 * Native procedure/variable callbacks return a string instead. Apply the same
 * array guard as the maintained library, only to this known legacy lookup;
 * keep on-disk libraries and native dynamic-category callbacks unchanged. */
export function normalizeLegacyVariableToolboxSource(filePath: string, source: string): string {
  if (!/(?:^|[/\\])(?:@aily-project[/\\])?lib-core-variables[/\\]generator\.js$/.test(filePath)) return source;
  return source.replace(/item\.getContents\s*&&\s*item\.getContents\(\)\.some\((\w+)\s*=>\s*\1\.type\s*===\s*(["'])variable_define\2\)/g,
    match => `item.getContents && Array.isArray(item.getContents()) && ${match.slice(match.indexOf('item.getContents()'))}`);
}

/**
 * Published Aily generator libraries are independently versioned. Keep their
 * v11 entry points backed by v13's variable map, without a second Blockly copy
 * or changes to saved variable IDs. New host code uses the v13 APIs directly.
 */
function installLegacyLibraryCompatibility(): void {
  const workspace = Blockly.Workspace.prototype as any;
  const methods: Record<string, (this: Blockly.Workspace, ...args: any[]) => any> = {
    createVariable(name, type, id) {
      return this.getVariableMap().createVariable(name, type ?? undefined, id ?? undefined);
    },
    getVariable(name, type) { return this.getVariableMap().getVariable(name, type); },
    getVariableById(id) { return this.getVariableMap().getVariableById(id); },
    getVariablesOfType(type) { return this.getVariableMap().getVariablesOfType(type ?? ''); },
    getAllVariables() { return this.getVariableMap().getAllVariables(); },
    getAllVariableNames() { return this.getVariableMap().getAllVariables().map(v => v.getName()); },
    getVariableUsesById(id) { return Blockly.Variables.getVariableUsesById(this, id); },
    renameVariableById(id, name) {
      const variable = this.getVariableMap().getVariableById(id);
      if (variable) this.getVariableMap().renameVariable(variable, name);
    },
    deleteVariableById(id) {
      const variable = this.getVariableMap().getVariableById(id);
      if (variable) Blockly.Variables.deleteVariable(this, variable);
    },
  };
  for (const [name, value] of Object.entries(methods)) {
    if (typeof workspace[name] !== 'function') {
      Object.defineProperty(workspace, name, { value, writable: true, configurable: true });
    }
  }

  const block = Blockly.Block.prototype as any;
  if (!block.getVars) {
    block.getVars = function (this: Blockly.Block) {
      return this.getVarModels().map(model => model.getId());
    };
  }
  if (!block.setEnabled) {
    block.setEnabled = function (this: Blockly.Block, enabled: boolean) {
      this.setDisabledReason(!enabled, 'MANUALLY_DISABLED');
    };
  }
  (Blockly.VariableModel as any).compareByName = Blockly.Variables.compareByName;
}

installLegacyLibraryCompatibility();
