const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCloudProjectOpen, createCloudProjectOpenQueue } = require('../../electron/cloud-project-protocol');
const id = 'b27dffb8-6d46-4c39-864c-d16f8b9d483a';

test('both products accept only their own credential-free cloud project open protocol', () => {
  for (const [product, scheme] of [['blockly', 'abis'], ['coder', 'acis']]) {
    assert.deepEqual(parseCloudProjectOpen(`${scheme}://project/open?cloudProject=${id}`, product), { cloudProject: id });
    assert.deepEqual(parseCloudProjectOpen(`${scheme}://project/open?cloudProject=${id}&apiOrigin=${encodeURIComponent('https://API.example:443/')}`, product),
      { cloudProject: id, apiOrigin: 'https://api.example' });
    assert.equal(parseCloudProjectOpen(`${scheme}://project/open?cloudProject=${id}&token=secret`, product), null);
    assert.equal(parseCloudProjectOpen(`${scheme}://project/open?cloudProject=${id}&cloudProject=42`, product), null);
    assert.equal(parseCloudProjectOpen(`${scheme}://project/open?cloudProject=../../escape`, product), null);
    assert.equal(parseCloudProjectOpen(`${scheme}://project/open?cloudProject=${id}#fragment`, product), null);
    assert.equal(parseCloudProjectOpen(`${scheme}://project/import?cloudProject=${id}`, product), null);
    assert.equal(parseCloudProjectOpen(`${scheme}://project/open?cloudProject=${id}`, product === 'coder' ? 'blockly' : 'coder'), null);
    for (const hint of ['https://user:pass@api.example', 'https://api.example/path', 'https://api.example/../', 'https://api.example\\', 'https://api.example?token=x', 'https://api.example#part', 'file:///etc', '']) {
      assert.equal(parseCloudProjectOpen(`${scheme}://project/open?cloudProject=${id}&apiOrigin=${encodeURIComponent(hint)}`, product), null);
    }
    assert.equal(parseCloudProjectOpen(`${scheme}://project/open?cloudProject=${id}&apiOrigin=https://a.example&apiOrigin=https://b.example`, product), null);
  }
  assert.deepEqual(parseCloudProjectOpen('abis://project/open?cloudProject=123456', 'blockly'), { cloudProject: '123456' });
});

test('cold starts retain and deduplicate requests until renderer-ready; hot starts deliver immediately', () => {
  let ready = false;
  const received = [];
  const queue = createCloudProjectOpenQueue(() => ready, request => received.push(request));
  queue.receive(`abis://project/open?cloudProject=${id}`, 'blockly');
  queue.receive(`abis://project/open?cloudProject=${id}`, 'blockly');
  queue.flush();
  assert.deepEqual(received, []);
  ready = true;
  queue.flush();
  queue.flush();
  assert.deepEqual(received, [{ cloudProject: id }]);
  queue.receive('abis://project/open?cloudProject=42', 'blockly');
  assert.deepEqual(received, [{ cloudProject: id }, { cloudProject: '42' }]);
});
