import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { applyAbsStateEdits } from './abs-state-edits';
import { parseAbsSyntax } from './abs-syntax';

describe('Native ABI comment preparation', () => {
  function request(pinned: boolean): NativeCandidateRequest {
    return {
      steps: [
        { kind: 'context', mode: 'arduino' },
        { kind: 'definitions', definitions: [{ type: 'comment_test', message0: 'test', previousStatement: null, nextStatement: null }] },
        { kind: 'script', label: 'synchronous generator', source: `Arduino.forBlock.comment_test = () => 'delay(1);\\n';` },
      ], blocks: [], verify: {
        state: { blocks: { languageVersion: 0, blocks: [{ id: 'comment-owner', type: 'comment_test', x: 30, y: 50,
          icons: { comment: { text: 'Keep comment 中文', pinned, width: 160, height: 80, ...(pinned ? { x: 280, y: 120 } : {}) } } }] } },
        contracts: { fields: { 'comment-owner': {} } },
      },
    };
  }
  const run = (candidate: NativeCandidateRequest) => evaluateNativeCandidate(candidate, { assertCurrent: () => {} });
  afterEach(() => expect(document.querySelector('[data-blockly-native-candidate]')).toBeNull());

  for (const existing of [false, true]) for (const text of ['New note 中文', '']) {
    it(`round-trips ${text ? 'text' : 'empty text'} edits on ${existing ? 'existing' : 'new'} comments through real Blockly`, async () => {
      const candidate = request(false), block = candidate.verify!.state.blocks.blocks[0];
      if (!existing) delete block['icons'];
      else Object.assign((block['icons'] as any).comment, { width: 230, height: 110, x: 410, y: 230 });
      applyAbsStateEdits(block, parseAbsSyntax('# ABS Schema: 2\ncomment_test() @comment:' + JSON.stringify(text))[0], () => undefined);
      const result = await run(candidate);
      expect(result.state).toEqual(candidate.verify!.state);
      if (text) expect((result.state['blocks'].blocks[0]['icons'] as any).comment).toEqual(existing
        ? { text, pinned: false, width: 230, height: 110, x: 410, y: 230 }
        : { text, pinned: false, width: 160, height: 80 });
      else expect(result.state['blocks'].blocks[0]['icons']).toBeUndefined();
    });
  }

  for (const pinned of [false, true]) it(`preserves complete ${pinned ? 'open' : 'closed'} comments through final verification`, async () => {
    const candidate = request(pinned);
    const result = await run(candidate);
    expect(result.state).toEqual(candidate.verify!.state);
  });

  it('accepts native bubble placement for an open comment without requested coordinates', async () => {
    const candidate = request(true);
    const comment = (candidate.verify!.state.blocks.blocks[0]['icons'] as any).comment;
    delete comment.x; delete comment.y;
    const result = await run(candidate);
    const saved = result.state['blocks'].blocks[0].icons.comment;
    expect(saved.x).toEqual(jasmine.any(Number));
    expect(saved.y).toEqual(jasmine.any(Number));
    expect(saved.text).toBe(comment.text);
    expect(comment.x).toBeUndefined();
    expect(comment.y).toBeUndefined();
  });

  it('does not admit a replaced comment visibility callback', async () => {
    const candidate = request(true);
    candidate.steps.push({ kind: 'script', label: 'replaced core hook', source: `
      Blockly.icons.CommentIcon.prototype.setBubbleVisible = function() {
        return Promise.resolve().then(() => this.sourceBlock.setData('changed'));
      };
    ` });
    await expectAsync(run(candidate)).toBeRejectedWithError(/original bundled comment hooks/);
  });

  it('does not grant core continuation ownership to a replaced bubble helper', async () => {
    const candidate = request(true);
    candidate.steps.push({ kind: 'script', label: 'replaced bubble helper', source: `
      Blockly.icons.CommentIcon.prototype.createBubble = function() {
        Promise.resolve().then(() => this.sourceBlock.setData('changed'));
      };
    ` });
    await expectAsync(run(candidate)).toBeRejectedWithError(/original bundled comment hooks/);
  });

  it('preserves closed comment coordinates and disabled, collapsed metadata', async () => {
    const candidate = request(false);
    Object.assign(candidate.verify!.state.blocks.blocks[0], { collapsed: true, disabledReasons: ['MANUALLY_DISABLED'] });
    const icons = candidate.verify!.state.blocks.blocks[0]['icons'] as { comment: Record<string, unknown> };
    Object.assign(icons.comment, { x: 410, y: 230 });
    expect((await run(candidate)).state).toEqual(candidate.verify!.state);
  });

  it('still rejects a library continuation when comments are present', async () => {
    const candidate = request(true);
    candidate.steps.push({ kind: 'script', label: 'library continuation', source: `
      const init = Blockly.Blocks.comment_test.init;
      Blockly.Blocks.comment_test.init = function() {
        init.call(this);
        try { Blockly.renderManagement.finishQueuedRenders().then(() => {}); } catch {}
      };
    ` });
    await expectAsync(run(candidate)).toBeRejectedWithError(/Promise continuations/);
  });

  it('does not let a generator acquire comment continuation ownership after loading', async () => {
    const candidate = request(true);
    candidate.steps.push({ kind: 'script', label: 'generator comment work', source: `
      Arduino.forBlock.comment_test = block => {
        try { block.getIcon(Blockly.icons.CommentIcon.TYPE).setBubbleVisible(true); } catch {}
        return 'delay(1);\\n';
      };
    ` });
    await expectAsync(run(candidate)).toBeRejectedWithError(/only supported during workspace loading/);
  });
});
