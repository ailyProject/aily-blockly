import * as Blockly from 'blockly';
import '../../../editors/blockly-editor/components/blockly/renderer/aily-icon';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { assertAbsReadback } from './abs-readback';

describe('legacy Aily icon archive loading', () => {
  const type = 'legacy_icon_archive_probe';
  let host: HTMLDivElement, workspace: Blockly.WorkspaceSvg;
  beforeEach(() => {
    host = document.createElement('div'); host.style.cssText = 'width:600px;height:400px'; document.body.append(host);
    workspace = Blockly.inject(host, {});
    Blockly.Blocks[type] = { init() { this.appendDummyInput().appendField('legacy icon'); } };
  });
  afterEach(() => { workspace.dispose(); host.remove(); delete Blockly.Blocks[type]; });

  for (const icon of ['fa-light fa-arrows-repeat', { type: 'i', src: 'fa-solid fa-star', width: 20, height: 20, color: 'red' }]) {
    it(`preserves ${typeof icon} icon state together with interactive comments across save and reopen`, () => {
      const catalog = new BlocklyDeclarativeBlockCatalog();
      const service = {
        workspace, iconsMap: new Map([[type, { ailyIcon: 'library default' }]]),
        adaptWorkspaceToRuntime: BlocklyService.prototype.adaptWorkspaceToRuntime,
        cloneJson: value => structuredClone(value), assertWorkspaceEditAvailable() {},
        captureDeclarativeBlockDefinitions: () => catalog.capture(Blockly.Blocks),
      };
      const input = { blocks: { blocks: [{ type, id: 'kept', icons: {
        ailyIcon: icon, comment: { text: 'user note', pinned: false, height: 80, width: 160 },
      } }] } };
      const before = JSON.stringify(input);
      for (let n = 0; n < 2; n++) {
        BlocklyService.prototype.loadWorkspaceJson.call(service, input);
        const saved = Blockly.serialization.workspaces.save(workspace);
        assertAbsReadback(input as any, saved as any, { mode: 'requested' });
        expect((saved['blocks'] as any).blocks[0].icons.ailyIcon).toEqual(icon);
        expect(workspace.getBlockById('kept')!.getCommentText()).toBe('user note');
      }
      expect(JSON.stringify(input)).toBe(before);
    });
  }
});
