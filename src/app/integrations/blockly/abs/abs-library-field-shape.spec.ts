import * as Blockly from 'blockly';
import { BlocklyGeneratorRuntimeService } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { captureAbsDeclarativeContracts } from './abs-declarative-contracts';
import { captureAbsWorkspaceState, assertAbsRuntimeShapeSupported } from './abs-workspace-state';
import { createAbsProjection, absJson, validateAbsProjection } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { assertAbsReadback } from './abs-readback';
import { describeAbsBlockCapability } from './abs-block-capabilities';
import { fieldShapeLibraryFixtures as fixtures } from './abs-library-field-shape.fixture';

describe('loaded library field-shape mechanisms', () => {
  let runtime: BlocklyGeneratorRuntimeService, workspace: Blockly.Workspace, catalog: BlocklyDeclarativeBlockCatalog, oldBlockly: unknown;
  const capture = () => captureAbsWorkspaceState(workspace, () => {}, catalog.capture(Blockly.Blocks));
  const shapes = () => captureAbsDeclarativeContracts(catalog.capture(Blockly.Blocks));
  async function projection() {
    const snapshot = capture();
    return createAbsProjection(snapshot.state, { document: snapshot.state, contracts: snapshot.contracts,
      generation: 'library-field-shape', baselineRef: 'base', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
  }
  async function edit(text: string) {
    const baseline = await projection(), contract = shapes(), before = absJson(capture().state);
    const result = await reconcileAbsDraft(baseline, text, { blockContract: contract.get,
      argumentOrder: (type, extra, fields) => contract.get(type, extra, fields)?.argumentOrder,
      fieldSelectors: type => contract.get(type)?.fieldShape?.map(rule => rule.field),
      fieldDefinition: (type, name) => contract.get(type)?.fields[name] });
    assertAbsRuntimeShapeSupported(baseline.workspace, result.workspace, result.contracts, contract.get);
    expect(absJson(capture().state)).toBe(before);
    Blockly.serialization.workspaces.load(result.workspace, workspace);
    const actual = capture(); assertAbsReadback(result.workspace, actual.state, actual);
    return result;
  }
  function load(name: keyof typeof fixtures, transform = (source: string) => source) {
    const fixture = fixtures[name];
    runtime.loadGenerator(name + '/generator.js', transform(fixture.source) + '\nBlockly.defineBlocksWithJsonArray(' + transform(JSON.stringify(fixture.blocks)) + ');');
  }
  beforeEach(() => {
    oldBlockly = window['Blockly']; window['Blockly'] = Blockly;
    workspace = new Blockly.Workspace(); catalog = new BlocklyDeclarativeBlockCatalog();
    runtime = new BlocklyGeneratorRuntimeService();
    runtime.activate({ mode: 'arduino', getWorkspace: () => null,
      onBlockDefinition: (source, definition) => catalog.record(source, definition) });
    runtime.loadGenerator('values.js', `Blockly.defineBlocksWithJsonArray([
      {type:'abs_lib_num',message0:'%1',args0:[{type:'field_number',name:'NUM',value:0}],output:null},
      {type:'abs_lib_text',message0:'%1',args0:[{type:'field_input',name:'TEXT',text:''}],output:null}
    ]);`);
  });
  afterEach(() => { workspace.dispose(); runtime.destroy(); window['Blockly'] = oldBlockly; });
  it('observes real registrations without constructing blocks or running helper callbacks', () => {
    const probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    load('core-text'); load('esp32_i2c');
    const snapshot = catalog.capture(Blockly.Blocks);
    for (const type of ['tt_getSubstring', 'esp32_i2c_write_to_device', 'esp32_i2c_read_from_device']) {
      expect(describeAbsBlockCapability(snapshot, type)).toEqual(jasmine.objectContaining({ contract: 'field-shape-v1' }));
    }
    expect(probe).not.toHaveBeenCalled();
  });
  it('round-trips all nine README two-selector combinations with declared arguments before dynamic values', async () => {
    load('core-text');
    const calls = [];
    for (const first of ['FROM_START', 'FROM_END', 'FIRST']) for (const last of ['FROM_START', 'FROM_END', 'LAST']) {
      calls.push(`tt_getSubstring(abs_lib_text("abcdef"), ${first}, ${last}${first === 'FIRST' ? '' : ', abs_lib_num(1)'}${last === 'LAST' ? '' : ', abs_lib_num(3)'})`);
    }
    await edit('# ABS Schema: 2\n' + calls.join('\n'));
    const projected = await projection(); await validateAbsProjection(projected); await edit(projected.abs);
    expect(workspace.getBlocksByType('tt_getSubstring', false).length).toBe(9);
    expect(projected.abs).not.toContain('WHERE1=');
  });
  it('removes and restores both indexed inputs without changing retained IDs', async () => {
    load('core-text');
    await edit('# ABS Schema: 2\ntt_getSubstring(abs_lib_text("abcdef"), FROM_START, FROM_END, abs_lib_num(1), abs_lib_num(2))');
    const block = workspace.getBlocksByType('tt_getSubstring', false)[0], id = block.id, textId = block.getInputTargetBlock('STRING')!.id;
    await edit((await projection()).abs.replace('FROM_START, FROM_END, abs_lib_num(1), abs_lib_num(2)', 'FIRST, LAST'));
    expect(workspace.getBlockById(id)!.getInput('AT1_VALUE')).toBeNull();
    await edit((await projection()).abs.replace('FIRST, LAST', 'FROM_END, FROM_START, abs_lib_num(2), abs_lib_num(4)'));
    expect(workspace.getBlockById(id)!.getInputTargetBlock('STRING')!.id).toBe(textId);
    expect(workspace.getBlockById(id)!.getInputTargetBlock('AT2_VALUE')!.getFieldValue('NUM')).toBe(4);
  });
  it('supports extension-driven input changes without XML and with different block/helper/field names', async () => {
    load('esp32_i2c', source => source.replaceAll('esp32_i2c', 'unrelated_transport').replaceAll('updateI2CCustomAddressInput', 'updateOtherInput')
      .replaceAll('CUSTOM_ADDRESS', 'MANUAL_INPUT').replaceAll('ADDRESS', 'DESTINATION').replaceAll('CUSTOM', 'MANUAL'));
    await edit('# ABS Schema: 2\nunrelated_transport_write_to_device(MANUAL, abs_lib_text("x"), abs_lib_num(32))\nunrelated_transport_read_from_device("0x3C", abs_lib_num(1))');
    const before = await projection(); expect(before.abs).not.toContain('@extra');
    await edit(before.abs.replace('MANUAL, abs_lib_text("x"), abs_lib_num(32)', '"0x3C", abs_lib_text("x")'));
    expect(workspace.getBlocksByType('unrelated_transport_write_to_device', false)[0].getInput('MANUAL_INPUT')).toBeNull();
  });
  it('rejects changed helper dependencies and inactive-runtime evidence', () => {
    load('esp32_i2c');
    const snapshot = catalog.capture(Blockly.Blocks);
    expect(describeAbsBlockCapability(snapshot, 'esp32_i2c_write_to_device').level).toBe('reshape');
    runtime.loadGenerator('changed-helper.js', 'updateI2CCustomAddressInput = function() {};');
    expect(() => snapshot.assertCurrent()).toThrow();
    expect(describeAbsBlockCapability(catalog.capture(Blockly.Blocks), 'esp32_i2c_write_to_device').level).toBe('preserve-only');
    runtime.destroy(); expect(() => snapshot.assertCurrent()).toThrow();
  });
  it('invalidates captured mixin changes and does not replace the host registration methods', () => {
    const register = Blockly.Extensions.register, registerMutator = Blockly.Extensions.registerMutator;
    load('core-text', source => source.replace("if (Blockly.Extensions.isRegistered", "window.savedShapeMixin = TEXT_GET_SUBSTRING_MUTATOR_MIXIN; if (Blockly.Extensions.isRegistered"));
    const snapshot = catalog.capture(Blockly.Blocks);
    expect(describeAbsBlockCapability(snapshot, 'tt_getSubstring').level).toBe('reshape');
    expect(Blockly.Extensions.register).toBe(register); expect(Blockly.Extensions.registerMutator).toBe(registerMutator);
    runtime.loadGenerator('mixin-change.js', 'savedShapeMixin.updateAt_ = function() {};');
    expect(() => snapshot.assertCurrent()).toThrow();
    expect(describeAbsBlockCapability(catalog.capture(Blockly.Blocks), 'tt_getSubstring').level).toBe('preserve-only');
  });
  it('preserves normal library registration decorators without bypass or recursion', () => {
    const register = Blockly.Extensions.register;
    runtime.loadGenerator('decorator.js', `
      const previousRegister = Blockly.Extensions.register;
      window.decoratedRegistrations = 0;
      Blockly.Extensions.register = function(name, callback) {
        window.decoratedRegistrations++;
        previousRegister(name, callback);
      };
      Blockly.Extensions.register('abs_decorated_registration', function() {});
      function registrationCount() { return window.decoratedRegistrations; }
    `);
    expect(runtime.invokeGlobal('registrationCount')).toBe(1);
    expect(Blockly.Extensions.isRegistered('abs_decorated_registration')).toBeTrue();
    runtime.destroy();
    expect(Blockly.Extensions.register).toBe(register);
    expect(Blockly.Extensions.isRegistered('abs_decorated_registration')).toBeFalse();
  });
  it('does not approve suggestive names with extra callback writes or mixed serializers', () => {
    load('esp32_i2c', source => source.replace('const hasInput =', 'block.workspace.createVariable("unexpected"); const hasInput ='));
    expect(describeAbsBlockCapability(catalog.capture(Blockly.Blocks), 'esp32_i2c_write_to_device').level).toBe('preserve-only');
    load('core-text', source => source.replace("return container;", "container.setAttribute('opaque', 'lost'); return container;"));
    expect(describeAbsBlockCapability(catalog.capture(Blockly.Blocks), 'tt_getSubstring').level).toBe('preserve-only');
  });
  it('rejects missing native anchors, additional inputs and unknown XML attributes before native loading', async () => {
    load('core-text');
    const before = absJson(capture().state);
    for (const source of ['tt_getSubstring(abs_lib_text("x"), FIRST, abs_lib_num(1), LAST)',
      'tt_getSubstring(abs_lib_text("x"), FIRST, LAST) @extra:"<mutation at1=\\"false\\" at2=\\"false\\" opaque=\\"lost\\"></mutation>"']) {
      await expectAsync(edit('# ABS Schema: 2\n' + source)).toBeRejected(); expect(absJson(capture().state)).toBe(before);
    }
    runtime.loadGenerator('missing-anchor.js', 'Blockly.defineBlocksWithJsonArray(' + JSON.stringify(fixtures['core-text'].blocks).replaceAll('AT1_DUMMY', 'WRONG_DUMMY') + ');');
    expect(shapes().get('tt_getSubstring')).toBeUndefined();
    expect(describeAbsBlockCapability(catalog.capture(Blockly.Blocks), 'tt_getSubstring').level).toBe('preserve-only');
  });
});
