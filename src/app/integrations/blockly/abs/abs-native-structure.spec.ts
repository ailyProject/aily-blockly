import * as Blockly from 'blockly';
import { BlocklyGeneratorRuntimeService } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { captureAbsWorkspaceState, assertAbsRuntimeShapeSupported, loadAbsWorkspaceState } from './abs-workspace-state';
import { createAbsProjection, absJson } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { assertAbsReadback } from './abs-readback';
import { describeAbsBlockCapability } from './abs-block-capabilities';
import { nativeHardwareFixtures } from './abs-native-hardware.fixture';
import { nativeWifiFixtures } from './abs-native-wifi.fixture';

describe('native declaration-driven ABS instance round trips', () => {
  let runtime: BlocklyGeneratorRuntimeService, workspace: Blockly.Workspace, catalog: BlocklyDeclarativeBlockCatalog, oldBlockly: unknown;
  const capture = () => captureAbsWorkspaceState(workspace, () => {}, catalog.capture(Blockly.Blocks));
  async function projection() {
    const snapshot = capture();
    return createAbsProjection(snapshot.state, { document: snapshot.state, contracts: snapshot.contracts,
      generation: 'native-structure', baselineRef: 'base', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
  }
  async function edit(text: string) {
    const baseline = await projection(), before = absJson(capture().state);
    const result = await reconcileAbsDraft(baseline, text);
    assertAbsRuntimeShapeSupported(baseline.workspace, result.workspace, result.contracts);
    expect(absJson(capture().state)).toBe(before);
    await loadAbsWorkspaceState(result.workspace, workspace as Blockly.WorkspaceSvg, {}, () => {}, result.contracts);
    const actual = capture(); assertAbsReadback(result.workspace, actual.state, actual);
    return result;
  }
  function load(fixture: { source: string; blocks: unknown[] }, transform = (source: string) => source) {
    // Normal library loading substitutes board placeholders before registration.
    const json = JSON.stringify(fixture.blocks).replaceAll('"${board.digitalPins}"', JSON.stringify([['P5', '5'], ['P18', '18'], ['P23', '23']]));
    runtime.loadGenerator('fixture-' + Math.random() + '.js', transform(fixture.source) + '\nBlockly.defineBlocksWithJsonArray(' + transform(json) + ');');
  }
  beforeEach(() => {
    oldBlockly = window['Blockly']; window['Blockly'] = Blockly;
    workspace = new Blockly.Workspace(); catalog = new BlocklyDeclarativeBlockCatalog();
    runtime = new BlocklyGeneratorRuntimeService();
    runtime.activate({ mode: 'arduino', getWorkspace: () => null,
      boardConfig: { digitalPins: [['P5', '5'], ['P18', '18'], ['P23', '23']], i2c: [['Wire', 'Wire'], ['Wire1', 'Wire1']] },
      onBlockDefinition: (source, definition) => catalog.record(source, definition) });
    runtime.loadGenerator('values.js', `Blockly.defineBlocksWithJsonArray([
      {type:'abs_native_text',message0:'%1',args0:[{type:'field_input',name:'TEXT',text:''}],output:'String'},
      {type:'abs_native_num',message0:'%1',args0:[{type:'field_number',name:'NUM',value:0}],output:'Number'}
    ]);`);
  });
  afterEach(() => { workspace.dispose(); runtime.destroy(); window['Blockly'] = oldBlockly; });

  it('records an unknown extension without any template, constructor probe or new-block permission', async () => {
    runtime.loadGenerator('unknown.js', `Blockly.Extensions.register('abs_unknown_native', function () {
      for (const [name, value] of [['ALPHA', 'first'], ['BETA', 'second']])
        this.appendDummyInput(name).appendField(new Blockly.FieldTextInput(value), name);
    }); Blockly.defineBlocksWithJsonArray([{ type:'abs_unknown_native',message0:'%1',args0:[{type:'field_number',name:'N',value:0}],
      extensions:['abs_unknown_native'],previousStatement:null,nextStatement:null }]);`);
    const probe = spyOn(workspace, 'newBlock').and.callThrough();
    expect(describeAbsBlockCapability(catalog.capture(Blockly.Blocks), 'abs_unknown_native').level).toBe('preserve-only');
    expect(probe).not.toHaveBeenCalled();
    const block = workspace.newBlock('abs_unknown_native'); block.setDeletable(false); block.setMovable(false);
    const exported = await projection(); expect(exported.abs).toContain('abs_unknown_native(0, "first", "second")');
    const result = await edit(exported.abs.replace('"second"', '"changed"'));
    expect(result.retained).toContain(block.id); expect(result.added).toEqual([]);
    expect(workspace.getBlockById(block.id)!.isDeletable()).toBeFalse();
    expect(workspace.getBlockById(block.id)!.isMovable()).toBeFalse();
  });
  it('keeps original fields/value interleaving instead of visual field-row order', async () => {
    runtime.loadGenerator('interleaved.js', `Blockly.Extensions.register('abs_interleave', function () {
      this.appendDummyInput('TAIL').appendField(new Blockly.FieldTextInput('extra'), 'EXTRA');
    }); Blockly.defineBlocksWithJsonArray([{type:'abs_interleave',message0:'%1 %2 %3',args0:[
      {type:'field_input',name:'NAME',text:'x'},{type:'input_value',name:'VALUE'},
      {type:'field_dropdown',name:'TYPE',options:[['int','int']]}],extensions:['abs_interleave'],output:null}]);`);
    const block = workspace.newBlock('abs_interleave');
    const value = workspace.newBlock('abs_native_num'); value.setFieldValue(7, 'NUM');
    block.getInput('VALUE')!.connection!.connect(value.outputConnection!);
    const exported = await projection(); expect(exported.abs).toContain('abs_interleave("x", abs_native_num(7), int, "extra")');
    await edit(exported.abs.replace('abs_native_num(7)', 'abs_native_num(8)'));
  });
  it('exports JS-assigned jsonInit definitions in source order, without promoting them to static contracts', async () => {
    runtime.loadGenerator('direct-js.js', `
      Blockly.Blocks.abs_direct_native = { init() {
        this.jsonInit({type:'abs_direct_native',message0:'%3 %1 %2',args0:[
          {type:'field_input',name:'NAME',text:'x'}, {type:'input_value',name:'VALUE'},
          {type:'field_dropdown',name:'TYPE',options:[['int','int']]}],output:null});
      } };
    `);
    const block = workspace.newBlock('abs_direct_native');
    const value = workspace.newBlock('abs_native_num'); value.setFieldValue(7, 'NUM');
    block.getInput('VALUE')!.connection!.connect(value.outputConnection!);
    const exported = await projection();
    expect(exported.abs).toContain('abs_direct_native("x", abs_native_num(7), int)');
    expect(catalog.capture(Blockly.Blocks).get('abs_direct_native')).toBeUndefined();
    expect(describeAbsBlockCapability(catalog.capture(Blockly.Blocks), 'abs_direct_native').level).toBe('preserve-only');
    await edit(exported.abs.replace('abs_native_num(7)', 'abs_native_num(8)'));
    const changed = workspace.getBlockById(block.id)!;
    runtime.loadGenerator('replace-direct.js', `Blockly.Blocks.abs_direct_native = {init() {this.appendDummyInput();}};`);
    expect(capture().contracts.syntax?.[changed.id]).toBeUndefined();
  });
  it('uses the real DHT configuration and preserves pin/bus variants without a library recipe', async () => {
    load(nativeHardwareFixtures.adafruit_DHT);
    const first = workspace.newBlock('dht_init'), second = workspace.newBlock('dht_init');
    first.setFieldValue('one', 'VAR'); first.setFieldValue('18', 'PIN');
    second.setFieldValue('two', 'VAR'); second.setFieldValue('DHT20', 'TYPE'); second.setFieldValue('Wire1', 'WIRE');
    const exported = await projection();
    expect(exported.abs).toContain('dht_init("one", DHT11, "18")');
    expect(exported.abs).toContain('dht_init("two", DHT20, Wire1)');
    await edit(exported.abs.replace('"18"', '"23"'));
    expect(workspace.getBlockById(first.id)!.getFieldValue('PIN')).toBe('23');
    expect(workspace.getBlockById(second.id)!.getFieldValue('WIRE')).toBe('Wire1');
  });
  it('records software SPI fields after configuration and loads them after their selector', async () => {
    load(nativeHardwareFixtures['adafruit-max31865']);
    const block = workspace.newBlock('max31865_init'); block.setFieldValue('SW', 'SPI_MODE');
    block.setFieldValue('18', 'SW_SCK_PIN'); block.setFieldValue('23', 'SW_MOSI_PIN'); block.setFieldValue('5', 'SW_MISO_PIN');
    const exported = await projection();
    expect(exported.abs).not.toContain('SW_SCK_PIN=');
    await edit(exported.abs + '\n# keep all software pins\n');
    expect(workspace.getBlockById(block.id)!.getFieldValue('SW_MOSI_PIN')).toBe('23');
    expect(workspace.getBlockById(block.id)!.getFieldValue('SW_SCK_PIN')).toBe('18');
  });
  it('records and round-trips WiFi inputs without recognizing the callback source', async () => {
    load(nativeWifiFixtures['diandeng_blinker']);
    const block = workspace.newBlock('blinker_init_wifi');
    for (const name of ['AUTH', 'SSID', 'PSWD']) {
      const text = workspace.newBlock('abs_native_text'); text.setFieldValue(name.toLowerCase(), 'TEXT');
      block.getInput(name)!.connection!.connect(text.outputConnection!);
    }
    const exported = await projection();
    expect(exported.abs).toContain('blinker_init_wifi("手动配网", abs_native_text("auth"), abs_native_text("ssid"), abs_native_text("pswd"))');
    await edit(exported.abs.replace('"pswd"', '"changed"'));
  });
  it('allows plain dropdown edits without treating every enum as a shape selector', async () => {
    load(nativeHardwareFixtures['adafruit-max31865']);
    const block = workspace.newBlock('max31865_init'); block.setFieldValue('SW', 'SPI_MODE');
    block.setFieldValue('23', 'SW_MOSI_PIN');
    const exported = await projection();
    expect(exported.contracts.selectors?.[block.id]).toEqual(['SPI_MODE']);
    const changed = exported.abs.replace('SW, "5", MAX31865_2WIRE', 'SW, "18", MAX31865_3WIRE');
    expect(changed).not.toBe(exported.abs);
    await edit(changed);
    const loaded = workspace.getBlockById(block.id)!;
    expect(loaded.getFieldValue('CS_PIN')).toBe('18');
    expect(loaded.getFieldValue('WIRES')).toBe('MAX31865_3WIRE');
    expect(loaded.getFieldValue('SW_MOSI_PIN')).toBe('23');
  });
  it('does not depend on library/type/helper/field spellings', async () => {
    load(nativeHardwareFixtures.adafruit_DHT, source => source.replaceAll('dht_init', 'different_init')
      .replaceAll('PIN_SET', 'PORT_ROW').replaceAll("'PIN'", "'PORT'").replaceAll('updateShape_', 'configurePort'));
    const block = workspace.newBlock('different_init'); block.setFieldValue('18', 'PORT');
    const exported = await projection(); expect(exported.abs).toContain('different_init("dht", DHT11, "18")');
    await edit(exported.abs.replace('"18"', '"23"'));
  });
  it('records native input moves and field insertion without reordering static arguments', async () => {
    runtime.loadGenerator('moves.js', `Blockly.Extensions.register('abs_native_moves', function () {
      this.getInput('HEAD').insertFieldAt(0, new Blockly.FieldTextInput('before'), 'BEFORE');
      this.appendValueInput('EXTRA'); this.moveInputBefore('EXTRA', 'TAIL');
    }); Blockly.defineBlocksWithJsonArray([{type:'abs_native_moves',message0:'%1 %2',args0:[
      {type:'field_input',name:'A',text:'a'},{type:'input_dummy',name:'HEAD'}],message1:'%1 %2',args1:[
      {type:'field_input',name:'B',text:'b'},{type:'input_dummy',name:'TAIL'}],extensions:['abs_native_moves'],output:null}]);`);
    workspace.newBlock('abs_native_moves');
    const exported = await projection(); expect(exported.abs).toContain('abs_native_moves("a", "b", "before", null)');
    await edit(exported.abs.replace('"a"', '"changed"'));
    const block = workspace.getBlocksByType('abs_native_moves', false)[0];
    expect(block.getFieldValue('A')).toBe('changed');
    expect(block.getFieldValue('B')).toBe('b');
    expect(block.getFieldValue('BEFORE')).toBe('before');
  });
  it('retains shadow identity on same-shape native edits', async () => {
    load(nativeWifiFixtures['diandeng_blinker']); const block = workspace.newBlock('blinker_init_wifi');
    for (const name of ['AUTH', 'SSID', 'PSWD']) {
      const text = workspace.newBlock('abs_native_text'); text.setFieldValue(name, 'TEXT'); text.setShadow(true);
      block.getInput(name)!.connection!.connect(text.outputConnection!);
    }
    const id = block.getInputTargetBlock('SSID')!.id;
    await edit((await projection()).abs.replace('"PSWD"', '"changed"'));
    expect(workspace.getBlockById(id)!.isShadow()).toBeTrue();
  });
  it('refuses to invent prospective variants and does not promote one instance to a type contract', async () => {
    load(nativeHardwareFixtures.adafruit_DHT); workspace.newBlock('dht_init');
    const before = await projection();
    await expectAsync(edit(before.abs.replace('DHT11', 'DHT20'))).toBeRejected();
    expect((await projection()).abs).toBe(before.abs);
  });
  it('does not use stale or unobserved direct array rewrites as declaration evidence', async () => {
    load(nativeHardwareFixtures.adafruit_DHT); const block = workspace.newBlock('dht_init');
    expect((await projection()).contracts.syntax?.[block.id]).toBeDefined();
    block.inputList.reverse();
    expect(capture().contracts.syntax?.[block.id]).toBeUndefined();
    block.inputList.reverse(); catalog.clear();
    expect(capture().contracts.syntax?.[block.id]).toBeUndefined();
  });
  it('keeps explicit empty-input disconnection and does not silently retain a child', async () => {
    runtime.loadGenerator('input.js', `Blockly.defineBlocksWithJsonArray([{type:'abs_native_input',message0:'%1',
      args0:[{type:'input_value',name:'VALUE'}],output:null}]);`);
    const parent = workspace.newBlock('abs_native_input'), child = workspace.newBlock('abs_native_num');
    parent.getInput('VALUE')!.connection!.connect(child.outputConnection!);
    const source = (await projection()).abs; const result = await edit(source.replace('abs_native_num(0)', 'null'));
    expect(result.removed).toContain(child.id); expect(workspace.getBlockById(parent.id)!.getInputTargetBlock('VALUE')).toBeNull();
  });
});
