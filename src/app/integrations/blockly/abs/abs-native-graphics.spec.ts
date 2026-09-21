import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';

describe('isolated native graphical candidate', () => {
  const source = `
    Blockly.Blocks.graphical_owner = { init() {
      if (!(this instanceof Blockly.BlockSvg) || !this.workspace.rendered ||
        !this.workspace.getParentSvg().isConnected || this.workspace.getParentSvg().getBoundingClientRect().width < 100) {
        throw Error('not a real, measurable graphical workspace');
      }
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([['off', 'OFF'], ['on', 'ON']]), 'MODE');
      this.getField('MODE').setValidator(mode => {
        if (this.getInput('VALUE')) this.removeInput('VALUE');
        if (mode === 'ON') {
          const connection = this.appendValueInput('VALUE').setCheck('Number').connection;
          const child = this.workspace.newBlock('math_number');
          child.setFieldValue(8, 'NUM'); child.setShadow(true);
          child.initSvg(); child.render();
          if (!child.getSvgRoot().isConnected || !child.getSvgRoot().querySelector('path').getAttribute('d')) throw Error('missing native graphics');
          connection.connect(child.outputConnection);
        }
        return mode;
      });
    } };
    Arduino.forBlock.graphical_owner = block => {
      Arduino.addSetup('graphical', 'consume(' + (Arduino.valueToCode(block, 'VALUE', 0) || '0') + ');'); return '';
    };
  `;
  const request = (abs = 'graphical_owner(ON, math_number(32))'): NativeCandidateRequest => ({
    steps: [{ kind: 'context', mode: 'arduino' }, { kind: 'script', label: 'unknown-graphical-library', source }],
    abs: '# ABS Schema: 2\n' + abs, blocks: [],
  });
  const run = (value: NativeCandidateRequest) => evaluateNativeCandidate(value, { assertCurrent() {} });
  afterEach(() => expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0));

  it('uses real SVG creation/render/connect, preserving the native default shadow under an explicit value', async () => {
    const result = await run(request());
    const root = result.state['blocks'].blocks[0];
    expect(result.state['blocks'].blocks.length).toBe(1);
    expect(root.inputs.VALUE.block.fields.NUM).toBe(32);
    expect(result.binding!.defaults[0].state.shadow!.fields!['NUM']).toBe(8);
    expect(result.binding!.instances.length).toBe(2);
  });

  it('adopts only connected owned defaults and supports removing the dynamic input', async () => {
    const root = (await run(request('graphical_owner(ON)'))).state['blocks'].blocks[0];
    expect(root.inputs.VALUE.shadow.fields.NUM).toBe(8);
    const empty = (await run(request('graphical_owner(OFF)'))).state['blocks'].blocks[0];
    expect(empty.inputs?.VALUE).toBeUndefined();
  });

  it('replays final ABI with protection, coordinates and saved shadow identities', async () => {
    const value = request(); delete value.abs;
    const state = { blocks: { blocks: [{ type: 'graphical_owner', id: 'root', x: 30, y: 60, deletable: false,
      fields: { MODE: 'ON' }, inputs: { VALUE: {
        shadow: { type: 'math_number', id: 'fallback', fields: { NUM: 8 } },
        block: { type: 'math_number', id: 'value', fields: { NUM: 32 } },
      } } }] } };
    value.verify = { state, contracts: { fields: { root: {
      MODE: { type: 'field_dropdown', options: [['off', 'OFF'], ['on', 'ON']] },
    } } } };
    const root = (await run(value)).state['blocks'].blocks[0];
    expect(root).toEqual(jasmine.objectContaining({ id: 'root', x: 30, y: 60, deletable: false }));
    expect(root.inputs.VALUE.shadow.id).toBe('fallback');
    expect(root.inputs.VALUE.block.id).toBe('value');
  });

  it('drains state-neutral frames and cancels frames without browser races', async () => {
    const value = request();
    value.steps.push({ kind: 'script', label: 'frames', source: `
      const init = Blockly.Blocks.graphical_owner.init;
      Blockly.Blocks.graphical_owner.init = function() {
        init.call(this);
        cancelAnimationFrame(requestAnimationFrame(() => { throw Error('cancelled frame'); }));
        requestAnimationFrame(time => { if (!Number.isFinite(time)) throw Error('invalid timestamp'); this.setTooltip('ready'); });
      };
    ` });
    await run(value);
  });

  it('does not auto-bump overlapping scratch roots while preparing native geometry', async () => {
    const value = request('graphical_owner(OFF)\nmath_number(3)');
    value.steps.push({ kind: 'script', label: 'empty-native-socket', source: `
      const init = Blockly.Blocks.graphical_owner.init;
      Blockly.Blocks.graphical_owner.init = function() { init.call(this); this.appendValueInput('EMPTY'); };
    ` });
    const roots = (await run(value)).state['blocks'].blocks;
    expect(roots.length).toBe(2);
    expect(roots.map(block => [block.x, block.y])).toEqual([[0, 0], [0, 0]]);
  });

  for (const effect of [
    `this.setFieldValue('OFF', 'MODE')`,
    `this.appendValueInput('UNREQUESTED')`,
    `this.moveBy(40, 0)`,
    `try { fetch('https://example.invalid/'); } catch {}`,
    `try { Promise.resolve().then(() => {}); } catch {}`,
    `const repeat = () => requestAnimationFrame(repeat); repeat()`,
  ]) it('rejects unsafe or semantic frame work: ' + effect, async () => {
    const value = request();
    value.steps.push({ kind: 'script', label: 'unsafe-frame', source: `
      const init = Blockly.Blocks.graphical_owner.init;
      Blockly.Blocks.graphical_owner.init = function() { init.call(this); requestAnimationFrame(() => { ${effect}; }); };
    ` });
    await expectAsync(run(value)).toBeRejected();
    await run(request('graphical_owner(OFF)'));
  });
});
