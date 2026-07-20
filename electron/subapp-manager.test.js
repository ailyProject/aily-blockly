const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createSubappManager,
  resolveSubappRoot,
  validateIndex,
} = require('./subapp-manager');

function fixtureIndex(version = '0.1.0') {
  return {
    'aily-chat': {
      id: 'aily-chat',
      titleKey: 'AILY_CHAT.TITLE',
      namespace: 'AILY_CHAT',
      app: {
        name: 'AILY_CHAT.TITLE',
        description: 'AILY_CHAT.DESCRIPTION',
        icon: 'fa-light fa-puzzle-piece',
        enabled: true,
      },
      package: '@aily-project/subapp-aily-chat',
      version,
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: { TITLE: 'Aily Chat', DESCRIPTION: 'AI assistant' },
          zh_cn: { TITLE: 'Aily Chat', DESCRIPTION: 'AI 编程助手' },
        },
      },
    },
  };
}

test('resolves the required user npm-global/app installation root', () => {
  assert.equal(
    resolveSubappRoot({ platform: 'darwin', home: '/Users/test', env: {} }),
    '/Users/test/Library/aily-project/npm-global/app',
  );
});

test('rejects package targets that are not safe npm package names', () => {
  const index = fixtureIndex();
  index['aily-chat'].package = 'file:../../tmp/app';
  assert.throws(() => validateIndex(index), /Invalid subapp package/);
});

test('treats an npm-linked source package as an installed subapp', async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-link-'));
  const installRoot = path.join(fixtureRoot, 'npm-global', 'app');
  const sourceDir = path.join(fixtureRoot, 'source', 'aily-chat');
  const linkedDir = path.join(installRoot, 'node_modules', '@aily-project', 'subapp-aily-chat');
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  fs.mkdirSync(path.join(sourceDir, 'ui'), { recursive: true });
  fs.mkdirSync(path.dirname(linkedDir), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'index.js'), '');
  fs.writeFileSync(path.join(sourceDir, 'ui', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
    name: '@aily-project/subapp-aily-chat',
    version: '0.1.1',
    main: 'index.js',
  }));
  fs.symlinkSync(sourceDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');

  const manager = createSubappManager({
    rootDir: installRoot,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(fixtureIndex()),
    }),
  });
  const state = await manager.list({ refresh: true, locale: 'en' });
  assert.equal(state.apps[0].installed, true);
  assert.equal(state.apps[0].installedVersion, '0.1.1');
  assert.equal(state.apps[0].config.packagePath, linkedDir);
});

test('installs indexed package into the user app project and exposes its absolute runtime path', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-manager-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const npmCalls = [];
  let catalogVersion = '0.1.0';
  const manager = createSubappManager({
    rootDir,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(fixtureIndex(catalogVersion)),
    }),
    runNpm: async (args) => {
      npmCalls.push(args);
      const packageDir = path.join(rootDir, 'node_modules', '@aily-project', 'subapp-aily-chat');
      if (args[0] === 'uninstall') {
        fs.rmSync(packageDir, { recursive: true, force: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      fs.mkdirSync(path.join(packageDir, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'index.js'), '');
      fs.writeFileSync(path.join(packageDir, 'ui', 'index.html'), '<!doctype html>');
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
        name: '@aily-project/subapp-aily-chat',
        version: args.find((arg) => arg.startsWith('@aily-project/subapp-aily-chat@'))?.split('@').at(-1)
          || catalogVersion,
        main: 'index.js',
      }));
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  const before = await manager.list({ refresh: true, locale: 'zh-CN' });
  assert.equal(before.apps[0].installed, false);
  assert.equal(before.apps[0].description, 'AI 编程助手');
  assert.equal(before.apps[0].icon, 'fa-light fa-puzzle-piece');

  const after = await manager.install({ id: 'aily-chat', locale: 'zh-CN' });
  assert.deepEqual(npmCalls[0].slice(0, 3), ['install', '--prefix', rootDir]);
  assert.ok(npmCalls[0].includes('@aily-project/subapp-aily-chat@0.1.0'));
  assert.equal(after.apps[0].installed, true);
  assert.equal(after.apps[0].toolId, 'aily-chat-react');
  assert.equal(after.apps[0].config.app.name, 'Aily Chat');
  assert.equal(after.apps[0].config.app.description, 'AI 编程助手');
  assert.equal(
    after.apps[0].config.packagePath,
    path.join(rootDir, 'node_modules', '@aily-project', 'subapp-aily-chat'),
  );

  catalogVersion = '0.2.0';
  const checked = await manager.list({ refresh: true, locale: 'zh-CN' });
  assert.equal(checked.apps[0].updateAvailable, true);

  const updated = await manager.update({ id: 'aily-chat', locale: 'zh-CN' });
  assert.ok(npmCalls[1].includes('@aily-project/subapp-aily-chat@0.2.0'));
  assert.equal(updated.apps[0].installedVersion, '0.2.0');
  assert.equal(updated.apps[0].updateAvailable, false);

  const removed = await manager.uninstall({ id: 'aily-chat', locale: 'zh-CN' });
  assert.deepEqual(npmCalls[2].slice(0, 3), ['uninstall', '--prefix', rootDir]);
  assert.equal(removed.apps[0].installed, false);
});
