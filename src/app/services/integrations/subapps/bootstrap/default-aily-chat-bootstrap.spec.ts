import { bootstrapDefaultAilyChatSubapp } from './default-aily-chat-bootstrap';

describe('bootstrapDefaultAilyChatSubapp', () => {
  it('does not reinstall Aily Chat while an explicit uninstall is incomplete', async () => {
    const install = jasmine.createSpy('install').and.resolveTo(undefined);
    const result = await bootstrapDefaultAilyChatSubapp({
      completed: false,
      initialize: async () => undefined,
      readCatalog: () => [{
        id: 'aily-chat',
        toolId: 'aily-chat',
        installed: false,
        uninstalling: true,
      }],
      install,
      isPinned: () => false,
      pin: () => true,
      markCompleted: async () => undefined,
    });

    expect(result).toBeFalse();
    expect(install).not.toHaveBeenCalled();
  });
});
