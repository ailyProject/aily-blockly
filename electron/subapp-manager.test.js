const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BUILTIN_DEPENDENCY_ENTRIES,
  TOOL_ID_ALIASES,
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

test('routes the installed Simulator package through its dedicated host', () => {
  assert.equal(TOOL_ID_ALIASES['aily-simulator'], 'simulator');
});

test('declares Coder as a dynamically installed dependency package', () => {
  assert.deepEqual(BUILTIN_DEPENDENCY_ENTRIES['aily-coder'], {
    id: 'aily-coder',
    role: 'dependency',
    titleKey: 'AILY_CODER.TITLE',
    namespace: 'AILY_CODER',
    app: {
      name: 'AILY_CODER.TITLE',
      description: 'AILY_CODER.DESCRIPTION',
      icon: 'fa-light fa-code',
      enabled: true,
    },
    package: '@aily-project/subapp-aily-coder',
    version: '0.1.0',
    i18n: {
      defaultLocale: 'en',
      locales: {
        en: {
          TITLE: 'Aily Coder',
          DESCRIPTION: 'Code editor extension for Coder mode',
        },
        zh_cn: {
          TITLE: 'Aily Coder',
          DESCRIPTION: 'Coder 模式所需的代码编辑器扩展',
        },
        zh_hk: {
          TITLE: 'Aily Coder',
          DESCRIPTION: 'Coder 模式所需的程式碼編輯器擴充',
        },
      },
    },
  });
});

test('keeps the built-in Coder dependency available when the remote index is offline', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-coder-offline-index-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const manager = createSubappManager({
    rootDir,
    fetchImpl: async () => {
      throw new Error('offline fixture');
    },
  });

  const state = await manager.list({ refresh: true, locale: 'zh-CN' });

  assert.equal(state.source, 'builtin');
  assert.match(state.warning, /offline fixture/);
  assert.equal(state.apps.length, 1);
  assert.equal(state.apps[0].id, 'aily-coder');
  assert.equal(state.apps[0].role, 'dependency');
  assert.equal(state.apps[0].installed, false);
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
  fs.mkdirSync(path.join(sourceDir, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, 'skill', 'fixture-skill'), { recursive: true });
  fs.mkdirSync(path.dirname(linkedDir), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'index.js'), '');
  fs.writeFileSync(path.join(sourceDir, 'ui', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(sourceDir, 'agent', 'tools.json'), JSON.stringify({
    protocolVersion: 1,
    transport: 'aily-child-rpc',
    lifecycle: {
      sessionRelease: {
        method: 'fixture.session.close',
        params: { reason: 'host-session-release' },
        timeoutMs: 2500,
      },
    },
    tools: [{
      name: 'fixture_echo',
      description: 'Echo through the fixture subapp Runtime.',
      rpc: { method: 'fixture.echo' },
      permission: 'read',
      timeoutMs: 5000,
      maxOutputBytes: 49152,
      presentation: {
        mode: 'dock',
        surface: 'compact',
        autoOpen: 'first-active',
        when: {
          param: 'action',
          values: ['open'],
        },
      },
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        additionalProperties: false,
      },
    }],
  }));
  fs.writeFileSync(path.join(sourceDir, 'skill', 'fixture-skill', 'SKILL.md'), [
    '---',
    'name: fixture-skill',
    'description: Fixture skill.',
    '---',
    '',
    '# Fixture',
  ].join('\n'));
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
    name: '@aily-project/subapp-aily-chat',
    version: '0.1.1',
    main: 'index.js',
    ailySubapp: {
      ui: {
        surfaces: {
          compact: {
            entry: 'ui/index.html',
            minWidth: 280,
            minHeight: 180,
            preferredHeight: 260,
            interactive: true,
          },
        },
      },
      runtime: {
        startupTimeoutMs: 20000,
      },
      agent: {
        protocolVersion: 1,
        skills: ['skill/fixture-skill/SKILL.md'],
        tools: {
          transport: 'aily-child-rpc',
          manifest: 'agent/tools.json',
        },
      },
    },
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
  assert.equal(state.apps[0].config.startupTimeoutMs, 20000);
  assert.deepEqual(state.apps[0].config.ui, {
    surfaces: {
      default: {
        entry: 'ui/index.html',
      },
      compact: {
        entry: 'ui/index.html',
        minWidth: 280,
        minHeight: 180,
        preferredHeight: 260,
        interactive: true,
      },
    },
  });
  assert.equal(state.apps[0].config.agent.transport, 'aily-child-rpc');
  assert.deepEqual(state.apps[0].config.agent.lifecycle, {
    sessionRelease: {
      method: 'fixture.session.close',
      params: { reason: 'host-session-release' },
      timeoutMs: 2500,
    },
  });
  assert.deepEqual(state.apps[0].config.agent.skills, ['skill/fixture-skill/SKILL.md']);
  assert.equal(state.apps[0].config.agent.tools[0].name, 'fixture_echo');
  assert.equal(state.apps[0].config.agent.tools[0].rpc.method, 'fixture.echo');
  assert.deepEqual(state.apps[0].config.agent.tools[0].presentation, {
    mode: 'dock',
    surface: 'compact',
    autoOpen: 'first-active',
    when: {
      param: 'action',
      values: ['open'],
    },
  });
});

test('rejects an unsafe compact UI surface entry without exposing a runnable config', async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-surface-'));
  const installRoot = path.join(fixtureRoot, 'install');
  const sourceDir = path.join(fixtureRoot, 'source');
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
    ailySubapp: {
      ui: {
        surfaces: {
          compact: {
            entry: '../outside.html',
          },
        },
      },
    },
  }));
  fs.symlinkSync(sourceDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');

  const manager = createSubappManager({
    rootDir: installRoot,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(fixtureIndex()),
    }),
  });
  const state = await manager.list({ locale: 'en', refresh: true });

  assert.equal(state.apps[0].installed, false);
  assert.equal(state.apps[0].config, null);
  assert.match(state.apps[0].installError, /Unsafe ailySubapp\.ui\.surfaces\.compact\.entry/);
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

test('update replaces stale package files even when npm metadata already claims the target version', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-stale-update-'));
  const packageDir = path.join(rootDir, 'node_modules', '@aily-project', 'subapp-aily-chat');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(packageDir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'index.js'), '');
  fs.writeFileSync(path.join(packageDir, 'ui', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@aily-project/subapp-aily-chat',
    version: '0.1.0',
    main: 'index.js',
  }));

  const npmCalls = [];
  const manager = createSubappManager({
    rootDir,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(fixtureIndex('0.1.1')),
    }),
    runNpm: async (args) => {
      npmCalls.push(args);
      assert.equal(fs.existsSync(packageDir), false, 'stale package must be moved aside before npm runs');
      fs.mkdirSync(path.join(packageDir, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'index.js'), '');
      fs.writeFileSync(path.join(packageDir, 'ui', 'index.html'), '<!doctype html>');
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
        name: '@aily-project/subapp-aily-chat',
        version: '0.1.1',
        main: 'index.js',
      }));
      return { code: 0, stdout: 'changed 1 package', stderr: '' };
    },
  });

  const updated = await manager.update({ id: 'aily-chat', locale: 'en' });
  assert.equal(npmCalls.length, 1);
  assert.equal(updated.apps[0].installedVersion, '0.1.1');
  assert.equal(updated.apps[0].updateAvailable, false);
  assert.equal(fs.readdirSync(rootDir).some((name) => name.startsWith('.subapp-update-')), false);
});

test('update restores the previous package when the replacement cannot be verified', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-update-rollback-'));
  const packageDir = path.join(rootDir, 'node_modules', '@aily-project', 'subapp-aily-chat');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(packageDir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'old runtime');
  fs.writeFileSync(path.join(packageDir, 'ui', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@aily-project/subapp-aily-chat',
    version: '0.1.0',
    main: 'index.js',
  }));

  const manager = createSubappManager({
    rootDir,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(fixtureIndex('0.1.1')),
    }),
    runNpm: async () => ({ code: 0, stdout: 'up to date', stderr: '' }),
  });

  await assert.rejects(
    manager.update({ id: 'aily-chat', locale: 'en' }),
    /update verification failed/,
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version, '0.1.0');
  assert.equal(fs.readFileSync(path.join(packageDir, 'index.js'), 'utf8'), 'old runtime');
});
