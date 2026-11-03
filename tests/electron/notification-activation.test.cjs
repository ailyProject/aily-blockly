const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createActivationServer, createWindowsToastXml, forwardNotificationActivation, parseActivationUrl, isNotificationActivationUrl } = require('../../electron/notification-activation');

test('product protocols reject cross-product, malformed and arbitrary forwarding targets', () => {
  const route = `acis://notification/${randomUUID()}/${randomUUID()}`;
  assert.equal(isNotificationActivationUrl(route, 'coder'), true);
  assert.equal(isNotificationActivationUrl(route, 'blockly'), false);
  assert.ok(parseActivationUrl(route, 'coder').notificationId);
  for (const bad of [route + '?pipe=evil', route + '#bad', route.replace('notification/', 'user@notification/'), 'acis://notification/../file', route + '/extra']) {
    assert.throws(() => parseActivationUrl(bad, 'coder'));
  }
});

test('real local transport delivers only the addressed notification and rejects stale owners', async () => {
  const directory = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'aily-notify-'));
  const options = directory ? { makePipePath: (_product, id) => path.join(directory, id + '.sock') } : {};
  const id = randomUUID(), seen = [];
  const server = createActivationServer({ product: 'coder', onActivate(value) { seen.push(value); return value === id; }, ...options });
  try {
    await server.ready;
    await forwardNotificationActivation(server.url(id), 'coder', options);
    assert.deepEqual(seen, [id]);
    await assert.rejects(forwardNotificationActivation(server.url(randomUUID()), 'coder', options), /no longer active/);
    await assert.rejects(forwardNotificationActivation(server.url(id), 'blockly', options), /protocol/);
  } finally {
    server.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Windows XML escapes content and preserves reminder, silent and icon options', () => {
  const xml = createWindowsToastXml({ title: '<build>&"', body: "it's done", silent: true, timeoutType: 'never', icon: path.resolve('a&b.png') }, 'acis://notification/a/b');
  assert.match(xml, /activationType="protocol" launch="acis:\/\/notification\/a\/b"/);
  assert.match(xml, /&lt;build&gt;&amp;&quot;/);
  assert.match(xml, /it&apos;s done/);
  assert.match(xml, /scenario="reminder"/);
  assert.match(xml, /audio silent="true"/);
  assert.match(xml, /appLogoOverride/);
  assert.match(xml, /activationType="system"/);
  assert.doesNotMatch(createWindowsToastXml({ title: 'default', body: '' }, 'abis://notification/a/b'), /scenario=|<actions>|<audio/);
});
