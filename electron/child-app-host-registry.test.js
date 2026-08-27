const assert = require('node:assert/strict');
const test = require('node:test');
const esbuild = require('esbuild');

const registryModulePromise = loadRegistryModule();

test('child app host registry keeps primary and compact instances independently', async () => {
  const { ChildAppHostRegistryService } = await registryModulePromise;
  const originalWindow = global.window;
  global.window = {};
  const registry = new ChildAppHostRegistryService();
  const calls = [];
  const primary = createController('primary', calls);
  const compact = createController('compact', calls);

  try {
    const unregisterPrimary = registry.register('fixture', primary, {
      instanceId: 'full-1',
      surface: 'default',
      primary: true,
    });
    const unregisterCompact = registry.register('fixture', compact, {
      instanceId: 'dock-1',
      surface: 'compact',
      primary: false,
    });

    assert.equal(registry.has('fixture'), true);
    assert.equal(registry.has('fixture', 'full-1'), true);
    assert.equal(registry.has('fixture', 'dock-1'), true);
    assert.equal(registry.list('fixture').length, 2);

    const defaultStatus = await registry.control('fixture', 'status');
    assert.equal(defaultStatus.instanceId, 'full-1');
    assert.equal(defaultStatus.owner, 'primary');

    const compactStatus = await registry.control('fixture', 'status', { instanceId: 'dock-1' });
    assert.equal(compactStatus.instanceId, 'dock-1');
    assert.equal(compactStatus.surface, 'compact');
    assert.equal(compactStatus.owner, 'compact');

    await registry.control('fixture', 'close');
    await registry.control('fixture', 'close', { instanceId: 'dock-1' });
    assert.deepEqual(calls, ['primary:close', 'compact:close']);

    unregisterCompact();
    assert.equal(registry.has('fixture', 'dock-1'), false);
    assert.equal(registry.has('fixture', 'full-1'), true);
    unregisterPrimary();
    assert.equal(registry.has('fixture'), false);
  } finally {
    global.window = originalWindow;
  }
});

test('stale unregister does not remove a replacement instance', async () => {
  const { ChildAppHostRegistryService } = await registryModulePromise;
  const originalWindow = global.window;
  global.window = {};
  const registry = new ChildAppHostRegistryService();

  try {
    const unregisterOld = registry.register('fixture', createController('old', []), {
      instanceId: 'dock-1',
      surface: 'compact',
    });
    registry.register('fixture', createController('replacement', []), {
      instanceId: 'dock-1',
      surface: 'compact',
    });

    unregisterOld();
    assert.equal(registry.getStatus('fixture', 'dock-1').owner, 'replacement');
  } finally {
    global.window = originalWindow;
  }
});

function createController(owner, calls) {
  return {
    status: () => ({ owner }),
    restart: async () => ({ ok: true, owner, action: 'restart' }),
    close: async () => {
      calls.push(`${owner}:close`);
      return { ok: true, owner, action: 'close' };
    },
    detach: async () => ({ ok: true, owner, action: 'detach' }),
    embed: async () => ({ ok: true, owner, action: 'embed' }),
  };
}

async function loadRegistryModule() {
  const result = await esbuild.build({
    stdin: {
      contents: "export { ChildAppHostRegistryService } from './src/app/services/child-app-host-registry.service.ts';",
      resolveDir: process.cwd(),
      sourcefile: 'child-app-host-registry-test-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [{
      name: 'angular-core-stub',
      setup(build) {
        build.onResolve({ filter: /^@angular\/core$/ }, () => ({
          path: 'angular-core',
          namespace: 'stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export function Injectable() { return target => target; }',
          loader: 'js',
        }));
      },
    }],
  });
  const moduleRecord = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    require,
    moduleRecord,
    moduleRecord.exports,
  );
  return moduleRecord.exports;
}
