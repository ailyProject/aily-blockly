'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createNpmMutationQueue } = require('../../electron/npm-mutation-queue');
const { npmIpcFixture } = require('./fixtures/npm-ipc-fixture.cjs');

const main = fs.readFileSync(path.join(__dirname, '../../electron/main.js'), 'utf8');
function slice(start, end, from = 0) {
  const first = main.indexOf(start, from), last = main.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing main startup boundary: ${start}`);
  return main.slice(first, last);
}
function startup(region, overrides = {}) {
  const conf = { ...structuredClone(require('../../electron/config/config.json')), ...overrides };
  const context = vm.createContext({
    conf, buildProduct: 'blockly',
    process: { env: { AILY_BUILD_FLAVOR: region === 'eu' ? 'global' : 'cn' } },
    getPackagedMetadata: () => null,
  });
  vm.runInContext(slice("const DEFAULT_BUILD_FLAVOR = 'cn';", 'let rendererGeneration ='), context);
  vm.runInContext(slice('  const buildFlavor = getBuildFlavor(conf);', '  // npm registry',
    main.indexOf('  // TODO 下一版本删除，强制将 cn 区域')), context);
  vm.runInContext(slice('  // zip包下载镜像地址', '  // API服务器地址'), context);
  return context.process.env;
}
const urls = env => JSON.parse(env.AILY_ZIP_URLS);
const cn = 'https://blockly.yiyu.pro', eu = 'https://rs1.aily.pro';

for (const [region, expected] of [['cn', [cn, eu]], ['eu', [eu, cn]]]) {
  test(`${region} startup uses the corrected region for both ZIP environment values`, () => {
    const env = startup(region, { region: region === 'cn' ? 'eu' : 'cn' });
    assert.equal(env.AILY_REGION, region);
    assert.deepEqual(urls(env), expected);
    assert.equal(env.AILY_ZIP_URL, expected[0]);
    assert.ok(urls(env).every(url => !url.includes('localhost')));
  });
}

test('ZIP startup reads new overrides and falls back per missing or invalid regional entry', () => {
  assert.deepEqual(urls(startup('cn', { download_region_order: { cn: ['eu', 'cn'] } })), [eu, cn]);
  assert.deepEqual(urls(startup('eu', { download_region_order: { cn: ['cn', 'eu'] } })), [eu, cn]);
  assert.deepEqual(urls(startup('cn', { download_region_order: { cn: [] } })), [cn, eu]);
});

test('manual sources and legacy automatic fallback retain their existing scope', () => {
  assert.deepEqual(urls(startup('cn', { resource_source: 'primary' })), [eu]);
  assert.deepEqual(urls(startup('cn', { resource_sources: [] })), [cn, eu]);
  const conf = structuredClone(require('../../electron/config/config.json'));
  conf.resource_sources = [
    { key: 'custom', url: 'https://custom.example/resources/' },
    { key: 'disabled-cn', url: cn, enabled: false },
    { key: 'renamed-eu', url: eu + '/' },
    { key: 'duplicate-eu', url: eu },
  ];
  assert.deepEqual(urls(startup('cn', conf)), [eu, 'https://custom.example/resources']);
});

test('both installation IPC paths inherit the current ZIP order at spawn time', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily zip source ')));
  const saved = Object.fromEntries(['AILY_ZIP_URL', 'AILY_ZIP_URLS'].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.ok(root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = npmIpcFixture({ acquireNpmMutation: createNpmMutationQueue({ tryAcquire: () => () => {} }) });
  const pending = [];
  try {
    for (const region of ['cn', 'eu']) {
      const env = startup(region);
      Object.assign(process.env, { AILY_ZIP_URL: env.AILY_ZIP_URL, AILY_ZIP_URLS: env.AILY_ZIP_URLS });
      pending.push(f.runNpm({ cmd: `npm install compiler-fixture --prefix "${path.join(root, region + '-npm')}"` }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.runCmd({ command: 'npm', args: ['install', 'sdk-fixture', '--prefix', path.join(root, region + '-cmd')],
        streamId: 'zip-' + region })).success, true);
      for (const child of f.children.slice(-2)) {
        assert.deepEqual(child.zipEnvironment, { AILY_ZIP_URL: env.AILY_ZIP_URL, AILY_ZIP_URLS: env.AILY_ZIP_URLS });
      }
    }
    assert.equal(f.children.length, 4);
    assert.deepEqual(JSON.parse(f.children[0].zipEnvironment.AILY_ZIP_URLS), [cn, eu]);
    assert.deepEqual(JSON.parse(f.children[1].zipEnvironment.AILY_ZIP_URLS), [cn, eu]);
  } finally {
    for (const child of f.children) child.emit('close', 0, null);
    await Promise.allSettled(pending);
  }
});
