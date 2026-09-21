const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { openBlankProject } = require('./project-data-blank-project-smoke.cjs');

/** Load the product's emitted lazy module; no extra production debug bridge. */
async function testNativeCandidateIsolation(page, source, parent, repo) {
  const libraries = [process.env.AILY_ABS_DHT_LIBRARY, process.env.AILY_ABS_MAX31865_LIBRARY].filter(Boolean);
  const provenance = libraries.map(library => ({
    name: JSON.parse(fs.readFileSync(path.join(library, 'package.json'), 'utf8')).name,
    sha256: createHash('sha256').update(fs.readFileSync(path.join(library, 'generator.js'))).digest('hex'),
  }));
  const { project } = await openBlankProject(page, source, parent, 'Candidate Isolation', libraries);
  const browser = path.join(repo, 'dist/aily-blockly/browser');
  const chunks = fs.readdirSync(browser).filter(file => file.endsWith('.js')
    && /export\s*\{\s*evaluateNativeCandidate\s*\}/.test(fs.readFileSync(path.join(browser, file), 'utf8')));
  assert.equal(chunks.length, 1, 'One emitted native candidate entry is required');
  const files = ['project.abi', 'project.abs', 'project.abs.map.json'];
  const read = file => fs.existsSync(path.join(project, file)) ? fs.readFileSync(path.join(project, file)) : null;
  const before = files.map(read);
  const evidence = await page.evaluate(async ({ chunk, provenance }) => {
    const { evaluateNativeCandidate } = await import(new URL(chunk, document.baseURI).href);
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    const host = window.Blockly, workspace = editor.workspace;
    const state = JSON.stringify(host.serialization.workspaces.save(workspace));
    const root = host.Blocks.arduino_setup, prototype = host.Block.prototype;
    const options = { assertCurrent: () => {
      if (editor.workspace !== workspace || JSON.stringify(host.serialization.workspaces.save(workspace)) !== state) throw Error('Host workspace changed');
    } };
    const script = `
      if (typeof fs !== 'undefined' || typeof electron !== 'undefined' || typeof require !== 'undefined') throw Error('preload leaked');
      try { parent.document; throw Error('parent accessible'); } catch(e) { if (e.name !== 'SecurityError') throw e; }
      Blockly.Blocks.arduino_setup = { init() {} };
      Blockly.Block.prototype.candidateOnly = true;
      Blockly.Extensions.register('candidate_shape', function() {
        this.getField('MODE').setValidator(mode => {
          if (this.getInput('DYNAMIC')) this.removeInput('DYNAMIC');
          if (mode === 'B') {
            const row = this.appendDummyInput('DYNAMIC');
            for (const name of ['LEFT', 'RIGHT']) row.appendField(new Blockly.FieldNumber(0), name);
          }
          return mode;
        });
      });
      Blockly.defineBlocksWithJsonArray([{type:'unknown_candidate',message0:'%1',args0:[
        {type:'field_dropdown',name:'MODE',options:[['A','A'],['B','B']]}],extensions:['candidate_shape'],output:null}]);
      Arduino.forBlock.unknown_candidate = block => [String(block.getFieldValue('LEFT') + block.getFieldValue('RIGHT')), 0];
    `;
    const request = { steps: [{ kind: 'context', mode: 'arduino' }, { kind: 'script', source: script, label: 'native-smoke' }], blocks: [
      { id: 'only-in-candidate', type: 'unknown_candidate', fields: [{ name: 'MODE', value: 'B' }, { name: 'LEFT', value: 3 }, { name: 'RIGHT', value: 7 }] },
    ] };
    const candidate = await evaluateNativeCandidate(request, options);
    if (candidate.state.blocks.blocks[0].fields.RIGHT !== 7) throw Error('Native shape did not retain fields');
    const fromAbs = await evaluateNativeCandidate({ steps: request.steps, blocks: [], abs: '# ABS Schema: 2\nunknown_candidate(B, 3, 7)' }, options);
    if (fromAbs.state.blocks.blocks[0].fields.RIGHT !== 7) throw Error('ABS position binding failed');
    const identified = await evaluateNativeCandidate({ steps: request.steps, blocks: [], abs: fromAbs.binding.source,
      identities: [{ start: fromAbs.binding.syntax[0].start, id: 'confirmed-native-id' }] }, options);
    const expected = structuredClone(identified.state), instance = identified.binding.instances[0];
    Object.assign(expected.blocks.blocks[0], { deletable: false, movable: false, data: 'preserved metadata', x: 30, y: 60 });
    const verify = { state: expected, contracts: { fields: { [instance.id]: instance.shape.fields }, syntax: { [instance.id]: instance.shape.argumentOrder } } };
    const verified = await evaluateNativeCandidate({ steps: request.steps, blocks: [], verify }, options);
    const verifiedRoot = verified.state.blocks.blocks[0];
    if (verifiedRoot.id !== 'confirmed-native-id' || verifiedRoot.data !== 'preserved metadata'
      || verifiedRoot.deletable !== false || verifiedRoot.movable !== false) throw Error('Final ABI metadata/readback failed');
    let generatorEffectRejected = false;
    try {
      await evaluateNativeCandidate({ steps: [...request.steps, { kind: 'script', label: 'generator-effect',
        source: `Arduino.forBlock.unknown_candidate = block => { block.workspace.createVariable('unowned'); return ['0', 0]; };` }], blocks: [], verify }, options);
    } catch { generatorEffectRejected = true; }
    if (!generatorEffectRejected) throw Error('Unowned generator effect was accepted');
    const payload = 'isolated payload '.repeat(2500);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const payloadRef = { $ailyData: { schemaVersion: 1,
      id: 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
      codec: 'utf8-v1', logicalType: 'text', storage: 'raw-v1', rawLength: payload.length, storedLength: payload.length } };
    const envelope = { $ailyProjectDataValue: { schemaVersion: 1, ref: payloadRef } };
    const ownedSteps = [...request.steps, { kind: 'script', label: 'owned-inputs', source: `
      Blockly.defineBlocksWithJsonArray([
        {type:'variables_get',message0:'%1',args0:[{type:'field_variable',name:'VAR',variable:'unused'}],output:null},
        {type:'owned_payload',message0:'%1 %2 %3',args0:[{type:'field_variable',name:'VAR',variable:'unused'},
          {type:'input_value',name:'VALUE'},{type:'field_input',name:'TEXT',text:''}],output:null}
      ]);
      Arduino.forBlock.variables_get = block => [block.getField('VAR').getVariable().name, 0];
      Arduino.forBlock.owned_payload = block => [Arduino.valueToCode(block, 'VALUE', 0) + ' + ' + block.getFieldValue('TEXT').length, 0];
    ` }];
    const owned = await evaluateNativeCandidate({ steps: ownedSteps, blocks: [],
      variables: [{ id: 'owned-counter', name: 'counter' }], values: [{ ref: payloadRef, value: payload }],
      abs: '# ABS Schema: 2\nowned_payload($counter, $counter, ' + JSON.stringify(envelope) + ')' }, options);
    const ownedRoot = owned.state.blocks.blocks[0];
    if (ownedRoot.fields.VAR.id !== 'owned-counter' || ownedRoot.inputs.VALUE.block.fields.VAR.id !== 'owned-counter'
      || ownedRoot.fields.TEXT !== payload || owned.state.variables.length !== 1) throw Error('Owned inputs lost identities or data');
    const ownedContracts = { fields: Object.fromEntries(owned.binding.instances.map(item => [item.id, item.shape.fields])),
      syntax: Object.fromEntries(owned.binding.instances.map(item => [item.id, item.shape.argumentOrder])) };
    await evaluateNativeCandidate({ steps: ownedSteps, blocks: [], verify: { state: owned.state, contracts: ownedContracts } }, options);
    const mixedSource = '# ABS Schema: 2\nprocedures_defreturn(NAME="work") @extra:{"params":[{"name":"amount"}]}\n'
      + '    @RETURN:\n        unknown_candidate(B, 3, 7)\n'
      + 'procedures_callreturn() @extra:{"name":"work","params":["amount"]}\n    @ARG0:\n        math_number(5)';
    const mixedSteps = [...request.steps, { kind: 'definitions', definitions: [
      { type: 'math_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number' },
    ] }, { kind: 'script', label: 'bundled-procedure-generator', source: `
      Arduino.forBlock.math_number = block => [String(block.getFieldValue('NUM')), 0];
      Arduino.forBlock.procedures_defreturn = block => {
        Arduino.addFunction('work', 'int work(int amount) { return ' + Arduino.valueToCode(block, 'RETURN', 0) + '; }'); return '';
      };
      Arduino.forBlock.procedures_callreturn = block => [block.getProcedureCall() + '(' + Arduino.valueToCode(block, 'INPUT0', 0) + ')', 0];
    ` }];
    const mixedTypes = ['procedures_defreturn', 'unknown_candidate', 'procedures_callreturn', 'math_number'];
    const mixedIds = mixedTypes.map((type, i) => ({ start: mixedSource.indexOf(type + '('), id: 'mixed-' + i }));
    const mixed = await evaluateNativeCandidate({ steps: mixedSteps, blocks: [], abs: mixedSource, identities: mixedIds,
      variables: [{ name: 'amount', id: 'mixed-param' }], hostCalls: [0, 2].map(i => ({ start: mixedIds[i].start, type: mixedTypes[i] })) }, options);
    if (mixed.binding.instances.length !== 2 || mixed.binding.hostCalls.length !== 2) throw Error('Mixed binding coverage lost');
    // Diagnostic final state only. The coordinator tests separately exercise the
    // actual host preparer, identity matcher, transactions and reopen path.
    const mixedState = { variables: [{ name: 'amount', id: 'mixed-param' }], blocks: { blocks: [
      { type: mixedTypes[0], id: 'mixed-0', x: 30, y: 60, fields: { NAME: 'work', abs_arg_0: 'amount' },
        extraState: { params: [{ name: 'amount', id: 'mixed-param', argId: 'abs_arg_0' }] },
        inputs: { RETURN: { block: mixed.binding.instances.find(block => block.id === 'mixed-1').seed } } },
      { type: mixedTypes[2], id: 'mixed-2', x: 30, y: 300, extraState: { name: 'work', params: ['amount'] },
        inputs: { ARG0: { block: mixed.binding.instances.find(block => block.id === 'mixed-3').seed } } },
    ] } };
    const mixedFields = Object.fromEntries(mixed.binding.instances.map(item => [item.id, item.shape.fields]));
    mixedFields['mixed-0'] = { NAME: { type: 'field_input' }, abs_arg_0: { type: 'field_input' } }; mixedFields['mixed-2'] = {};
    await evaluateNativeCandidate({ steps: mixedSteps, blocks: [], verify: { state: mixedState, contracts: { fields: mixedFields } } }, options);
    let fullLibraries;
    if (provenance.length) {
      if (provenance.length !== 2) throw Error('Supply both full native library fixtures');
      const snapshot = editor.generatorRuntime.captureNativeReplay();
      const steps = snapshot.steps.flatMap(step => {
        if (step.kind === 'script') return provenance.some(lib => step.label.replaceAll('\\', '/').includes('/' + lib.name + '/')) ? [step] : [];
        if (step.kind === 'definitions') {
          const definitions = step.definitions.filter(definition => ['dht_init', 'max31865_init'].includes(definition.type));
          return definitions.length ? [{ kind: 'definitions', definitions }] : [];
        }
        return [step];
      });
      const scripts = steps.filter(step => step.kind === 'script');
      if (scripts.length !== 2) throw Error('Full native sources missing from active journal');
      const sourceHashes = [];
      for (const script of scripts) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script.source));
        const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        if (!provenance.some(lib => lib.sha256 === sha256)) throw Error('Replay source differs from readonly full generator.js');
        sourceHashes.push(sha256);
      }
      const config = editor.boardConfig, pin = JSON.stringify(config.digitalPins[0][1]);
      const wire = JSON.stringify(config.i2c?.[0]?.[1] ?? 'I2C0');
      const values = [];
      for (const software of [true, false]) {
        const abs = '# ABS Schema: 2\n'
          + `dht_init("full_dht", ${software ? 'DHT20, ' + wire : 'DHT22, ' + pin})\n`
          + `max31865_init("full_rtd", ${software ? 'SW' : 'HW'}, ${pin}, MAX31865_3WIRE${software ? ', ' + [pin, pin, pin].join(', ') : ''})`;
        const result = await evaluateNativeCandidate({ steps, blocks: [], abs }, { assertCurrent: () => { snapshot.assertCurrent(); options.assertCurrent(); } });
        const dht = result.state.blocks.blocks.find(block => block.type === 'dht_init');
        const rtd = result.state.blocks.blocks.find(block => block.type === 'max31865_init');
        if (dht.fields.TYPE !== (software ? 'DHT20' : 'DHT22') || rtd.fields.SPI_MODE !== (software ? 'SW' : 'HW')) throw Error('Full generator native shape mismatch');
        if (software && (rtd.fields.SW_MISO_PIN !== JSON.parse(pin) || dht.fields.WIRE !== JSON.parse(wire))) throw Error('Dynamic field lost');
        values.push({ dht: dht.fields, rtd: rtd.fields });
      }
      fullLibraries = { sourceHashes, values, fromActiveReplayJournal: true, wholeProjectReplay: false, codeGenerationExecuted: false };
    }
    const rejected = [];
    for (const source of [`try { setInterval(() => {}, 0); } catch {}`, `Blockly.getMainWorkspace().createVariable('unrequested')`, `throw Error('candidate failed')`]) {
      try { await evaluateNativeCandidate({ steps: [{ kind: 'script', source, label: 'negative' }], blocks: [] }, options); }
      catch (error) { rejected.push(String(error)); }
    }
    if (rejected.length !== 3) throw Error('Candidate failure was not rejected');
    const defaultSteps = [{ kind: 'context', mode: 'arduino' }, { kind: 'definitions', definitions: [{
      type: 'math_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number',
    }] }, { kind: 'script', label: 'temporary-default', source: `
      Blockly.Blocks.native_smoke_default = { init() {
        this.appendValueInput('VALUE').setCheck('Number');
        const child = this.workspace.newBlock('math_number'); child.setFieldValue(5, 'NUM');
        this.getInput('VALUE').connection.connect(child.outputConnection);
      } };
      Arduino.forBlock.native_smoke_default = block => Arduino.valueToCode(block, 'VALUE', 0) + ';\\n';
      Arduino.forBlock.math_number = block => [String(block.getFieldValue('NUM')), 0];
    ` }];
    for (const child of ['math_number(21)', 'null']) {
      const value = await evaluateNativeCandidate({ steps: defaultSteps, blocks: [], abs: '# ABS Schema: 2\nnative_smoke_default(' + child + ')' }, options);
      if (value.binding.instances.length !== (child === 'null' ? 1 : 2) || value.state.blocks.blocks.length !== 1) throw Error('Temporary default was adopted');
      const state = structuredClone(value.state);
      Object.assign(state.blocks.blocks[0], { x: 30, y: 60 });
      const contracts = { fields: {}, syntax: {} };
      for (const instance of value.binding.instances) {
        contracts.fields[instance.id] = instance.shape.fields; contracts.syntax[instance.id] = instance.shape.argumentOrder;
      }
      await evaluateNativeCandidate({ steps: defaultSteps, blocks: [], verify: { state, contracts } }, options);
    }
    for (const kind of ['real', 'visible', 'dormant']) {
      const shadow = kind === 'visible';
      const steps = [...defaultSteps, ...(kind !== 'real' ? [{ kind: 'script', label: 'native-default-shadow', source: `
        const init = Blockly.Blocks.native_smoke_default.init;
        Blockly.Blocks.native_smoke_default.init = function() { init.call(this);
          ${shadow ? "this.getInputTargetBlock('VALUE').setShadow(true);" : "this.getInput('VALUE').connection.setShadowState({type:'math_number',fields:{NUM:13}});"}
        };
      ` }] : [])];
      const input = { steps, blocks: [], abs: '# ABS Schema: 2\nnative_smoke_default()' };
      const first = await evaluateNativeCandidate(input, options);
      const replay = await evaluateNativeCandidate({ ...input,
        identities: first.binding.instances.map(instance => ({ start: instance.start, id: 'confirmed-default-owner' })),
        creations: first.binding.creations }, options);
      if (JSON.stringify(first.binding.defaults) !== JSON.stringify(replay.binding.defaults)) throw Error('Default replay changed ownership or content');
      const state = structuredClone(replay.state), contracts = { fields: {}, syntax: {} };
      Object.assign(state.blocks.blocks[0], { x: 30, y: 60 });
      for (const instance of [...replay.binding.instances, ...replay.binding.defaults.flatMap(effect => effect.instances)]) {
        contracts.fields[instance.id] = instance.shape.fields; contracts.syntax[instance.id] = instance.shape.argumentOrder;
      }
      const verified = await evaluateNativeCandidate({ steps, blocks: [], verify: { state, contracts } }, options);
      const connection = verified.state.blocks.blocks[0].inputs.VALUE;
      const defaultBlock = shadow ? connection.shadow : connection.block;
      if (defaultBlock.id !== replay.binding.defaults[0].instances[0].id || defaultBlock.fields.NUM !== 5) throw Error('Saved default identity/value changed');
      if (kind === 'dormant' && (connection.shadow.fields.NUM !== 13 || connection.shadow.id !== replay.binding.defaults[0].state.shadow.id)) throw Error('Dormant shadow identity/value changed');
    }
    let inventedShadowRejected = false;
    try {
      await evaluateNativeCandidate({ steps: [...defaultSteps, { kind: 'script', label: 'invented-shadow', source: `
        const init = Blockly.Blocks.native_smoke_default.init;
        Blockly.Blocks.native_smoke_default.init = function() { init.call(this);
          this.getInput('VALUE').connection.getShadowState = () => ({type:'math_number',id:'invented',fields:{NUM:99}});
        };
      ` }], blocks: [], abs: '# ABS Schema: 2\nnative_smoke_default()' }, options);
    } catch { inventedShadowRejected = true; }
    if (!inventedShadowRejected) throw Error('Unobserved serializer shadow was accepted');
    let defaultModelRejected = false;
    try {
      await evaluateNativeCandidate({ steps: [...defaultSteps, { kind: 'script', label: 'default-model-leak', source: `
        const init = Blockly.Blocks.native_smoke_default.init;
        Blockly.Blocks.native_smoke_default.init = function() { init.call(this); this.workspace.createVariable('leaked'); };
      ` }], blocks: [], abs: '# ABS Schema: 2\nnative_smoke_default(math_number(21))' }, options);
    } catch { defaultModelRejected = true; }
    if (!defaultModelRejected) throw Error('Disposing default hid an unowned model');
    // Exercise the actual ordinary loader in a disposable rendered workspace,
    // with no declaration JSON or previous live instance to supply field order.
    const reloadType = 'native_smoke_js_reopen', parentType = 'native_smoke_js_parent';
    if (host.Blocks[reloadType] || host.Blocks[parentType]) throw Error('Reopen test type already registered');
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px;z-index:2147483647';
    document.body.appendChild(container);
    const mainWorkspace = host.getMainWorkspace();
    let disposable;
    try {
      host.Blocks[reloadType] = { init() {
        this.appendDummyInput('mode').appendField(new host.FieldDropdown([['A', 'A'], ['B', 'B']], mode => {
          if (this.getInput('choice')) this.removeInput('choice');
          if (this.getInput('text')) this.removeInput('text');
          if (mode === 'B') {
            this.appendDummyInput('choice').appendField(new host.FieldDropdown([['A', 'A'], ['C', 'C']], choice => {
              if (this.getInput('text')) this.removeInput('text');
              if (choice === 'C') this.appendDummyInput('text').appendField(new host.FieldTextInput('default'), 'A_TEXT');
              return choice;
            }), 'M_CHOICE');
            this.moveInputBefore('choice', 'mode');
          }
          return mode;
        }), 'Z_MODE');
        this.setOutput(true);
      } };
      host.Blocks[parentType] = { init() {
        this.appendValueInput('VALUE');
        // A rendered-only default is deliberately absent from headless discovery.
        if (this.workspace.rendered) {
          const child = this.workspace.newBlock(reloadType); child.initSvg(); child.render();
          this.getInput('VALUE').connection.connect(child.outputConnection);
        }
      } };
      disposable = host.inject(container, {});
      const loader = { workspace: disposable, iconsMap: new Map(), cloneJson: value => structuredClone(value),
        assertWorkspaceEditAvailable() {}, captureDeclarativeBlockDefinitions: () => editor.captureDeclarativeBlockDefinitions(),
        scheduleWorkspaceRenderAfterLoad() {},
      };
      const child = id => ({ type: reloadType, id, fields: { A_TEXT: 'electron-kept', M_CHOICE: 'C', Z_MODE: 'B' } });
      let input = { blocks: { blocks: [{ type: parentType, id: 'reload-parent', deletable: false, inputs: { VALUE: {
        shadow: child('reload-shadow'), block: child('reload-real'),
      } } }] } };
      for (let i = 0; i < 2; i++) {
        editor.loadWorkspaceJson.call(loader, input);
        if (disposable.getBlockById('reload-real').getFieldValue('A_TEXT') !== 'electron-kept') throw Error('JS-only reopen lost text');
        if (disposable.getBlockById('reload-parent').isDeletable()) throw Error('Reopen lost protection');
        if (disposable.getAllBlocks(false).length !== 2) throw Error('Rendered init left an orphan default');
        input = JSON.parse(JSON.stringify(host.serialization.workspaces.save(disposable)));
      }
      disposable.getBlockById('reload-real').dispose();
      const respawned = disposable.getBlockById('reload-parent').getInputTargetBlock('VALUE');
      if (!respawned.isShadow() || respawned.getFieldValue('A_TEXT') !== 'electron-kept') throw Error('Shadow respawn lost text');
      editor.loadWorkspaceJson.call(loader, { blocks: { blocks: [{ type: parentType, id: 'empty-parent' }] } });
      if (disposable.getAllBlocks(false).length !== 1 || disposable.getBlockById('empty-parent').getInputTargetBlock('VALUE')) throw Error('Empty ABI acquired a rendered default');
    } finally {
      disposable?.dispose(); container.remove();
      host.common.setMainWorkspace(mainWorkspace);
      delete host.Blocks[reloadType]; delete host.Blocks[parentType];
    }
    options.assertCurrent();
    if (host.Blocks.arduino_setup !== root || host.Block.prototype !== prototype || prototype.candidateOnly !== undefined
      || workspace.getBlockById('only-in-candidate') || document.querySelector('[data-blockly-native-candidate]')) throw Error('Candidate escaped or leaked');
    return { independentNativeCreation: true, hostWorkspaceUnchanged: true, noPreload: true, noFrameLeak: true,
      candidateFields: candidate.state.blocks.blocks[0].fields, absPositionBinding: true, fullLibraries, rejected,
      finalAbiVerification: { actualGeneratorExecuted: true, confirmedIdentity: verifiedRoot.id, metadataPreserved: true, generatorEffectRejected },
      ownedInputs: { modelId: 'owned-counter', bareVariableValueExpanded: true, payloadBytes: payload.length,
        compactTokenPreserved: !!owned.binding.syntax[0].fields.TEXT.value.$ailyProjectDataValue, actualGeneratorVerified: true },
      mixedHostModels: { nativeCalls: 2, hostPreparedCalls: 2, parameterModelId: 'mixed-param',
        completeAbiVerified: true, legacyGeneratorInputAdapter: true },
      nativeProjectReopen: { renderedWorkspace: true, ordinaryLoader: true, declarationJson: false,
        selectorLevels: 2, reopenCycles: 2, shadowRespawn: true, protectionPreserved: true },
      temporaryChildOwnership: { explicitValue: true, emptyInput: true, completeAbiVerified: true,
        modelLeakRejected: defaultModelRejected, renderedOnlyDefaultReplaced: true, orphanBlocks: 0 },
      implicitDefaults: { realChild: true, visibleShadow: true, dormantShadow: true,
        identityReplay: true, completeAbiVerified: true, inventedShadowRejected },
      scope: 'isolated-diagnostic-not-abs-apply' };
  }, { chunk: chunks[0], provenance });
  files.forEach((file, i) => assert.deepEqual(read(file), before[i]));
  return { project, ...evidence, mirrorsUnchanged: true, filePresence: Object.fromEntries(files.map((file, i) => [file, before[i] !== null])) };
}
module.exports = { testNativeCandidateIsolation };
