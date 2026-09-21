import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { nativeDefaultSteps } from './abs-native-defaults.fixture';
import { nativeDormantSource } from './abs-native-shadows.fixture';
import { indexAbsAbi } from './abs-abi-index';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';

describe('native dormant shadow evidence', () => {
  const request = (code = 'native_default_owner(A)', extra = ''): NativeCandidateRequest => ({ blocks: [], abs: '# ABS Schema: 2\n' + code,
    steps: [...nativeDefaultSteps, { kind: 'script', label: 'hidden-default-trees', source: nativeDormantSource + extra }],
  });
  const run = (input: NativeCandidateRequest) => evaluateNativeCandidate(input, { assertCurrent() {} });
  afterEach(() => expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0));

  for (const mode of ['A', 'B']) it(`captures native-retired nested shadow trees, replays IDs and verifies complete ABI (${mode})`, async () => {
    const input = request(`native_default_owner(${mode})`), first = await run(input);
    const second = await run({ ...input, identities: first.binding!.instances.map(item => ({ start: item.start, id: 'final-owner' })), creations: first.binding!.creations });
    expect(second.binding!.defaults).toEqual(first.binding!.defaults);
    const effect = second.binding!.defaults![0];
    expect(effect.instances.length).toBe(5);
    expect(effect.state.block!.inputs!['CHILD'].shadow!.fields!['NUM']).toBe(11);
    expect(effect.state.shadow!.inputs!['CHILD'].shadow!.fields!['NUM']).toBe(13);
    const state = normalizeAbsSerializedWorkspace(second.state), contracts = { fields: {}, syntax: {} };
    Object.assign(state.blocks.blocks[0], { x: 30, y: 60 });
    for (const instance of [...second.binding!.instances, ...effect.instances]) {
      contracts.fields[instance.id] = instance.shape.fields; contracts.syntax[instance.id] = instance.shape.argumentOrder;
    }
    const verified = await run({ steps: input.steps, blocks: [], verify: { state, contracts } });
    expect([...indexAbsAbi(normalizeAbsSerializedWorkspace(verified.state)).keys()].sort()).toEqual([...indexAbsAbi(state).keys()].sort());
  });

  it('keeps hidden fallback evidence when an explicit child replaces the temporary real subtree', async () => {
    const result = await run(request('native_default_owner(A, math_number(7))'));
    const effect = result.binding!.defaults![0];
    expect(effect.fallback).toBeTrue(); expect(effect.instances.length).toBe(2);
    expect(effect.state.shadow!.inputs!['CHILD'].shadow!.fields!['NUM']).toBe(13);
    expect(result.state['blocks'].blocks[0].inputs.VALUE.block.fields.NUM).toBe(7);
  });

  it('replays repeated native shadow lifetimes with one ID, without allowing live ID reuse', async () => {
    const input = request('native_default_owner(A)', `
      const make = Blockly.Blocks.native_default_owner.makeDefault;
      Blockly.Blocks.native_default_owner.makeDefault = function() { make.call(this);
        const connection = this.getInput('VALUE').connection;
        connection.setShadowState(connection.getShadowState());
      };
    `);
    const first = (await run(input)).binding!;
    expect(new Set(first.creations!.map(item => item.id)).size).toBeLessThan(first.creations!.length);
    const second = (await run({ ...input, identities: first.instances.map(item => ({ start: item.start, id: 'final-owner' })), creations: first.creations })).binding!;
    expect(second.defaults).toEqual(first.defaults);
    await expectAsync(run(request('native_default_owner(A)', `
      const make = Blockly.Blocks.native_default_owner.makeDefault;
      Blockly.Blocks.native_default_owner.makeDefault = function() { make.call(this); this.workspace.newBlock('math_number', this.getInputTargetBlock('VALUE').id); };
    `))).toBeRejectedWithError(/reuse a live block identity/);
  });

  it('uses a later configured fallback instead of the snapshot taken at explicit connection', async () => {
    const result = await run(request('native_default_owner(A, math_number(7), 19)', `
      const init = Blockly.Blocks.native_default_owner.init;
      Blockly.Blocks.native_default_owner.init = function() { init.call(this);
        this.appendDummyInput().appendField(new Blockly.FieldNumber(0, undefined, undefined, undefined, value => {
          this.getInput('VALUE').connection.setShadowState({ type:'math_number', fields:{NUM:value} }); return value;
        }), 'LATE');
      };
    `));
    const fallback = result.binding!.defaults![0];
    expect(result.binding!.defaults!.length).toBe(1);
    expect(fallback.instances.length).toBe(1); expect(fallback.state.shadow!.fields!['NUM']).toBe(19);
  });

  it('observes XML shadow setters through the same native lifetime, without a second XML adapter', async () => {
    const input = request('native_default_owner(A)', `
      const make = Blockly.Blocks.native_default_owner.makeDefault;
      Blockly.Blocks.native_default_owner.makeDefault = function() { make.call(this);
        this.getInput('VALUE').connection.setShadowDom(Blockly.utils.xml.textToDom('<shadow type="math_number"><field name="NUM">23</field></shadow>'));
      };
    `);
    const first = (await run(input)).binding!;
    const second = (await run({ ...input, identities: first.instances.map(item => ({ start: item.start, id: 'final-owner' })), creations: first.creations })).binding!;
    expect(second.defaults).toEqual(first.defaults);
    expect(second.defaults![0].state.shadow!.fields!['NUM']).toBe(23);
  });

  it('does not borrow retired evidence from another source owner', async () => {
    await expectAsync(run(request('native_default_owner(A)\nnative_default_owner(A)', `
      let shared;
      const make = Blockly.Blocks.native_default_owner.makeDefault;
      Blockly.Blocks.native_default_owner.makeDefault = function() { make.call(this);
        const connection = this.getInput('VALUE').connection;
        if(shared) connection.getShadowState = () => shared; else shared = connection.getShadowState();
      };
    `))).toBeRejected();
  });

  for (const source of [
    `this.getInput('VALUE').connection.getShadowState().inputs.CHILD.shadow.fields.NUM = 99;`,
    `this.getInput('VALUE').connection.getShadowState = () => ({type:'math_number',id:'invented',fields:{NUM:99}});`,
  ]) it(`rejects cached state without exact retired evidence: ${source}`, async () => {
    await expectAsync(run(request('native_default_owner(A)', `
      const make = Blockly.Blocks.native_default_owner.makeDefault;
      Blockly.Blocks.native_default_owner.makeDefault = function() { make.call(this); ${source} };
    `))).toBeRejectedWithError(/retired-instance evidence/);
  });

  it('rejects a hidden shadow model leak during native retirement', async () => {
    await expectAsync(run(request('native_default_owner(A)', `
      const init = Blockly.Blocks.math_number.init;
      Blockly.Blocks.math_number.init = function() { init.call(this); const dispose = this.dispose;
        this.dispose = function(...args) { if(this.isShadow()) this.workspace.createVariable('hidden-leak'); return dispose.apply(this,args); };
      };
    `))).toBeRejectedWithError(/variable ownership/);
  });

  it('does not grant a contract getter ownership for new blocks', async () => {
    await expectAsync(run(request('native_default_owner(A)', `
      const init = Blockly.Blocks.math_number.init;
      Blockly.Blocks.math_number.init = function() { init.call(this);
        this.saveExtraState = () => { if(this.isShadow() && !this.once) { this.once = true; this.workspace.newBlock('math_number'); } return null; };
      };
    `))).toBeRejected();
  });
});
