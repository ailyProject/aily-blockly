import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { build } from 'esbuild';

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const module = await loadRegistryModule();
const { SubappHostProviderProductRegistryService } = module;

test('unregistered Child Tool keeps its existing lifecycle', async () => {
  const registry = new SubappHostProviderProductRegistryService();
  const result = await registry.open(context('plain-subapp'));
  assert.equal(result, null);
});

test('registered product opens and closes one bounded Provider session', async () => {
  const registry = new SubappHostProviderProductRegistryService();
  const calls = [];
  const unregister = registry.register('simulator', {
    open(input) {
      calls.push(['open', input.toolId, input.hostInstanceId]);
      return {
        close() {
          calls.push(['close']);
        },
      };
    },
  });
  const session = await registry.open(context('simulator'));
  await session.close();
  unregister();
  assert.equal(await registry.open(context('simulator')), null);
  assert.deepEqual(calls, [
    ['open', 'simulator', 'host-fixture-1'],
    ['close'],
  ]);
});

test('duplicate registration and malformed sessions fail closed', async () => {
  const registry = new SubappHostProviderProductRegistryService();
  registry.register('simulator', { open: () => ({ close() {} }) });
  assert.throws(
    () => registry.register('simulator', { open: () => ({ close() {} }) }),
    /already registered/u,
  );
  const invalid = new SubappHostProviderProductRegistryService();
  invalid.register('simulator', { open: () => ({}) });
  await assert.rejects(
    invalid.open(context('simulator')),
    /invalid session/u,
  );
});

function context(toolId) {
  return {
    toolId,
    hostInstanceId: 'host-fixture-1',
    transport: {
      send() {},
      onMessage() {
        return () => undefined;
      },
    },
  };
}

async function loadRegistryModule() {
  const result = await build({
    entryPoints: [path.join(
      workspaceRoot,
      'src/app/services/integrations/subapps/host-provider/subapp-host-provider-product-registry.service.ts',
    )],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'silent',
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  );
}
