import { retireEmptyProjectModels } from './abs-empty-project-models';
import { createAbsProjection } from './abs-identity-map';
import { reconcileAbs } from './abs-reconciler';
import { AbsProjection } from './abs-state';
import { prepareAbsNativeReconciliation } from './abs-native-reconciliation';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import { modelSteps } from './abs-native-models.fixture';
import type { NativeReplayStep } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { projectDataRuntime } from '@domain/project/public-api';

describe('blank project variable retirement', () => {
  const source = '# ABS Schema: 2\narduino_global()\narduino_setup()\narduino_loop()\nnew_device()';
  function fixture(): AbsProjection {
    const workspace = { blocks: { blocks: ['arduino_global', 'arduino_setup', 'arduino_loop'].map((type, index) => ({ type, id: type, x: 30, y: 60 + 120 * index, deletable: false })) },
      variables: [{ id: 'old', name: 'device', type: 'OldDriver' }] };
    return { workspace, document: { schemaVersion: 2, activePageId: 'main', openedPageIds: ['main'],
      pages: [{ id: 'main', title: 'main', content: { blocks: structuredClone(workspace.blocks) } }],
      sharedModel: { variables: structuredClone(workspace.variables), procedureBlocks: [] } }, contracts: { fields: {} } } as any;
  }
  it('retires only the detached candidate table, never the baseline', () => {
    const base = fixture(), before = JSON.stringify(base), candidate = structuredClone(base.workspace);
    expect(retireEmptyProjectModels(base, candidate, source)).toEqual(['old']);
    expect(candidate['variables']).toEqual([]);
    expect(JSON.stringify(base)).toBe(before);
  });
  it('retains models for comments, ordinary empty workspaces and unknown state', () => {
    const changed = [
      (base: any) => base.workspace.blocks.blocks = [],
      (base: any) => base.workspace.blocks.blocks[0].extraState = { variable: 'old' },
      (base: any) => base.workspace.variables[0].opaque = { anotherModel: 'old' },
      (base: any) => base.document.sharedModel.custom = { variable: 'old' },
      (base: any) => base.document.custom = { variable: 'old' },
      (base: any) => base.document.pages[0].content.customSerializer = {},
      (base: any) => base.document.sharedModel.procedureBlocks.push({ type: 'definition' }),
      (base: any) => base.document.pages.push({ id: 'other', content: { blocks: { blocks: [{ type: 'device' }] } } }),
      (base: any) => base.contracts.symbolTables = [{}],
    ];
    for (const change of changed) {
      const base = fixture(); change(base);
      const candidate = structuredClone(base.workspace), before = JSON.stringify(candidate);
      expect(retireEmptyProjectModels(base, candidate, source)).toEqual([]);
      expect(JSON.stringify(candidate)).toBe(before);
    }
    const base = fixture(), candidate = structuredClone(base.workspace);
    expect(retireEmptyProjectModels(base, candidate, source.replace('\nnew_device()', '\n# a comment'))).toEqual([]);
  });
  it('allows genuinely empty other pages and the known external-only marker', () => {
    const base = fixture(), doc: any = base.document;
    doc.$ailyProjectData = { schemaVersion: 1, mode: 'external-only' };
    doc.pages.push({ id: 'other', content: { blocks: { blocks: [] } } });
    expect(retireEmptyProjectModels(base, structuredClone(base.workspace), source)).toEqual(['old']);
  });
  it('uses normal reconciliation and preserves protected roots', async () => {
    const fixtureBase = fixture();
    const base = await createAbsProjection(fixtureBase.workspace, { document: fixtureBase.document,
      contracts: fixtureBase.contracts, generation: 'blank', baselineRef: 'blank', savedAbiHash: null,
      scope: { projectKey: 'p', pageId: 'main' } });
    const result = await reconcileAbs(base, base.abs + '\nnew_device()');
    expect(result.workspace['variables']).toEqual([]);
    expect(result.workspace.blocks.blocks.slice(0, 3)).toEqual(base.workspace.blocks.blocks);
    expect(base.workspace['variables']).toEqual(fixtureBase.workspace['variables']);
    expect((await reconcileAbs(base, base.abs + '\n# comment')).workspace['variables']).toEqual(fixtureBase.workspace['variables']);
  });

  it('prepares and verifies a new typed initializer over blank-project leftovers in the real isolated runtime', async () => {
    // This fixture has no external payloads and no host project filesystem.
    spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    spyOn(projectDataRuntime, 'prepareValue').and.resolveTo();
    const original = fixture();
    const base = await createAbsProjection(original.workspace, { document: original.document,
      contracts: original.contracts, generation: 'native-blank', baselineRef: 'blank', savedAbiHash: null,
      scope: { projectKey: 'p', pageId: 'main' } });
    const steps: NativeReplayStep[] = [...structuredClone(modelSteps), { kind: 'definitions', definitions:
      original.workspace.blocks.blocks.map(block => ({ type: block.type, message0: block.type })) },
      { kind: 'script', label: 'empty-roots', source:
        original.workspace.blocks.blocks.map(block => `Arduino.forBlock.${block.type} = () => '';`).join('\n') }];
    const before = JSON.stringify(base);
    const requests: any[] = [];
    const prepared = await prepareAbsNativeReconciliation(base,
      base.abs + '\ntest_object_init("device", Sensor)\ntest_object_read($device)', {}, async request => {
        requests.push(request);
        return evaluateNativeCandidate({ ...request, steps }, { assertCurrent: () => {} });
      }, () => {});
    expect(requests.length).toBe(3);
    expect(requests[0].variables).toEqual([]);
    expect(prepared.candidate.retiredModels).toEqual(['old']);
    expect(requests[2].verify).toBeDefined();
    expect(prepared.materialized['variables']).toEqual([jasmine.objectContaining({ name: 'device', type: 'Sensor' })]);
    expect((prepared.materialized['variables'] as any[])[0].id).not.toBe('old');
    expect(JSON.stringify(base)).toBe(before);
    expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0);
  });
});
