const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_INDEX_URL,
  TOOL_ID_ALIASES,
  buildSubappIndexUrl,
  clampProgress,
  createMutationProgressTracker,
  createSubappManager,
  isBusyRenameError,
  isDistRelativePath,
  parseDependencyProgressLog,
  prepareNpmSpawn,
  quoteWindowsShellPath,
  renameWithBusyRetry,
  resolveRunnablePackage,
  resolveSubappRoot,
  safeSubappShutdownUrl,
  resolveUiIndex,
  validateIndex,
  verifyInstalledSubappStartup,
} = require('./subapp-manager');

const defaultConfig = require('./config/config.json');

function seedInstalledChatPackage(rootDir, version = '0.1.0') {
  const packageDir = path.join(rootDir, 'node_modules', '@aily-project', 'subapp-aily-chat');
  fs.mkdirSync(path.join(packageDir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'runtime');
  fs.writeFileSync(path.join(packageDir, 'ui', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@aily-project/subapp-aily-chat',
    version,
    main: 'index.js',
  }));
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({
    name: 'aily-subapps',
    private: true,
    dependencies: { '@aily-project/subapp-aily-chat': version },
  }));
  return packageDir;
}

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
        ai: true,
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

test('builds the subapp catalog URL from the configured region resource', () => {
  assert.equal(
    buildSubappIndexUrl(defaultConfig.regions.cn.resource),
    'https://blockly.yiyu.pro/subapp-index.json',
  );
  assert.equal(
    buildSubappIndexUrl(`${defaultConfig.regions.eu.resource}/`),
    'https://rs1.aily.pro/subapp-index.json',
  );
  assert.equal(DEFAULT_INDEX_URL, buildSubappIndexUrl(
    defaultConfig.regions[defaultConfig.region].resource,
  ));
});

test('quotes Windows npm paths that contain spaces for shell:true', (t) => {
  assert.equal(
    quoteWindowsShellPath('D:\\Program Files\\Aily\\node\\npm.cmd'),
    '"D:\\Program Files\\Aily\\node\\npm.cmd"',
  );

  const spawnSpec = prepareNpmSpawn(
    ['install', '--prefix', 'D:\\Program Files\\aily-project\\npm-global\\app', 'pkg@1.0.0'],
    {
      platform: 'win32',
      env: { AILY_CHILD_PATH: '' },
    },
  );

  assert.equal(spawnSpec.shell, true);
  assert.equal(spawnSpec.command, '"npm.cmd"');
  assert.deepEqual(spawnSpec.args, [
    'install',
    '--prefix',
    '"D:\\Program Files\\aily-project\\npm-global\\app"',
    'pkg@1.0.0',
  ]);

  const childRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily Program Files-'));
  const bundledNpm = path.join(childRoot, 'node', 'npm.cmd');
  t.after(() => fs.rmSync(childRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(bundledNpm), { recursive: true });
  fs.writeFileSync(bundledNpm, '@echo off\r\n');

  const bundledSpawn = prepareNpmSpawn(
    ['install', '--prefix', path.join(childRoot, 'npm-global', 'app'), 'pkg@1.0.0'],
    {
      platform: 'win32',
      env: { AILY_CHILD_PATH: childRoot },
    },
  );

  assert.equal(bundledSpawn.command, quoteWindowsShellPath(bundledNpm));
  assert.match(bundledSpawn.command, /^".*Program Files.*npm\.cmd"$/);
});

test('does not quote npm spawn args on non-Windows platforms', () => {
  const spawnSpec = prepareNpmSpawn(
    ['install', '--prefix', '/Users/test/Library/aily-project/npm-global/app', 'pkg@1.0.0'],
    {
      platform: 'darwin',
      env: { AILY_CHILD_PATH: '' },
    },
  );

  assert.equal(spawnSpec.shell, false);
  assert.equal(spawnSpec.command, 'npm');
  assert.deepEqual(spawnSpec.args, [
    'install',
    '--prefix',
    '/Users/test/Library/aily-project/npm-global/app',
    'pkg@1.0.0',
  ]);
});

test('routes the installed Simulator package through its dedicated host', () => {
  assert.equal(TOOL_ID_ALIASES['aily-simulator'], 'simulator');
});

test('rejects package targets that are not safe npm package names', () => {
  const index = fixtureIndex();
  index['aily-chat'].package = 'file:../../tmp/app';
  assert.throws(() => validateIndex(index), /Invalid subapp package/);
});

test('preserves extensible catalog and app metadata', () => {
  const index = fixtureIndex();
  index['aily-chat'].futureCatalogField = { channel: 'preview' };
  index['aily-chat'].app.futureAppField = 'future-value';

  const validated = validateIndex(index)['aily-chat'];
  assert.equal(validated.app.ai, true);
  assert.equal(validated.app.futureAppField, 'future-value');
  assert.deepEqual(validated.futureCatalogField, { channel: 'preview' });
});

test('accepts the development index flag without treating it as a catalog entry', () => {
  const validated = validateIndex({ dev: true, ...fixtureIndex() });
  assert.equal(validated.dev, true);
  assert.deepEqual(Object.keys(validated), ['dev', 'aily-chat']);
  assert.throws(
    () => validateIndex({ dev: 'true', ...fixtureIndex() }),
    /dev flag must be a boolean/,
  );
});

test('does not request or overwrite the remote index while the cached dev flag is enabled', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-dev-index-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'subapp-index.json'),
    `${JSON.stringify({ dev: true, ...fixtureIndex() }, null, 2)}\n`,
  );
  let fetchCount = 0;
  const manager = createSubappManager({
    rootDir,
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, text: async () => JSON.stringify(fixtureIndex('0.2.0')) };
    },
  });

  const first = await manager.list({ locale: 'en', refresh: true });
  const second = await manager.list({ locale: 'en', refresh: true });

  assert.equal(fetchCount, 0);
  assert.equal(first.source, 'cache');
  assert.deepEqual(first.apps.map((app) => app.id), ['aily-chat']);
  assert.deepEqual(second.apps.map((app) => app.id), ['aily-chat']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, 'subapp-index.json'), 'utf8')).dev, true);

  fs.writeFileSync(
    path.join(rootDir, 'subapp-index.json'),
    `${JSON.stringify(fixtureIndex(), null, 2)}\n`,
  );
  const refreshed = await manager.list({ locale: 'en', refresh: true });
  assert.equal(fetchCount, 1);
  assert.equal(refreshed.source, 'network');
  assert.equal(refreshed.apps[0].availableVersion, '0.2.0');
});

test('returns the cached catalog without touching the network for cache-first startup', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-cache-first-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'subapp-index.json'),
    `${JSON.stringify(fixtureIndex('0.1.0'), null, 2)}\n`,
  );
  seedInstalledChatPackage(rootDir, '0.1.0');

  let fetchCount = 0;
  const manager = createSubappManager({
    rootDir,
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, text: async () => JSON.stringify(fixtureIndex('0.2.0')) };
    },
  });

  const startup = await manager.list({ locale: 'en', strategy: 'cache-first' });

  assert.equal(fetchCount, 0);
  assert.equal(startup.source, 'cache');
  assert.equal(startup.apps[0].installed, true);
  assert.equal(startup.apps[0].availableVersion, '0.1.0');

  const refreshed = await manager.list({ locale: 'en', strategy: 'network-first' });
  assert.equal(fetchCount, 1);
  assert.equal(refreshed.source, 'network');
  assert.equal(refreshed.apps[0].availableVersion, '0.2.0');
});

test('falls back to the network when cache-first startup has no catalog cache', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-cache-miss-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  let fetchCount = 0;
  const manager = createSubappManager({
    rootDir,
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, text: async () => JSON.stringify(fixtureIndex('0.2.0')) };
    },
  });

  const startup = await manager.list({ locale: 'en', strategy: 'cache-first' });

  assert.equal(fetchCount, 1);
  assert.equal(startup.source, 'network');
  assert.equal(startup.apps[0].availableVersion, '0.2.0');
});

test('switches catalog endpoints when the configured region resource changes', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-region-switch-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  let indexUrl = buildSubappIndexUrl(defaultConfig.regions.cn.resource);
  const requestedUrls = [];
  const manager = createSubappManager({
    rootDir,
    getIndexUrl: () => indexUrl,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return { ok: true, text: async () => JSON.stringify(fixtureIndex()) };
    },
  });

  const cnState = await manager.list({ locale: 'zh_CN', strategy: 'network-first' });
  indexUrl = buildSubappIndexUrl(defaultConfig.regions.eu.resource);
  const globalState = await manager.list({ locale: 'en', strategy: 'network-first' });

  assert.deepEqual(requestedUrls, [
    'https://blockly.yiyu.pro/subapp-index.json',
    'https://rs1.aily.pro/subapp-index.json',
  ]);
  assert.equal(cnState.indexUrl, requestedUrls[0]);
  assert.equal(globalState.indexUrl, requestedUrls[1]);
  assert.equal(manager.indexUrl, requestedUrls[1]);
});

test('does not use a cached catalog from a different configured resource', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-region-cache-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  let indexUrl = buildSubappIndexUrl(defaultConfig.regions.cn.resource);
  let shouldFail = false;
  const manager = createSubappManager({
    rootDir,
    getIndexUrl: () => indexUrl,
    fetchImpl: async () => {
      if (shouldFail) throw new Error('configured endpoint unavailable');
      return { ok: true, text: async () => JSON.stringify(fixtureIndex()) };
    },
  });

  await manager.list({ locale: 'zh_CN', strategy: 'network-first' });
  indexUrl = buildSubappIndexUrl(defaultConfig.regions.eu.resource);
  shouldFail = true;

  await assert.rejects(
    () => manager.list({ locale: 'en', strategy: 'network-first' }),
    /configured endpoint unavailable/,
  );
});

test('discards an in-flight catalog response after the configured resource changes', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-region-race-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const cnUrl = buildSubappIndexUrl(defaultConfig.regions.cn.resource);
  const globalUrl = buildSubappIndexUrl(defaultConfig.regions.eu.resource);
  let indexUrl = cnUrl;
  let releaseCnRequest;
  const cnRequestBlocked = new Promise((resolve) => {
    releaseCnRequest = resolve;
  });
  const manager = createSubappManager({
    rootDir,
    getIndexUrl: () => indexUrl,
    fetchImpl: async (url) => {
      if (url === cnUrl) await cnRequestBlocked;
      return { ok: true, text: async () => JSON.stringify(fixtureIndex()) };
    },
  });

  const staleRequest = manager.list({ locale: 'zh_CN', strategy: 'network-first' });
  indexUrl = globalUrl;
  const currentState = await manager.list({ locale: 'en', strategy: 'network-first' });
  releaseCnRequest();
  const staleRequestResult = await staleRequest;

  assert.equal(currentState.indexUrl, globalUrl);
  assert.equal(staleRequestResult.indexUrl, globalUrl);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(rootDir, 'subapp-index.meta.json'), 'utf8')).indexUrl,
    globalUrl,
  );
});

test('repairs a corrupted cache from the network during cache-first startup', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-corrupt-cache-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rootDir, 'subapp-index.json'), '{broken');

  let fetchCount = 0;
  const manager = createSubappManager({
    rootDir,
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, text: async () => JSON.stringify(fixtureIndex('0.2.0')) };
    },
  });

  const startup = await manager.list({ locale: 'en', strategy: 'cache-first' });

  assert.equal(fetchCount, 1);
  assert.equal(startup.source, 'network');
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, 'subapp-index.json'), 'utf8'))['aily-chat'].version, '0.2.0');
});

test('rejects unsupported catalog load strategies', async () => {
  const manager = createSubappManager({ rootDir: os.tmpdir() });
  await assert.rejects(
    () => manager.list({ locale: 'en', strategy: 'prefer-magic' }),
    /Unsupported subapp catalog load strategy/,
  );
});

test('omits disabled catalog entries from the subapp list', async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-disabled-'));
  const installRoot = path.join(fixtureRoot, 'npm-global', 'app');
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const index = {
    ...fixtureIndex(),
    'ble-debugger': {
      id: 'ble-debugger',
      titleKey: 'BLE_DEBUGGER.TITLE',
      namespace: 'BLE_DEBUGGER',
      app: {
        name: 'BLE_DEBUGGER.TITLE',
        description: 'BLE_DEBUGGER.DESCRIPTION',
        icon: 'fa-light fa-bluetooth',
        enabled: false,
      },
      package: '@aily-project/subapp-ble-debugger',
      version: '0.1.0',
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: { TITLE: 'BLE Debugger', DESCRIPTION: 'BLE tools' },
        },
      },
    },
    'hidden-enable': {
      id: 'hidden-enable',
      titleKey: 'HIDDEN.TITLE',
      namespace: 'HIDDEN',
      app: {
        name: 'HIDDEN.TITLE',
        description: 'HIDDEN.DESCRIPTION',
        enable: false,
      },
      package: '@aily-project/subapp-hidden-enable',
      version: '0.1.0',
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: { TITLE: 'Hidden', DESCRIPTION: 'Hidden by enable flag' },
        },
      },
    },
  };

  assert.equal(validateIndex(index)['ble-debugger'].app.enabled, false);
  assert.equal(validateIndex(index)['hidden-enable'].app.enabled, false);

  const manager = createSubappManager({
    rootDir: installRoot,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(index),
    }),
  });
  const state = await manager.list({ locale: 'en', refresh: true });
  assert.deepEqual(state.apps.map((app) => app.id), ['aily-chat']);
  assert.equal(state.apps[0].ai, true);
  assert.equal(state.apps[0].app.ai, true);
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
        apiServer: 'required',
        startupTimeoutMs: 20000,
        processMessagePort: {
          transport: 'node-ipc-v1',
          maxMessageBytes: 1048576,
        },
        resourceLifecycle: {
          resources: ['serial'],
          suspendMethod: 'runtime.resource.suspend',
          resumeMethod: 'runtime.resource.resume',
          timeoutMs: 150000,
        },
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
  assert.deepEqual(state.apps[0].config.runtime, {
    apiServer: 'required',
    processMessagePort: {
      transport: 'node-ipc-v1',
      maxMessageBytes: 1048576,
    },
    resourceLifecycle: {
      resources: ['serial'],
      suspendMethod: 'runtime.resource.suspend',
      resumeMethod: 'runtime.resource.resume',
      timeoutMs: 150000,
    },
  });
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
      if (args[0] === 'view') {
        return { code: 0, stdout: '', stderr: '' };
      }
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
  const installCall = npmCalls.find((args) => args[0] === 'install');
  assert.ok(installCall, 'expected an npm install call');
  assert.deepEqual(installCall.slice(0, 3), ['install', '--prefix', rootDir]);
  assert.ok(installCall.includes('@aily-project/subapp-aily-chat@0.1.0'));
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
  const updateCall = npmCalls.filter((args) => args[0] === 'install').at(-1);
  assert.ok(updateCall.includes('@aily-project/subapp-aily-chat@0.2.0'));
  assert.equal(updated.apps[0].installedVersion, '0.2.0');
  assert.equal(updated.apps[0].updateAvailable, false);

  const removed = await manager.uninstall({ id: 'aily-chat', locale: 'zh-CN' });
  const uninstallCall = npmCalls.find((args) => args[0] === 'uninstall');
  assert.deepEqual(uninstallCall.slice(0, 3), ['uninstall', '--prefix', rootDir]);
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
      if (args[0] === 'view') {
        return { code: 0, stdout: '', stderr: '' };
      }
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
  assert.ok(npmCalls.some((args) => args[0] === 'install'));
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
    runNpm: async (args) => {
      if (args[0] === 'view') {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: 'up to date', stderr: '' };
    },
  });

  await assert.rejects(
    manager.update({ id: 'aily-chat', locale: 'en' }),
    /update verification failed/,
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version, '0.1.0');
  assert.equal(fs.readFileSync(path.join(packageDir, 'index.js'), 'utf8'), 'old runtime');
});

test('candidate startup failure restores and health-checks the previous package', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-health-rollback-'));
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

  const phases = [];
  const manager = createSubappManager({
    rootDir,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(fixtureIndex('0.1.1')),
    }),
    runNpm: async () => {
      fs.mkdirSync(path.join(packageDir, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'index.js'), 'candidate runtime');
      fs.writeFileSync(path.join(packageDir, 'ui', 'index.html'), '<!doctype html>');
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
        name: '@aily-project/subapp-aily-chat',
        version: '0.1.1',
        main: 'index.js',
      }));
      return { code: 0, stdout: 'changed 1 package', stderr: '' };
    },
    verifyInstalledPackage: async ({ phase, installedState }) => {
      phases.push([phase, installedState.installedVersion]);
      if (phase === 'candidate') throw new Error('candidate failed to start');
    },
  });

  await assert.rejects(
    manager.update({ id: 'aily-chat', locale: 'en' }),
    /candidate failed to start/,
  );
  assert.deepEqual(phases, [
    ['candidate', '0.1.1'],
    ['restored', '0.1.0'],
  ]);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version,
    '0.1.0',
  );
  assert.equal(fs.readFileSync(path.join(packageDir, 'index.js'), 'utf8'), 'old runtime');
});

test('generic startup verifier accepts ready, performs loopback shutdown, and rejects fatal', async (t) => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-health-probe-'));
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@aily-project/health-fixture',
    version: '1.0.0',
    main: 'index.js',
  }));
  fs.writeFileSync(path.join(packageDir, 'index.js'), [
    "const http = require('node:http');",
    "const server = http.createServer((request, response) => {",
    "  if (request.method === 'POST' && request.url === '/shutdown') {",
    "    response.end('ok', () => server.close(() => process.exit(0)));",
    "    return;",
    "  }",
    "  response.statusCode = 404; response.end();",
    "});",
    "server.listen(0, '127.0.0.1', () => {",
    "  const origin = `http://127.0.0.1:${server.address().port}`;",
    "  console.log(JSON.stringify({ event: 'ready', data: { origin, shutdownUrl: `${origin}/shutdown` } }));",
    "});",
  ].join('\n'));

  const verified = await verifyInstalledSubappStartup({
    packagePath: packageDir,
    entry: { package: '@aily-project/health-fixture' },
    phase: 'candidate',
    startupTimeoutMs: 5000,
    shutdownTimeoutMs: 5000,
  });
  assert.deepEqual(verified, {
    status: 'ready',
    phase: 'candidate',
    packageName: '@aily-project/health-fixture',
    packageVersion: '1.0.0',
  });

  fs.writeFileSync(
    path.join(packageDir, 'index.js'),
    "console.log(JSON.stringify({ event: 'fatal', data: { message: 'fixture startup rejected' } }));\n",
  );
  await assert.rejects(
    verifyInstalledSubappStartup({
      packagePath: packageDir,
      entry: { package: '@aily-project/health-fixture' },
      phase: 'candidate',
      startupTimeoutMs: 5000,
      shutdownTimeoutMs: 5000,
    }),
    /fixture startup rejected/,
  );
});

test('health probe only accepts same-origin loopback shutdown URLs', () => {
  assert.equal(
    safeSubappShutdownUrl({
      origin: 'http://127.0.0.1:43100',
      shutdownUrl: 'http://127.0.0.1:43100/shutdown',
    })?.pathname,
    '/shutdown',
  );
  assert.equal(safeSubappShutdownUrl({
    origin: 'http://127.0.0.1:43100',
    shutdownUrl: 'http://example.com/shutdown',
  }), null);
  assert.equal(safeSubappShutdownUrl({
    origin: 'https://127.0.0.1:43100',
    shutdownUrl: 'https://127.0.0.1:43100/shutdown',
  }), null);
});

test('isBusyRenameError detects npm and fs EBUSY rename/rmdir failures', () => {
  assert.equal(
    isBusyRenameError(new Error("npm error EBUSY: resource busy or locked, rename 'a' -> 'b'")),
    true,
  );
  assert.equal(
    isBusyRenameError(Object.assign(
      new Error("EBUSY: resource busy or locked, rmdir 'C:\\\\pkg'"),
      { code: 'EBUSY' },
    )),
    true,
  );
  assert.equal(isBusyRenameError(Object.assign(new Error('locked'), { code: 'EBUSY' })), true);
  assert.equal(
    isBusyRenameError(Object.assign(new Error('operation not permitted, unlink'), { code: 'EPERM' })),
    true,
  );
  assert.equal(isBusyRenameError(new Error('ENOTFOUND registry.npmjs.org')), false);
});

test('renameWithBusyRetry succeeds after a transient Windows EBUSY', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-rename-retry-'));
  const src = path.join(rootDir, 'package');
  const dest = path.join(rootDir, 'moved');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'marker.txt'), 'ok');

  const originalRename = fs.renameSync;
  let attempts = 0;
  const delays = [];
  fs.renameSync = (from, to) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('EBUSY: resource busy or locked, rename');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRename(from, to);
  };

  try {
    await renameWithBusyRetry(src, dest, {
      retries: 2,
      baseDelayMs: 1,
      sleep: async (ms) => { delays.push(ms); },
    });
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1]);
});

test('windows busy rename without forceClose surfaces EBUSY for in-app UI', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-busy-cancel-'));
  const packageDir = seedInstalledChatPackage(rootDir);
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const originalRename = fs.renameSync;
  let forceStopCount = 0;
  fs.renameSync = (from, to) => {
    if (path.resolve(from) === path.resolve(packageDir)) {
      const error = new Error('EBUSY: resource busy or locked, rename');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRename(from, to);
  };

  try {
    const manager = createSubappManager({
      rootDir,
      platform: 'win32',
      renameRetries: 0,
      forceCloseSettleMs: 1,
      sleep: async () => undefined,
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify(fixtureIndex()),
      }),
      runNpm: async () => ({ code: 0, stdout: '', stderr: '' }),
      forceStopChildToolByCatalogId: async () => {
        forceStopCount += 1;
      },
      listBusyHolders: async () => [{ pid: 4242, name: 'node.exe' }],
    });

    await assert.rejects(
      manager.uninstall({ id: 'aily-chat', locale: 'en' }),
      (error) => error?.code === 'EBUSY' && error?.requiresForceClose === true,
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(forceStopCount, 0);
  assert.equal(fs.existsSync(packageDir), true);
});

test('windows busy rename with forceClose kills holders and finishes uninstall', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-busy-force-'));
  const packageDir = seedInstalledChatPackage(rootDir);
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const originalRename = fs.renameSync;
  let packageRenameAttempts = 0;
  const killedPids = [];
  let forceStoppedCatalogId = null;
  fs.renameSync = (from, to) => {
    if (path.resolve(from) === path.resolve(packageDir)) {
      packageRenameAttempts += 1;
      // 首次 rename 在 forceClose 预清理之后才执行；若仍失败则走重试路径
      if (packageRenameAttempts === 1 && forceStoppedCatalogId !== 'aily-chat') {
        const error = new Error('EBUSY: resource busy or locked, rename');
        error.code = 'EBUSY';
        throw error;
      }
    }
    return originalRename(from, to);
  };

  try {
    const manager = createSubappManager({
      rootDir,
      platform: 'win32',
      renameRetries: 0,
      forceCloseSettleMs: 1,
      sleep: async () => undefined,
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify(fixtureIndex()),
      }),
      runNpm: async (args) => {
        assert.equal(args[0], 'uninstall');
        assert.equal(fs.existsSync(packageDir), false);
        return { code: 0, stdout: '', stderr: '' };
      },
      forceStopChildToolByCatalogId: async (catalogId) => {
        forceStoppedCatalogId = catalogId;
      },
      listBusyHolders: async () => [{ pid: 4242, name: 'node.exe' }],
      listChildToolHolders: async () => [{ pid: 4242, name: 'aily-chat-react', toolId: 'aily-chat-react' }],
      killProcessTree: async (pid) => {
        killedPids.push(pid);
        return true;
      },
    });

    const removed = await manager.uninstall({ id: 'aily-chat', locale: 'en', forceClose: true });
    assert.equal(removed.apps[0].installed, false);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(forceStoppedCatalogId, 'aily-chat');
  assert.deepEqual(killedPids, [4242]);
  assert.equal(packageRenameAttempts >= 1, true);
  assert.equal(fs.existsSync(packageDir), false);
});

test('uninstall moves the package aside before npm and retries busy npm rename errors', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-uninstall-busy-'));
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
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({
    name: 'aily-subapps',
    private: true,
    dependencies: { '@aily-project/subapp-aily-chat': '0.1.0' },
  }));

  const npmCalls = [];
  let uninstallAttempts = 0;
  const delays = [];
  const manager = createSubappManager({
    rootDir,
    npmBusyRetries: 2,
    npmBusyRetryDelayMs: 1,
    sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(fixtureIndex()),
    }),
    runNpm: async (args) => {
      npmCalls.push(args);
      assert.equal(args[0], 'uninstall');
      assert.equal(
        fs.existsSync(packageDir),
        false,
        'package must be moved aside before npm uninstall runs',
      );
      uninstallAttempts += 1;
      if (uninstallAttempts === 1) {
        throw new Error(
          "npm error code EBUSY\nnpm error syscall rename\nnpm error EBUSY: resource busy or locked, rename",
        );
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  const removed = await manager.uninstall({ id: 'aily-chat', locale: 'en' });
  assert.equal(uninstallAttempts, 2);
  assert.equal(npmCalls.length, 2);
  assert.deepEqual(delays, [1]);
  assert.equal(removed.apps[0].installed, false);
  assert.equal(fs.existsSync(packageDir), false);
  assert.equal(fs.readdirSync(rootDir).some((name) => name.startsWith('.subapp-uninstall-')), false);
});

test('parseDependencyProgressLog understands download and extract lines', () => {
  assert.deepEqual(parseDependencyProgressLog('下载进度: 42'), { phase: 'download', percent: 42 });
  assert.deepEqual(parseDependencyProgressLog('Download progress: 88.6'), { phase: 'download', percent: 88.6 });
  assert.deepEqual(parseDependencyProgressLog('下载完成'), { phase: 'download', percent: 100 });
  assert.deepEqual(parseDependencyProgressLog('解压进度: 70'), { phase: 'extract', percent: 70 });
  assert.equal(parseDependencyProgressLog('npm http fetch GET 200'), null);
  assert.equal(clampProgress(120.4), 100);
});

test('mutation progress tracker weights download and extract like board deps', () => {
  const events = [];
  const tracker = createMutationProgressTracker({
    id: 'aily-chat',
    action: 'install',
    onProgress: (event) => events.push(event),
  });

  assert.equal(tracker.start(), 1);
  assert.equal(tracker.setDownload(50), 25);
  assert.equal(tracker.handleLog('解压进度: 50'), 75);
  assert.equal(tracker.complete(), 100);
  assert.equal(events.at(-1).phase, 'complete');
  assert.equal(events.at(-1).percent, 100);
});

test('install reports real download progress when tarball download succeeds', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-progress-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const events = [];
  const npmCalls = [];
  const manager = createSubappManager({
    rootDir,
    onProgress: (event) => events.push({ ...event }),
    resolveTarballUrl: async () => 'https://example.test/subapp.tgz',
    downloadFile: async (_url, destination, onProgress) => {
      onProgress?.(20);
      onProgress?.(60);
      onProgress?.(100);
      fs.writeFileSync(destination, 'tarball');
    },
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(fixtureIndex()),
    }),
    runNpm: async (args) => {
      npmCalls.push(args);
      assert.equal(args[0], 'install');
      assert.ok(String(args.at(-1)).endsWith('package.tgz'));
      const packageDir = path.join(rootDir, 'node_modules', '@aily-project', 'subapp-aily-chat');
      fs.mkdirSync(path.join(packageDir, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'index.js'), '');
      fs.writeFileSync(path.join(packageDir, 'ui', 'index.html'), '<!doctype html>');
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
        name: '@aily-project/subapp-aily-chat',
        version: '0.1.0',
        main: 'index.js',
      }));
      return { code: 0, stdout: '解压进度: 100\n', stderr: '' };
    },
  });

  const after = await manager.install({ id: 'aily-chat', locale: 'en' });
  assert.equal(after.apps[0].installed, true);
  assert.equal(npmCalls.length, 1);
  assert.ok(events.some((event) => event.phase === 'download' && event.percent === 30));
  assert.ok(events.some((event) => event.phase === 'download' && event.percent === 50));
  assert.equal(events.at(-1).phase, 'complete');
  assert.equal(events.at(-1).percent, 100);
});

test('rejects dist-relative subapp entries and prefers nested portable roots', () => {
  assert.equal(isDistRelativePath('dist/aily-chat/server/index.js'), true);
  assert.equal(isDistRelativePath('server/index.js'), false);

  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-dist-source-'));
  try {
    const nestedRoot = path.join(sourceRoot, 'dist', 'aily-chat');
    fs.mkdirSync(path.join(nestedRoot, 'server'), { recursive: true });
    fs.mkdirSync(path.join(nestedRoot, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(nestedRoot, 'server', 'index.js'), '');
    fs.writeFileSync(path.join(nestedRoot, 'ui', 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(nestedRoot, 'package.json'), JSON.stringify({
      name: '@aily-project/subapp-aily-chat',
      version: '0.1.6',
      main: 'server/index.js',
    }));
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'aily-chat',
      version: '0.1.6',
      main: 'dist/aily-chat/server/index.js',
      aily: { uiIndex: 'dist/aily-chat/ui/index.html' },
    }));

    assert.equal(
      resolveUiIndex(sourceRoot, JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'))),
      path.join('ui', 'index.html'),
    );

    const runnable = resolveRunnablePackage(
      sourceRoot,
      'aily-chat',
      JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')),
    );
    assert.equal(runnable.packagePath, nestedRoot);
    assert.equal(runnable.mainEntry, 'server/index.js');
    assert.equal(runnable.uiIndex, path.join('ui', 'index.html'));
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('marks source packages with only dist entries as not installed', async (t) => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-dist-reject-'));
  t.after(() => fs.rmSync(installRoot, { recursive: true, force: true }));

  const packageDir = path.join(installRoot, 'node_modules', '@aily-project', 'subapp-aily-chat');
  fs.mkdirSync(path.join(packageDir, 'dist', 'aily-chat', 'server'), { recursive: true });
  fs.mkdirSync(path.join(packageDir, 'dist', 'aily-chat', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'dist', 'aily-chat', 'server', 'index.js'), '');
  fs.writeFileSync(path.join(packageDir, 'dist', 'aily-chat', 'ui', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@aily-project/subapp-aily-chat',
    version: '0.1.6',
    main: 'dist/aily-chat/server/index.js',
  }));

  const manager = createSubappManager({
    rootDir: installRoot,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(fixtureIndex('0.1.6')),
    }),
  });
  const state = await manager.list({ refresh: true, locale: 'en' });
  assert.equal(state.apps[0].installed, false);
  assert.match(String(state.apps[0].installError || ''), /package-root/);
});
