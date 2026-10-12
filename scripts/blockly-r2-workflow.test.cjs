const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/main.yml'), 'utf8'));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const uploadStep = job => workflow.jobs[job].steps.find(step => step.run?.includes('aws s3 cp'));
const manifests = ['latest.yml', 'latest-cn.yml', 'latest-mac.yml', 'latest-mac-cn.yml'];
const payloads = {
  windows: ['global/aily-blockly-Setup-0.9.104.exe', 'cn/aily-blockly-CN-Setup-0.9.104.exe'],
  macos: ['global/aily-blockly-macos-0.9.104-arm64.dmg', 'global/aily-blockly-macos-0.9.104-arm64.zip',
    'cn/aily-blockly-CN-macos-0.9.104-arm64.dmg', 'cn/aily-blockly-CN-macos-0.9.104-arm64.zip'],
};

// Only the workflow's upload step runs. Both external service entry points are shell mocks.
const mocks = `
mock_count=0
aws() {
  [[ "$1" == s3 && "$2" == cp && "$4" == s3://mock-bucket/blockly/* ]] || return 90
  local filename
  filename=$(basename "$4")
  printf 'put %s\\n' "$filename" >> calls.log
  mock_count=$((mock_count + 1))
  if [[ "$mock_count" == "$FAIL_PUT" ]]; then return 42; fi
  cp -- "$3" "mock-r2/$filename"
}
node() {
  [[ "$#" == 3 && "$1" == scripts/blockly-feed-guard.cjs && "$2" == ./manifests && "$3" == "$RELEASE_VERSION" ]] || return 91
  printf 'guard\\n' >> calls.log
  return "$GUARD_EXIT"
}
`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blockly r2-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, content = 'fixture') => {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  fs.mkdirSync(path.join(directory, 'mock-r2'));
  for (const [platform, names] of Object.entries(payloads)) {
    for (const name of names) write(`artifacts/${platform}/${name}`);
    for (const flavor of ['global', 'cn']) write(`artifacts/${platform}/${flavor}/latest.yml`);
  }
  for (const name of manifests) write(`manifests/${name}`);
  for (const name of ['CHANGELOG.md', 'CHANGELOG_ZH.md']) write(`artifacts/${name}`);
  return {
    directory, write,
    run(job, env = {}) {
      write('calls.log', '');
      const result = spawnSync(bash, ['--noprofile', '--norc', '-c', mocks + uploadStep(job).run], {
        cwd: directory, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, R2_ACCOUNT_ID: 'mock', R2_BUCKET_NAME: 'mock-bucket',
          R2_UPLOAD_PATH: 'blockly', R2_PUBLIC_URL: 'https://mock.invalid', RELEASE_VERSION: '0.9.104',
          AWS_ACCESS_KEY_ID: 'mock', AWS_SECRET_ACCESS_KEY: 'mock', AWS_DEFAULT_REGION: 'auto',
          FAIL_PUT: '0', GUARD_EXIT: '0', ...env },
      });
      if (result.error) throw result.error;
      const events = fs.readFileSync(path.join(directory, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean);
      return { ...result, events, puts: events.filter(event => event.startsWith('put ')).map(event => event.slice(4)) };
    },
  };
}

for (const platform of ['windows', 'macos']) {
  const job = `upload-${platform}-to-r2`;
  test(`${platform} uploads only its versioned payloads`, t => {
    const context = fixture(t);
    const result = context.run(job);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.puts, payloads[platform].map(name => path.basename(name)));
    assert.ok(!result.events.includes('guard'));
  });

  test(`${platform} stops on a missing glob, an empty package, or a failed upload`, t => {
    const context = fixture(t);
    const first = `artifacts/${platform}/${payloads[platform][0]}`;
    fs.unlinkSync(path.join(context.directory, first));
    let result = context.run(job);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.puts, []);
    context.write(first, '');
    result = context.run(job);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.puts, []);
    context.write(first);
    result = context.run(job, { FAIL_PUT: '2' });
    assert.equal(result.status, 42, result.stderr);
    assert.equal(result.puts.length, 2);
  });
}

const metadataJob = 'publish-update-metadata';
const metadataFiles = ['CHANGELOG.md', 'CHANGELOG_ZH.md', ...manifests];

test('an independently retried metadata job cannot write when its guard fails', t => {
  const context = fixture(t);
  const result = context.run(metadataJob, { GUARD_EXIT: '39' });
  assert.equal(result.status, 39, result.stderr);
  assert.deepEqual(result.events, ['guard']);
  assert.deepEqual(fs.readdirSync(path.join(context.directory, 'mock-r2')), []);
});

test('metadata checks both logs before writing and stops before manifests when a log upload fails', t => {
  const context = fixture(t);
  context.write('artifacts/CHANGELOG_ZH.md', '');
  let result = context.run(metadataJob);
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.events, ['guard']);
  context.write('artifacts/CHANGELOG_ZH.md');
  result = context.run(metadataJob, { FAIL_PUT: '2' });
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(result.puts, metadataFiles.slice(0, 2));
});

test('retry after a manifest failure restores this run\'s logs even after an older run retried', t => {
  const context = fixture(t);
  const prepare = marker => {
    for (const name of metadataFiles) {
      context.write(`${name.endsWith('.md') ? 'artifacts' : 'manifests'}/${name}`, `${marker}:${name}`);
    }
  };
  const remote = name => fs.readFileSync(path.join(context.directory, 'mock-r2', name), 'utf8');
  for (const name of metadataFiles) context.write(`mock-r2/${name}`, `A:${name}`);
  prepare('B');
  let result = context.run(metadataJob, { RELEASE_VERSION: '0.9.105', FAIL_PUT: '3' });
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(result.events, ['guard', ...metadataFiles.slice(0, 3).map(name => `put ${name}`)]);
  assert.equal(remote('CHANGELOG.md'), 'B:CHANGELOG.md');
  for (const name of manifests) assert.equal(remote(name), `A:${name}`);

  // With all manifests still at A, its independent retry is allowed by the guard.
  prepare('A');
  result = context.run(metadataJob);
  assert.equal(result.status, 0, result.stderr);
  for (const name of metadataFiles) assert.equal(remote(name), `A:${name}`);

  prepare('B');
  result = context.run(metadataJob, { RELEASE_VERSION: '0.9.105' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, ['guard', ...metadataFiles.map(name => `put ${name}`)]);
  for (const name of metadataFiles) assert.equal(remote(name), `B:${name}`);
});

test('stable metadata follows both packages and supplies the sole dependency of domestic sync', () => {
  for (const platform of ['windows', 'macos']) {
    assert.deepEqual(workflow.jobs[`upload-${platform}-to-r2`].needs, ['release']);
  }
  assert.deepEqual(workflow.jobs[metadataJob].needs, ['prepare', 'upload-windows-to-r2', 'upload-macos-to-r2']);
  assert.deepEqual(workflow.jobs['trigger-server-script'].needs, [metadataJob]);
  for (const name of ['upload-windows-to-r2', 'upload-macos-to-r2', metadataJob, 'trigger-server-script']) {
    assert.equal(workflow.jobs[name].if, "github.ref_name == 'deploy'");
  }
  const archived = workflow.jobs.release.steps.find(step => step.uses === 'actions/upload-artifact@v4' &&
    step.with.name === 'AilyBlockly-Manifests');
  assert.equal(archived.with.path, 'feed/*.yml');
  assert.equal(archived.with.overwrite, true);
  assert.equal(archived.with['if-no-files-found'], 'error');
  assert.equal(archived.if, "github.ref_name == 'deploy'");
  const downloaded = workflow.jobs[metadataJob].steps.find(step => step.uses === 'actions/download-artifact@v4' &&
    step.with.name === archived.with.name);
  assert.equal(downloaded.with.path, './manifests');
  assert.equal(uploadStep(metadataJob).env.RELEASE_VERSION, '${{ needs.prepare.outputs.version }}');
});
