const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('js-yaml');

const script = path.join(__dirname, 'refresh-macos-dmg-manifest.cjs');
const sha512 = bytes => createHash('sha512').update(bytes).digest('base64');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-dmg-manifest-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = [
    'aily-blockly-CN-macos-0.9.104-arm64.zip',
    'aily-blockly-CN-macos-0.9.104-arm64.dmg',
    'aily-blockly-CN-macos-0.9.104-x64.dmg',
  ].map(url => {
    const bytes = Buffer.from(`signed ${url}`);
    fs.writeFileSync(path.join(directory, url), bytes);
    return { url, sha512: sha512(bytes), size: bytes.length, blockMapSize: 123 };
  });
  const manifest = {
    version: '0.9.104', files,
    path: files[0].url, sha512: files[0].sha512,
    releaseDate: '2026-10-02T15:52:51.666Z',
    minimumSystemVersion: '12.0.0',
  };
  const manifestPath = path.join(directory, 'latest-mac.yml');
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
  const run = () => spawnSync(process.execPath, [script, manifestPath], {
    cwd: directory, encoding: 'utf8', timeout: 10000,
  });
  return { directory, manifest, manifestPath, run };
}

test('refreshes final stapled DMG hashes and sizes without changing ZIP or other manifest metadata', t => {
  const { directory, manifest, manifestPath, run } = fixture(t);
  const expected = structuredClone(manifest);
  for (const file of expected.files.filter(file => file.url.endsWith('.dmg'))) {
    const filePath = path.join(directory, file.url);
    fs.appendFileSync(filePath, '\nApple notarization ticket');
    const finalBytes = fs.readFileSync(filePath);
    file.sha512 = sha512(finalBytes);
    file.size = finalBytes.length;
  }
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const text = fs.readFileSync(manifestPath, 'utf8');
  assert.deepEqual(yaml.load(text), expected);
  assert.deepEqual([...text.matchAll(/^[ \t]*sha512:[ \t]*(.+)$/gm)].map(match => match[1].trim()),
    [...expected.files.map(file => file.sha512), expected.sha512]);
});

test('missing or empty DMGs fail without partially changing the manifest', t => {
  for (const condition of ['missing', 'empty']) {
    const { directory, manifest, manifestPath, run } = fixture(t);
    const original = fs.readFileSync(manifestPath, 'utf8');
    fs.appendFileSync(path.join(directory, manifest.files[1].url), '\nApple notarization ticket');
    const invalidDmg = path.join(directory, manifest.files[2].url);
    if (condition === 'missing') fs.unlinkSync(invalidDmg);
    else fs.writeFileSync(invalidDmg, '');
    const result = run();
    assert.notEqual(result.status, 0, `${condition} DMG must fail`);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), original, condition);
  }
});
