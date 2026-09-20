import {
  bootstrapDefaultSubapps,
  DefaultSubappCatalogItem,
  DefaultSubappsBootstrapAdapter,
} from './default-subapps-bootstrap';
import { isAppAvailableForApplication } from '../../../../configs/tool.config';

function createHarness(initial: DefaultSubappCatalogItem[] = [], application = 'aily blockly') {
  let catalog = initial;
  const installedIds: string[] = [];
  const errors: string[] = [];
  const initialize = jasmine.createSpy('initialize').and.resolveTo(undefined);
  const adapter: DefaultSubappsBootstrapAdapter = {
    initialize,
    readCatalog: () => catalog,
    isAvailable: item => isAppAvailableForApplication(item.only, application),
    install: async id => {
      installedIds.push(id);
      catalog = catalog.map(item => item.id === id ? { ...item, installed: true, config: {} } : item);
    },
    onError: id => { errors.push(id); },
  };
  return { adapter, installedIds, errors, initialize,
    setCatalog: (items: DefaultSubappCatalogItem[]) => { catalog = items; },
    setApplication: (value: string) => { application = value; } };
}

const freshCatalog = (): DefaultSubappCatalogItem[] => [
  { id: 'aily-chat', toolId: 'aily-chat', installed: false, app: { autoInstall: true, defaultToolbar: true } },
  { id: 'serial-debugger', toolId: 'serial-debugger', installed: false, app: { autoInstall: true, defaultToolbar: false } },
];

describe('bootstrapDefaultSubapps catalog policies', () => {
  it('only installs the Coder editor when startup matches its declared product', async () => {
    const editor: DefaultSubappCatalogItem = {
      id: 'aily-coder-editor', toolId: 'aily-coder-editor', only: 'aily coder', installed: false,
      app: { autoInstall: true, defaultToolbar: false },
    };
    const h = createHarness([editor], 'aily blockly');
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual([]);

    h.setApplication('aily coder');
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual(['aily-coder-editor']);
  });

  for (const application of ['aily blockly', 'aily coder']) {
    it(`applies installation policies only to matching or unrestricted entries in ${application}`, async () => {
      const items: DefaultSubappCatalogItem[] = [undefined, 'all', 'aily blockly', 'aily coder', 'future-product']
        .map((only, index) => ({
          id: `tool-${index}`, toolId: `tool-${index}`, only, installed: false,
          app: { autoInstall: true, defaultToolbar: true },
        }));
      const h = createHarness(items, application);
      await bootstrapDefaultSubapps(h.adapter);
      const expected = ['tool-0', 'tool-1', application === 'aily coder' ? 'tool-3' : 'tool-2'];
      expect(h.installedIds).toEqual(expected);
    });
  }

  it('installs arbitrary configured entries using catalog ids', async () => {
    const h = createHarness([
      ...freshCatalog(),
      { id: 'new-tool', toolId: 'new-tool-alias', installed: false, app: { autoInstall: true, defaultToolbar: true } },
    ]);
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual(['aily-chat', 'serial-debugger', 'new-tool']);
  });

  it('does nothing when flags are missing or false, including for Chat and serial', async () => {
    const h = createHarness(freshCatalog().map(item => ({ ...item, app: {} })));
    await bootstrapDefaultSubapps(h.adapter);
    h.setCatalog(freshCatalog().map(item => ({ ...item, app: { autoInstall: false, defaultToolbar: false } })));
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual([]);
  });

  it('waits for catalog initialization before discovering policies', async () => {
    const h = createHarness([]);
    h.initialize.and.callFake(async () => { h.setCatalog(freshCatalog()); });
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds.length).toBe(2);
  });

  it('continues after failure and only retries the failed action next launch', async () => {
    const h = createHarness(freshCatalog());
    const install = h.adapter.install;
    h.adapter.install = async id => {
      if (id === 'aily-chat') throw new Error('offline');
      await install(id);
    };
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.errors).toEqual(['aily-chat']);
    expect(h.installedIds).toEqual(['serial-debugger']);
    h.adapter.install = install;
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual(['serial-debugger', 'aily-chat']);
  });

  it('reinstalls missing defaults at the next startup', async () => {
    const h = createHarness(freshCatalog());
    await bootstrapDefaultSubapps(h.adapter);
    h.setCatalog(freshCatalog().map(item => item.id === 'aily-chat' ? { ...item, installed: true, config: {} } : item));
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual(['aily-chat', 'serial-debugger', 'serial-debugger']);
  });

  it('does not repeat installation when startup state already matches', async () => {
    const h = createHarness(freshCatalog());
    await bootstrapDefaultSubapps(h.adapter);
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual(['aily-chat', 'serial-debugger']);
  });

  it('uses the current catalog flags on every startup', async () => {
    const disabled = () => freshCatalog().map(item => ({ ...item, app: { autoInstall: false, defaultToolbar: false } }));
    const h = createHarness(disabled());
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual([]);
    h.setCatalog(freshCatalog());
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual(['aily-chat', 'serial-debugger']);

    // Disabling auto-install does not uninstall anything already present.
    h.setCatalog(disabled().map(item => ({ ...item, installed: true, config: {} })));
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.adapter.readCatalog().every(item => item.installed)).toBeTrue();
    // Missing apps are no longer restored after auto-install is disabled.
    h.setCatalog(disabled());
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual(['aily-chat', 'serial-debugger']);
  });

  it('does not install an app merely because it requests default toolbar placement', async () => {
    const h = createHarness([{ id: 'manual-tool', toolId: 'manual-tool', installed: false,
      app: { defaultToolbar: true } }]);
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual([]);
  });

  it('reuses runnable installed development packages without replacing or updating', async () => {
    const h = createHarness(freshCatalog().map(item => ({ ...item, installed: true, config: {} })));
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual([]);
  });

  it('skips uninstalling, disabled, and other-product entries', async () => {
    const base = freshCatalog()[0];
    const h = createHarness([
      { ...base, id: 'uninstalling', uninstalling: true },
      { ...base, id: 'disabled', enabled: false },
      { ...base, id: 'app-disabled', app: { ...base.app, enabled: false } },
      { ...base, id: 'coder-only', only: 'aily coder' },
    ]);
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual([]);
  });

  it('rechecks product eligibility before restoring apps at later startups', async () => {
    const item: DefaultSubappCatalogItem = { id: 'coder-tool', toolId: 'coder-tool', only: 'aily coder',
      installed: false, app: { autoInstall: true, defaultToolbar: true } };
    const h = createHarness([item], 'aily coder');
    await bootstrapDefaultSubapps(h.adapter);
    h.setCatalog([item]);
    h.setApplication('aily blockly');
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual(['coder-tool']);
    h.setApplication('aily coder');
    await bootstrapDefaultSubapps(h.adapter);
    expect(h.installedIds).toEqual(['coder-tool', 'coder-tool']);
  });
});
