const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const names = ['latest.yml', 'latest-cn.yml', 'latest-mac.yml', 'latest-mac-cn.yml'];
const version = '0.9.104';
const bytes = release => Buffer.from(`version: ${release}\nfiles: []\n`);
const missing = code => Object.assign(new Error('Do not disclose command or credentials'), {
  stderr: `An error occurred (${code}) when calling the GetObject operation: unavailable`,
});

function fixture(t, prefix = 'blockly') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockly-feed-test-'));
  const directory = path.join(root, 'manifests');
  const runnerTemp = path.join(root, 'runner');
  t.after(() => {
    try {
      assert.deepEqual(fs.readdirSync(runnerTemp), [], 'guard must clean its own temporary downloads');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  fs.mkdirSync(directory);
  fs.mkdirSync(runnerTemp);
  for (const name of names) fs.writeFileSync(path.join(directory, name), bytes(version));
  const remote = new Map(names.map(name => [name, bytes('0.9.103')]));
  const calls = [];
  const fakeProcess = { env: { R2_ACCOUNT_ID: 'test-account', R2_BUCKET_NAME: 'test-bucket', R2_UPLOAD_PATH: prefix, RUNNER_TEMP: runnerTemp } };
  const exported = { exports: {} };
  const fakeRequire = name => name === 'node:child_process' ? {
    execFileSync(command, args, options) {
      calls.push({ command, args, options });
      const downloaded = args.at(-1);
      assert.equal(path.dirname(path.dirname(downloaded)), runnerTemp);
      const content = remote.get(path.basename(downloaded));
      if (content instanceof Error) throw content;
      fs.writeFileSync(downloaded, content);
      return Buffer.from('{}');
    },
  } : require(name);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'blockly-feed-guard.cjs'), 'utf8'), {
    require: fakeRequire, module: exported, process: fakeProcess, console,
  });
  const run = input => exported.exports.guardBlocklyFeed(directory, input === undefined ? version : input);
  return { directory, remote, calls, run };
}

test('bootstrap, normal upgrades and identical partial uploads check all four objects', t => {
  for (const mode of ['bootstrap', 'upgrade', 'partial']) {
    const fixtureData = fixture(t);
    for (const [index, name] of names.entries()) {
      if (mode === 'bootstrap') fixtureData.remote.set(name, missing(index % 2 ? '404' : 'NoSuchKey'));
      if (mode === 'partial' && index % 2 === 0) fixtureData.remote.set(name, bytes(version));
    }
    fixtureData.run();
    assert.equal(fixtureData.calls.length, 4);
    assert.ok(fixtureData.calls.every(call => call.command === 'aws' && call.args[0] === 's3api' && call.args[1] === 'get-object'));
  }
});

test('preserves the existing upload object keys for empty and slash-bearing prefixes', t => {
  for (const prefix of ['', 'blockly', '/blockly/', 'blockly//']) {
    const { run, calls } = fixture(t, prefix);
    run();
    assert.deepEqual(calls.map(call => call.args[call.args.indexOf('--key') + 1]), names.map(name => `${prefix}/${name}`));
    assert.ok(calls.every(call => call.args.includes('https://test-account.r2.cloudflarestorage.com')));
  }
});

test('rejects different bytes for the same version and a newer version in any of the four feeds', t => {
  const same = fixture(t);
  same.remote.set(names[0], Buffer.from(`version: ${version}\nfiles: []\n# changed\n`));
  assert.throws(same.run, /different bytes/);
  for (const name of names) {
    const newer = fixture(t);
    newer.remote.set(name, bytes('0.9.105'));
    assert.throws(newer.run, /rollback/);
  }
});

test('permission, network, ambiguous 404 and malformed remote metadata fail without disclosing AWS diagnostics', t => {
  for (const error of [missing('AccessDenied'), missing('NoSuchBucket'), new Error('HTTP 404 from unknown gateway')]) {
    const current = fixture(t);
    current.remote.set(names[0], error);
    assert.throws(current.run, failure => /Cannot read current R2 manifest/.test(failure.message) && !/credentials|gateway|command/.test(failure.message));
  }
  for (const content of ['', 'version: nope\n', 'version: [', 'files: []\n']) {
    const current = fixture(t);
    current.remote.set(names[0], Buffer.from(content));
    assert.throws(current.run, /Invalid manifest/);
  }
});

test('invalid release versions, missing local files and local version mismatches fail before any R2 read', t => {
  const invalid = fixture(t);
  assert.throws(() => invalid.run('v0.9.104'), /SemVer/);
  assert.equal(invalid.calls.length, 0);
  for (const content of [null, '', 'version: 0.9.103\n', 'version: [']) {
    const current = fixture(t);
    const last = path.join(current.directory, names.at(-1));
    if (content === null) fs.unlinkSync(last);
    else fs.writeFileSync(last, content);
    assert.throws(current.run);
    assert.equal(current.calls.length, 0);
  }
});
