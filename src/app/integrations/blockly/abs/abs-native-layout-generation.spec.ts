import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { createAbsProjection } from './abs-identity-map';
import { createAbsReconciler } from './abs-reconciler';
import { prepareAbsNativeReconciliation } from './abs-native-reconciliation';
import { projectDataRuntime } from '@domain/project/project-data/public-api';

describe('native generation with the host new-root placement policy', () => {
  const request = (effect = '', generation = ''): NativeCandidateRequest => ({
    blocks: [], steps: [{ kind: 'context', mode: 'arduino' }, { kind: 'script', label: 'layout-generation-test', source: `
      let marker = 1;
      Blockly.Blocks.layout_generation_probe = { init() {
        this.appendDummyInput().appendField('root');
        ${effect}
      } };
      Arduino.forBlock.layout_generation_probe = block => {
        ${generation}
        Arduino.addSetup(block.id, '// ' + block.id + ':' + marker);
        return '';
      };
    ` }], verify: { state: { blocks: { languageVersion: 0, blocks: [
      { type: 'layout_generation_probe', id: 'existing', x: 30, y: 500 },
      { type: 'layout_generation_probe', id: 'new', x: 30, y: 60 },
    ] } }, contracts: { fields: { existing: {}, new: {} } }, newRootIds: ['new'] },
  });
  const run = (input: NativeCandidateRequest) => evaluateNativeCandidate(input, { assertCurrent() {} });

  it('generates in host placement order without overwriting editor-owned coordinates in the request or readback', async () => {
    const input = request('', `
      if (block.workspace.getTopBlocks(true).map(b => b.id).join(',') !== 'existing,new') {
        throw new Error('Generation used the pre-placement root order');
      }
    `);
    const original = JSON.stringify(input);
    const result = await run(input);
    expect(result.state).toEqual(input.verify!.state);
    expect(JSON.stringify(input)).toBe(original);
    expect(result.generationEvidence).toBeUndefined();
  });

  it('does not relocate existing roots when no new roots are requested', async () => {
    const input = request('', `
      if (block.workspace.getTopBlocks(true).map(b => b.id).join(',') !== 'new,existing') {
        throw new Error('Existing roots were moved');
      }
    `);
    input.verify!.newRootIds = [];
    expect((await run(input)).state).toEqual(input.verify!.state);
  });

  it('rejects a UI code effect observable only after the new root has its host placement', async () => {
    const input = request(`if (this.id === 'new') setTimeout(() => {
      if (this.getRelativeToSurfaceXY().y > this.workspace.getBlockById('existing').getRelativeToSurfaceXY().y) marker = 2;
    }, 0);`);
    // Reproduce the old gap: without placement the timer sees y=60 and does
    // nothing, although the real host places this root below y=500.
    await expectAsync(run({ ...input, verify: { ...input.verify!, newRootIds: [] } })).toBeResolved();
    await expectAsync(run(input)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_GENERATION_UNSTABLE' }));
  });

  it('does not undo a UI callback moving the new root and changing generated order', async () => {
    const input = request(`if (this.id === 'new') setTimeout(() => {
      this.moveBy(0, -this.getRelativeToSurfaceXY().y);
    }, 0);`);
    await expectAsync(run(input)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_GENERATION_UNSTABLE' }));
  });

  it('checks state again after placement callbacks instead of accepting mutated metadata', async () => {
    const input = request(`if (this.id === 'new') {
      const move = this.moveBy;
      this.moveBy = function(...args) {
        const result = move.apply(this, args);
        if (this.getRelativeToSurfaceXY().y > 500) this.data = 'unexpected';
        return result;
      };
    }`);
    await expectAsync(run(input)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_READBACK_MISMATCH' }));
  });

  for (const ids of [['missing'], ['new', 'new']]) it(`rejects invalid placement identities: ${ids}`, async () => {
    const input = request(); input.verify!.newRootIds = ids;
    await expectAsync(run(input)).toBeRejectedWithError(/unique final root identities/);
  });

  it('derives placement identities from the reconciled final roots, not text positions or caller guesses', async () => {
    // No resources in this fixture; keep the full reconciliation/realm path.
    spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    spyOn(projectDataRuntime, 'prepareValue').and.resolveTo();
    const workspace = { blocks: { blocks: [] } };
    const baseline = await createAbsProjection(workspace, { document: workspace, contracts: { fields: {} },
      generation: 'g', baselineRef: 'b', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
    const calls: NativeCandidateRequest[] = [];
    const steps: NativeCandidateRequest['steps'] = [...request().steps, { kind: 'script', label: 'nested-input', source: `
      const init = Blockly.Blocks.layout_generation_probe.init;
      Blockly.Blocks.layout_generation_probe.init = function() { init.call(this); this.appendValueInput('VALUE'); };
    ` }];
    const prepared = await prepareAbsNativeReconciliation(createAbsReconciler(baseline, '# ABS Schema: 2\nlayout_generation_probe(math_number(7))'), {}, async input => {
      const next = { ...input, steps }; calls.push(next); return run(next);
    }, () => {});
    const verification = calls.find(call => call.verify)!.verify!;
    expect(verification.newRootIds).toEqual(prepared.materialized.blocks.blocks.map(block => block.id));
    expect(verification.newRootIds!.length).toBe(1);
    expect(prepared.candidate.added.length).toBe(2); // Nested new values are not layout roots.
    expect(prepared.candidate.added).toContain(verification.newRootIds![0]);
  });
});
