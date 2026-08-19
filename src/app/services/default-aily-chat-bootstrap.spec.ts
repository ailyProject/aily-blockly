import {
  bootstrapDefaultAilyChatSubapp,
  type DefaultAilyChatBootstrapAdapter,
  type DefaultAilyChatCatalogItem,
} from './default-aily-chat-bootstrap';

describe('bootstrapDefaultAilyChatSubapp', () => {
  function createAdapter(options: {
    completed?: boolean;
    installed?: boolean;
    pinned?: boolean;
  } = {}) {
    let catalog: DefaultAilyChatCatalogItem[] = [{
      id: 'aily-chat',
      toolId: 'aily-chat-react',
      installed: options.installed === true,
    }];
    let pinned = options.pinned === true;
    const initialize = jasmine.createSpy('initialize').and.resolveTo();
    const install = jasmine.createSpy('install').and.callFake(async () => {
      catalog = catalog.map(item => ({ ...item, installed: true }));
    });
    const pin = jasmine.createSpy('pin').and.callFake(() => {
      pinned = true;
      return true;
    });
    const markCompleted = jasmine.createSpy('markCompleted').and.resolveTo();
    const adapter: DefaultAilyChatBootstrapAdapter = {
      completed: options.completed === true,
      initialize,
      readCatalog: () => catalog,
      install,
      isPinned: () => pinned,
      pin,
      markCompleted,
    };

    return { adapter, initialize, install, pin, markCompleted };
  }

  it('installs and pins the React child once before marking bootstrap complete', async () => {
    const { adapter, install, pin, markCompleted } = createAdapter();

    await expectAsync(bootstrapDefaultAilyChatSubapp(adapter)).toBeResolvedTo(true);

    expect(install).toHaveBeenCalledOnceWith('aily-chat');
    expect(pin).toHaveBeenCalledTimes(1);
    expect(markCompleted).toHaveBeenCalledTimes(1);
  });

  it('adopts an already installed and pinned child without reinstalling it', async () => {
    const { adapter, install, pin, markCompleted } = createAdapter({ installed: true, pinned: true });

    await expectAsync(bootstrapDefaultAilyChatSubapp(adapter)).toBeResolvedTo(true);

    expect(install).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(markCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not repeat work after the bootstrap marker is present', async () => {
    const { adapter, initialize, install, markCompleted } = createAdapter({ completed: true });

    await expectAsync(bootstrapDefaultAilyChatSubapp(adapter)).toBeResolvedTo(false);

    expect(initialize).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });
});
