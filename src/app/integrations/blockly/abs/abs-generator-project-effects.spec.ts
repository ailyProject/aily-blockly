import { GeneratorProjectEffects } from '../../../editors/blockly-editor/services/generator-project-effects';
import { mergeGeneratorMacros } from '../../../editors/blockly-editor/services/prepared-generator-config';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';

describe('owned generator project effects', () => {
  const workspace = (ids = ['init']) => ({ getAllBlocks: () => ids.map(id => ({ id, isEnabled: () => true })) }) as any;
  it('collects settled macro chains synchronously and restores the original realm without writes', () => {
    const service = { addMacro: jasmine.createSpy('must not write') }, realm = { Promise, projectService: service };
    const effects = new GeneratorProjectEffects(realm);
    effects.run('init', () => {
      realm.Promise.resolve().then(() => realm.projectService.addMacro('TFT_WIDTH=480'))
        .then(() => realm.projectService.addMacro('TFT_HEIGHT=480')).catch(() => fail('unexpected failure'));
    });
    expect(effects.capture(workspace())).toEqual([{ name: 'TFT_HEIGHT', value: 'TFT_HEIGHT=480' }, { name: 'TFT_WIDTH', value: 'TFT_WIDTH=480' }]);
    expect(service.addMacro).not.toHaveBeenCalled(); expect(realm.Promise).toBe(Promise); expect(realm.projectService).toBe(service);
    expect(effects.capture(workspace([]))).toEqual([]);
  });

  for (const effect of ['executor', 'foreign', 'write', 'caught', 'late']) it(`rejects unsupported ${effect} effects`, () => {
    const realm: any = { Promise, projectService: {} }, effects = new GeneratorProjectEffects(realm);
    let late: any;
    if (effect === 'late') {
      effects.run('init', () => { late = realm.Promise.resolve(); });
      expect(() => late.then(() => {})).toThrowError(/outside/); return;
    }
    expect(() => effects.run('init', () => {
      if (effect === 'executor') new realm.Promise(() => {});
      if (effect === 'foreign') realm.Promise.resolve(Promise.resolve());
      if (effect === 'write') realm.projectService.save();
      if (effect === 'caught') { try { realm.projectService.save(); } catch {} }
    })).toThrowError(/Generator project effects/);
    expect(realm.Promise).toBe(Promise);
  });

  it('merges/removes generated configuration without deleting unrelated or manually changed macros', () => {
    const original = { dependencies: { demo: '1' }, MACROS: [['USER=1'], ['OLD=2'], ['EDITED=9']], ailyGeneratorMacros: { OLD: 'OLD=2', EDITED: 'EDITED=3' } };
    const result = mergeGeneratorMacros(original, [{ name: 'TFT_WIDTH', value: 'TFT_WIDTH=480' }]);
    expect(result.MACROS).toEqual([['USER=1'], ['EDITED=9'], ['TFT_WIDTH=480']]);
    expect(result.ailyGeneratorMacros).toEqual({ TFT_WIDTH: 'TFT_WIDTH=480' });
    expect(original.MACROS.length).toBe(3);
    expect(mergeGeneratorMacros(result, []).MACROS).toEqual([['USER=1'], ['EDITED=9']]);
  });

  it('discards partially captured effects after a failed generator invocation', () => {
    const realm: any = { Promise, projectService: {} }, effects = new GeneratorProjectEffects(realm);
    effects.run('init', () => { realm.projectService.addMacro('WIDTH=480'); });
    expect(() => effects.run('init', () => {
      realm.projectService.addMacro('WIDTH=320'); throw Error('failed generation');
    })).toThrowError('failed generation');
    expect(effects.capture(workspace())).toEqual([{ name: 'WIDTH', value: 'WIDTH=480' }]);
  });

  it('retains cached declarations but excludes disabled blocks and disabled ancestors', () => {
    const realm: any = { Promise, projectService: {} }, effects = new GeneratorProjectEffects(realm);
    effects.run('init', () => { realm.projectService.addMacro('WIDTH=480'); });
    effects.run('init', () => {}); // A generator may skip unchanged configuration.
    expect(effects.capture(workspace()).length).toBe(1);
    const block: any = { id: 'init', isEnabled: () => false };
    const ws: any = { getAllBlocks: () => [block] };
    expect(effects.capture(ws)).toEqual([]);
    block.isEnabled = () => true;
    block.getParent = () => ({ isEnabled: () => false });
    expect(effects.capture(ws)).toEqual([]);
  });

  it('wraps once and attributes nested generator calls to their own blocks', () => {
    const realm: any = { Promise, projectService: {} }, effects = new GeneratorProjectEffects(realm);
    const generator: any = { forBlock: {
      child: () => { realm.projectService.addMacro('CHILD=1'); return ''; },
      parent: (_block: any, current: any) => {
        current.forBlock.child({ id: 'child' }, current);
        realm.projectService.addMacro('PARENT=1'); return '';
      },
    } };
    effects.wrap(generator);
    const parent = generator.forBlock.parent;
    effects.wrap(generator);
    expect(generator.forBlock.parent).toBe(parent);
    generator.forBlock.parent({ id: 'parent' }, generator);
    expect(effects.capture(workspace(['parent']))).toEqual([{ name: 'PARENT', value: 'PARENT=1' }]);
    expect(effects.capture(workspace(['child']))).toEqual([{ name: 'CHILD', value: 'CHILD=1' }]);
  });

  it('validates a real isolated generator using the legacy Promise/macro interface', async () => {
    const result = await evaluateNativeCandidate({ blocks: [],
      steps: [{ kind: 'context', mode: 'arduino' }, { kind: 'definitions', definitions: [{ type: 'macro_setup', message0: 'setup', previousStatement: null, nextStatement: null }] },
        { kind: 'script', label: 'legacy-macro-chain', source: `Arduino.forBlock.macro_setup = function(block) {
          Blockly.renderManagement.triggerQueuedRenders();
          block.queueRender();
          Promise.resolve().then(() => window.projectService.removeMacro('')).then(() => window.projectService.addMacro('SCREEN_WIDTH=480'));
          return 'screen.begin();\\n';
        };` }],
      verify: { state: { blocks: { languageVersion: 0, blocks: [{ type: 'macro_setup', id: 'init', x: 0, y: 0 }] } }, contracts: { fields: {} } },
    }, { assertCurrent: () => {} });
    expect(result.state['blocks'].blocks[0].type).toBe('macro_setup');
  });
});
