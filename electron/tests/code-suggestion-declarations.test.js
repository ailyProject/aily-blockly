const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readCodeDeclaration } = require('../code-suggestion-declarations');

test('SDK declaration reader limits installed roots, symlinks, type, size and version', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-tab-sdk-'));
  try {
    const sdk = path.join(dir, 'installed-sdk'); await fs.mkdir(sdk);
    const header = path.join(sdk, 'Sensor.h'); await fs.writeFile(header, 'struct Sensor {};\n');
    const roots = [{ id: 'sensor-sdk', version: '1', absolutePath: sdk }];
    const result = await readCodeDeclaration(header, roots);
    assert.equal(result.relativePath, '@sdk/sensor-sdk/Sensor.h');
    assert.equal(result.text, 'struct Sensor {};\n');
    assert.equal(await readCodeDeclaration(header, []), null);
    assert.notEqual((await readCodeDeclaration(header, [{ ...roots[0], version: '2' }])).snapshotId, result.snapshotId);
    const outsideDir = path.join(dir, 'outside'); await fs.mkdir(outsideDir);
    const outside = path.join(outsideDir, 'private.h'); await fs.writeFile(outside, 'private');
    // Directory junctions exercise realpath escapes without Windows symlink privileges.
    await fs.symlink(outsideDir, path.join(sdk, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await readCodeDeclaration(path.join(sdk, 'escape', 'private.h'), roots), null);
    assert.equal(await readCodeDeclaration(outside, roots), null);
    await fs.writeFile(path.join(sdk, 'data.json'), '{}');
    assert.equal(await readCodeDeclaration(path.join(sdk, 'data.json'), roots), null);
    await fs.writeFile(header, 'x'.repeat(300001)); assert.equal(await readCodeDeclaration(header, roots), null);
    await fs.writeFile(header, '\0binary'); assert.equal(await readCodeDeclaration(header, roots), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
