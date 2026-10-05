import * as Blockly from 'blockly';
import { absJson } from './abs-json';

describe('ABS partial-apply generation proof boundary', () => {
  // An ordinary synchronous library can keep initialization state outside ABI.
  // Each scenario is an independent runtime, not a guessed reset of that state.
  function scenario(mode: 'fresh' | 'partial' | 'reload', latent = false) {
    const type = 'incremental_hidden_state_probe';
    const previous = Blockly.Blocks[type];
    const workspace = new Blockly.Workspace();
    let initialized = 0;
    Blockly.Blocks[type] = { init() { initialized++; this.appendDummyInput().appendField('probe'); } };
    const generator = new Blockly.CodeGenerator('hidden-state-proof');
    generator.forBlock[type] = () => `${latent ? Math.floor(initialized / 4) : initialized};\n`;
    const block = (id: string, y: number) => ({ type, id, x: 30, y });
    const old = block('old', 30), added = block('added', 100);
    const final = { blocks: { blocks: [old, added] } };
    try {
      if (mode !== 'fresh') Blockly.serialization.workspaces.load({ blocks: { blocks: [old] } }, workspace);
      if (mode === 'partial') Blockly.serialization.blocks.append(added, workspace);
      else Blockly.serialization.workspaces.load(final, workspace);
      const code = generator.workspaceToCode(workspace), abi = absJson(Blockly.serialization.workspaces.save(workspace));
      Blockly.serialization.blocks.append(block('later', 200), workspace);
      return { code, abi, laterCode: generator.workspaceToCode(workspace), laterAbi: absJson(Blockly.serialization.workspaces.save(workspace)) };
    } finally {
      workspace.dispose();
      if (previous) Blockly.Blocks[type] = previous; else delete Blockly.Blocks[type];
    }
  }

  it('equal ABI and fresh-realm output do not prove equivalence to a full reload in the active runtime', () => {
    const fresh = scenario('fresh'), partial = scenario('partial'), full = scenario('reload');
    expect(partial.abi).toBe(full.abi); expect(partial.abi).toBe(fresh.abi);
    expect(partial.code).toBe(fresh.code);
    expect(partial.code).not.toBe(full.code);
    expect(partial.code).toContain('2;'); expect(full.code).toContain('3;');
  });

  it('even equal current outputs can hide state which changes the next identical edit', () => {
    const fresh = scenario('fresh', true), partial = scenario('partial', true), full = scenario('reload', true);
    expect(partial.abi).toBe(full.abi); expect(partial.code).toBe(full.code); expect(partial.code).toBe(fresh.code);
    expect(partial.laterAbi).toBe(full.laterAbi);
    expect(partial.laterCode).not.toBe(full.laterCode);
    expect(partial.laterCode).toContain('0;'); expect(full.laterCode).toContain('1;');
  });
});
