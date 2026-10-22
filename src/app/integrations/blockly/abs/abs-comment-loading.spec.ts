import * as Blockly from 'blockly';
import { loadAbsWorkspaceState } from './abs-workspace-state';
import { BlocklyCommentLoading } from '../../../editors/blockly-editor/services/blockly-comment-loading';
import { assertAbsReadback } from './abs-readback';

describe('live workspace comment loading', () => {
  let host: HTMLDivElement, workspace: Blockly.WorkspaceSvg;
  const type = 'comment_loading_test';
  const state = () => ({ blocks: { languageVersion: 0, blocks: [{ type, id: 'comment-owner', x: 20, y: 30,
    icons: { comment: { text: 'Visible note 中文', pinned: true, width: 160, height: 80, x: 280, y: 120 } } }] } });
  beforeEach(() => {
    window['Blockly'] = Blockly;
    host = document.createElement('div'); host.style.cssText = 'width:800px;height:600px'; document.body.append(host);
    workspace = Blockly.inject(host, { sounds: false });
    Blockly.Blocks[type] = { init() { this.appendDummyInput().appendField('comment owner'); } };
  });
  afterEach(() => { workspace.dispose(); host.remove(); delete Blockly.Blocks[type]; });

  for (const chunk of [false, true]) it(`finishes pinned comments before ${chunk ? 'chunked' : 'normal'} load returns`, async () => {
    const expected = state();
    const hook = Blockly.icons.CommentIcon.prototype.updateEditable;
    await loadAbsWorkspaceState(expected, workspace, { chunk }, () => {});
    const actual = Blockly.serialization.workspaces.save(workspace);
    assertAbsReadback(expected, actual as any, { mode: 'requested' });
    const icon = workspace.getBlockById('comment-owner')!.getIcon(Blockly.icons.CommentIcon.TYPE) as Blockly.icons.CommentIcon;
    expect(icon.getBubble()!.getText()).toBe('Visible note 中文');
    expect(Blockly.icons.CommentIcon.prototype.updateEditable).toBe(hook);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(actual);
  });

  it('joins rollback comment restoration without leaving prototype hooks installed', async () => {
    const expected = state(), comments = new BlocklyCommentLoading(Blockly, workspace);
    const hook = Blockly.icons.CommentIcon.prototype.setBubbleVisible;
    comments.run(() => Blockly.serialization.workspaces.load(expected, workspace));
    expect(Blockly.icons.CommentIcon.prototype.setBubbleVisible).toBe(hook);
    await comments.finish(() => {});
    assertAbsReadback(expected, Blockly.serialization.workspaces.save(workspace) as any, { mode: 'requested' });
    expect(() => comments.run(() => { throw Error('failed load'); })).toThrowError('failed load');
    expect(Blockly.icons.CommentIcon.prototype.setBubbleVisible).toBe(hook);
  });
});
