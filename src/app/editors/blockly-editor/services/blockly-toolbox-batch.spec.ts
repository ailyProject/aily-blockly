import { BlocklyService } from './blockly.service';

describe('project library toolbox batching', () => {
  let service: any, workspace: any;
  beforeEach(() => {
    workspace = { updateToolbox: jasmine.createSpy('updateToolbox') };
    service = Object.create(BlocklyService.prototype);
    Object.assign(service, { _workspace: workspace, toolbox: { contents: [] },
      ensureToolboxItemIds() {}, rebuildToolboxFacade: jasmine.createSpy('facade'),
      syncToolboxFacadeWithWorkspace() {} });
  });

  it('publishes a complete toolbox once across nested asynchronous library loads', async () => {
    await service.withToolboxRefreshBatch(async () => {
      service.toolbox.contents.push({ name: 'first' }); service.refreshToolboxFromContents();
      await service.withToolboxRefreshBatch(async () => {
        service.toolbox.contents.push({ name: 'second' }); service.refreshToolboxFromContents();
      });
      expect(workspace.updateToolbox).not.toHaveBeenCalled();
    });
    expect(workspace.updateToolbox).toHaveBeenCalledOnceWith(service.toolbox);
    expect(service.rebuildToolboxFacade).toHaveBeenCalledTimes(1);
    service.refreshToolboxFromContents();
    expect(workspace.updateToolbox).toHaveBeenCalledTimes(2);
  });

  it('retains successfully loaded libraries after a failure and releases the batch', async () => {
    await expectAsync(service.withToolboxRefreshBatch(async () => {
      service.refreshToolboxFromContents(); throw new Error('library failed');
    })).toBeRejectedWithError('library failed');
    expect(workspace.updateToolbox).toHaveBeenCalledTimes(1);
    service.refreshToolboxFromContents();
    expect(workspace.updateToolbox).toHaveBeenCalledTimes(2);
  });

  it('does not flush an obsolete workspace into a replacement editor', async () => {
    const replacement = { updateToolbox: jasmine.createSpy('replacement') };
    await service.withToolboxRefreshBatch(async () => {
      service.refreshToolboxFromContents();
      service._workspace = replacement;
      service.refreshToolboxFromContents();
    });
    expect(workspace.updateToolbox).not.toHaveBeenCalled();
    expect(replacement.updateToolbox).toHaveBeenCalledTimes(1);
  });
});
