import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: [new URL('../src/app/services/integrations/subapps/host-provider/subapp-host-provider-dispatcher.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { SubappHostProviderDispatcher, SUBAPP_HOST_PROVIDER_MESSAGE_TYPES: types } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const snapshot = process.env.AILY_NETWORK_TEST_PROTOCOL_ROOT;
const { createSimulatorNetworkHostProviderAdapter } = snapshot
  ? await import(pathToFileURL(snapshot + '/packages/simulator-embed-host/dist/index.js'))
  : await import('@aily-project/simulator-host-sdk');

test('normal network offer is an inert Host capability and remains discoverable before a Core session is running', async () => {
  let requests = 0, closes = 0, receive;
  const adapter = createSimulatorNetworkHostProviderAdapter({
    async request() { requests++; throw Error('Negotiation must not query Core or request a grant'); },
    async close() { closes++; },
  });
  const dispatcher = new SubappHostProviderDispatcher({ hostInstanceId: 'simulator-host:workspace:1', adapters: [adapter] });
  const messages = [];
  dispatcher.bindTransport({ onMessage(listener) { receive = listener; return () => {}; }, async send(message) { messages.push(message); } });
  receive({ type: types.negotiationRequest, version: 1, request: { schemaVersion: 1, kind: 'fixture-negotiation', requestId: 'discover-before-core',
    providers: [{ provider: 'network', protocolVersions: [1], requiredCapabilities: ['network.ip'], optionalCapabilities: [] }] } });
  await new Promise(resolve => setImmediate(resolve));
  const message = messages.find(value => value.type === types.catalog);
  assert.equal(message.catalog.hostInstanceId, 'simulator-host:workspace:1');
  assert.deepEqual(message.catalog.providers, [{ provider: 'network', protocolVersions: [1], capabilities: ['network.ip'] }]);
  assert.equal(requests, 0); assert.equal(closes, 0);
  await dispatcher.close(); assert.equal(closes, 1);
});
