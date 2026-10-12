const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('js-yaml');
const { releaseFiles } = require('./coder-release-manifest.cjs');
const { verifyPublishedRelease } = require('./verify-coder-release.cjs');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-public-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const version = '0.1.7';
  const names = [];
  const cnFiles = new Map();
  for (const platform of ['windows', 'macos']) {
    for (const flavor of ['cn', 'global']) {
      const release = releaseFiles(platform, flavor, version);
      const files = release.packages.map(name => {
        const content = Buffer.from(`signed ${name}`);
        fs.writeFileSync(path.join(directory, name), content);
        names.push(name);
        if (flavor === 'cn') cnFiles.set(name, name);
        return { url: name, size: content.length, sha512: crypto.createHash('sha512').update(content).digest('base64') };
      });
      fs.writeFileSync(path.join(directory, release.manifest), yaml.dump({ version, files, path: files[0].url, sha512: files[0].sha512 }));
      names.push(release.manifest);
      if (flavor === 'cn') cnFiles.set(releaseFiles(platform, 'global', version).manifest, release.manifest);
    }
  }
  for (const name of ['CHANGELOG_CODER.md', 'CHANGELOG_CODER_ZH.md']) {
    fs.writeFileSync(path.join(directory, name), `## ${version}\nRelease notes for ${name}\n`);
    names.push(name);
    cnFiles.set(name, name);
  }
  const requests = [];
  const failure = { mode: '', name: names[0] };
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, cacheControl: request.headers['cache-control'] });
    const name = path.posix.basename(request.url);
    const isCn = request.url.startsWith('/cn/');
    const localName = isCn ? cnFiles.get(name) : name;
    if (!localName || !names.includes(localName)) return response.writeHead(404).end();
    if (isCn && name === failure.name) {
      if (failure.mode === 'missing') return response.writeHead(404).end();
      if (failure.mode === 'interrupted') {
        response.writeHead(200, { 'Content-Length': 1000 });
        response.write('partial');
        return setImmediate(() => response.destroy());
      }
      if (failure.mode === 'changed') {
        const content = fs.readFileSync(path.join(directory, localName));
        content[0] ^= 1;
        return response.end(content);
      }
      if (failure.mode === 'global-manifest') return response.end(fs.readFileSync(path.join(directory, name)));
    }
    fs.createReadStream(path.join(directory, localName)).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { directory, version, names, cnFiles, requests, failure, baseUrls: [`${base}/global/blockly/`, `${base}/cn/blockly`] };
}

test('checks all 12 Global files and only CN payloads, manifest aliases and logs on the CN source', async t => {
  const { directory, version, names, cnFiles, requests, baseUrls } = await fixture(t);
  await verifyPublishedRelease(directory, version, baseUrls);
  assert.equal(names.length, 12);
  assert.equal(cnFiles.size, 7);
  assert.equal(requests.length, 19);
  assert.deepEqual(requests.map(request => request.url).sort(), [
    ...names.map(name => `/global/blockly/${name}`),
    ...[...cnFiles.keys()].map(name => `/cn/blockly/${name}`),
  ].sort());
  assert.equal(cnFiles.get('latest-coder.yml'), 'latest-coder-cn.yml');
  assert.equal(cnFiles.get('latest-coder-mac.yml'), 'latest-coder-mac-cn.yml');
  assert.ok([...cnFiles.keys()].filter(name => /\.(exe|dmg|zip)$/.test(name)).every(name => name.startsWith('aily-coder-CN-')));
  assert.ok(requests.every(request => request.cacheControl === 'no-cache'));
});

test('missing, corrupt, wrong-flavor or interrupted CN files fail after the Global source succeeds', async t => {
  const fixtureData = await fixture(t);
  for (const [mode, name] of [
    ['missing', 'CHANGELOG_CODER.md'],
    ['changed', 'latest-coder-mac.yml'],
    ['global-manifest', 'latest-coder.yml'],
    ['interrupted', fixtureData.names[0]],
  ]) {
    Object.assign(fixtureData.failure, { mode, name });
    await assert.rejects(verifyPublishedRelease(fixtureData.directory, fixtureData.version, fixtureData.baseUrls));
  }
});

test('invalid local artifacts fail before any public request and the CLI exits nonzero', async t => {
  const { directory, version, names, requests, baseUrls } = await fixture(t);
  fs.appendFileSync(path.join(directory, names[0]), 'changed after manifest generation');
  await assert.rejects(verifyPublishedRelease(directory, version, baseUrls), /mismatch/);
  assert.equal(requests.length, 0);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'verify-coder-release.cjs'), directory, version], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mismatch/);
  assert.doesNotMatch(result.stdout, /Verified all/);
});
