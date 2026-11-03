import { BehaviorSubject } from 'rxjs';
import * as Blockly from 'blockly';
import { projectDataRuntime } from '@domain/project/public-api';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { BlocklyProjectRevision } from '../../../editors/blockly-editor/services/blockly-project-revision';
import { BlocklyWorkspaceEditGate } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';

describe('journal recovery complete read-only canvas snapshot', () => {
  let workspace: Blockly.Workspace;
  let service: any;
  const local = 'journal_recovery_local_fixture', shared = 'journal_recovery_shared_fixture';

  beforeEach(() => {
    Blockly.Blocks[local] = { init() { this.appendDummyInput().appendField(new Blockly.FieldTextInput('text'), 'TEXT'); },
      saveExtraState() { return { dynamicItems: ['kept', 7] }; } };
    Blockly.Blocks[shared] = { init() { this.appendDummyInput().appendField('definition'); }, getProcedureDef() { return ['fn', [], false]; } };
    workspace = new Blockly.Workspace();
    const block = workspace.newBlock(local, 'local-id');
    block.setFieldValue('unsaved text', 'TEXT');
    block.setDisabledReason(true, 'MANUALLY_DISABLED');
    block.setDisabledReason(true, 'library-owned-reason');
    block.setCollapsed(true); block.setEditable(false); block.setDeletable(false);
    workspace.newBlock(shared, 'shared-id');
    workspace.getVariableMap().createVariable('shared variable', '', 'variable-id');
    service = Object.create(BlocklyService.prototype);
    service._workspace = workspace;
    service.workspaceEditGate = new BlocklyWorkspaceEditGate();
    service.projectRevision = new BlocklyProjectRevision();
    service.documentMetadata = { extensionMetadata: { retained: true } };
    service.projectDocumentSchemaVersion = 3;
    service.activePageIdSubject = new BehaviorSubject('main');
    service.openedPageIdsSubject = new BehaviorSubject(['main', 'other']);
    service.pagesSubject = new BehaviorSubject([
      { id: 'main', title: 'Main', content: { blocks: { blocks: [] } } },
      { id: 'other', title: 'Other', custom: 'retained', content: { blocks: { blocks: [{ type: local, id: 'other-id', fields: { TEXT: 'other page' } }] } } },
    ]);
    service.sharedModelSubject = new BehaviorSubject({ procedureBlocks: [{ type: shared, id: 'shared-id' }], extensionModel: { kept: true } });
    service.captureWorkspaceViewState = () => ({ scale: 0.75, scrollX: 12, scrollY: 34 });
    service.getWorkspaceJson = jasmine.createSpy('normal serialization preparation').and.throwError('not a recovery read');
    service.projectDirtyState = { observeSnapshot: jasmine.createSpy('dirty observation') };
    service.releaseWorkspaceInputFence = jasmine.createSpy('persistent quarantine input fence');
    spyOn(projectDataRuntime, 'flushPending').and.rejectWith(new Error('not a recovery write'));
  });

  afterEach(() => { workspace.dispose(); delete Blockly.Blocks[local]; delete Blockly.Blocks[shared]; });

  it('preserves complete native state and all pages/models without normal preparation, saving or clearing quarantine', () => {
    const lease = service.workspaceEditGate.acquire();
    lease.quarantine('uncertain publication'); lease.release();
    const snapshot = service.captureRecoverySnapshot(), document = snapshot.document;
    expect(document.extensionMetadata).toEqual({ retained: true });
    expect(document.schemaVersion).toBe(3); expect(document.openedPageIds).toEqual(['main', 'other']);
    expect(document.pages[1]).toEqual(service.pagesSubject.value[1]);
    expect(document.pages[0].viewState).toEqual({ scale: 0.75, scrollX: 12, scrollY: 34 });
    const block = document.pages[0].content.blocks.blocks[0];
    expect(block.fields.TEXT).toBe('unsaved text');
    expect(block.disabledReasons).toEqual(['MANUALLY_DISABLED', 'library-owned-reason']);
    expect(block.collapsed).toBeTrue(); expect(block.editable).toBeFalse(); expect(block.deletable).toBeFalse();
    expect(block.extraState).toEqual({ dynamicItems: ['kept', 7] });
    expect(document.sharedModel.procedureBlocks.map((entry: any) => entry.id)).toEqual(['shared-id']);
    expect(document.sharedModel.variables).toEqual([{ name: 'shared variable', id: 'variable-id' }]);
    expect(document.sharedModel.extensionModel).toEqual({ kept: true });
    expect(snapshot.revision).toBeGreaterThan(0); expect(snapshot.documentText).toContain('unsaved text');
    expect(service.getWorkspaceJson).not.toHaveBeenCalled();
    expect(service.projectDirtyState.observeSnapshot).not.toHaveBeenCalled();
    expect(service.releaseWorkspaceInputFence).not.toHaveBeenCalled(); expect(projectDataRuntime.flushPending).not.toHaveBeenCalled();
    expect(service.workspaceEditGate.blocked).toBeTrue();
    expect(() => service.captureProjectSnapshot()).toThrowError(/uncertain publication/);
  });

  it('rejects active writer ownership even when a complete native read would otherwise be available', () => {
    const lease = service.workspaceEditGate.acquire();
    expect(() => service.captureRecoverySnapshot()).toThrowError(/active workspace writer/);
    expect(service.projectRevision.current).toBe(0); lease.release();
  });

  it('rejects a page activation changed by a native serializer and keeps ordinary inspection strict', () => {
    (workspace.getBlockById('local-id') as any).saveExtraState = () => {
      service.activePageIdSubject.next('other'); return { retained: true };
    };
    expect(() => service.captureRecoverySnapshot()).toThrowError(/changed during inspection/);
    expect(service.projectRevision.current).toBe(0);
  });

  it('reads stored documents before workspace initialization without invoking workspace preparation', () => {
    service._workspace = null;
    expect(service.getProjectDocument().pages.length).toBe(2);
    expect(service.captureRecoverySnapshot().document.sharedModel.extensionModel).toEqual({ kept: true });
    expect(service.getWorkspaceJson).not.toHaveBeenCalled();
  });
});
