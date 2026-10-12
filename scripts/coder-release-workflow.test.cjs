const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const { test } = require('node:test');
const yaml = require('js-yaml');
const { releaseFiles } = require('./coder-release-manifest.cjs');

const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/coder.yml'), 'utf8'));
const step = (job, name) => workflow.jobs[job].steps.find(step => step.name === name);
const environment = {
  GITHUB_REPOSITORY: 'source/repo', GITHUB_RUN_ID: '123', GITHUB_SHA: 'a'.repeat(40),
  GITHUB_OUTPUT: 'output', CODER_RELEASE_REPOSITORY: 'target/repo',
  RELEASE_TAG: 'v0.1.7', RELEASE_VERSION: '0.1.7', RELEASE_CHANNEL: 'stable',
};
function run(job, name, modules, env = {}, globals = {}) {
  const source = step(job, name).run.match(/node <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  return vm.runInNewContext(source, {
    Buffer, process: { env: { ...environment, ...env } },
    require(name) {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name === 'semver' || name === 'node:crypto') return require(name);
      if (name === './scripts/coder-release-manifest.cjs') return { releaseFiles };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    ...globals,
  });
}

function guard(releases = []) {
  const written = {};
  run('publish-release', 'Resolve existing release and reject channel rollback', {
    './releases.json': [releases],
    'node:fs': {
      appendFileSync: (name, value) => { written[name] = value; },
    },
  });
  return written;
}

test('same-version releases from previous runs and tags without releases can be reused', () => {
  assert.match(guard().output, /published=false/);
  for (const draft of [true, false]) {
    const existing = { id: 7, tag_name: 'v0.1.7', body: 'Published by an earlier run', draft, prerelease: false };
    assert.equal(guard([existing]).output, `published=${!draft}\nrelease_id=7\n`);
  }
  assert.doesNotMatch(step('publish-release', 'Resolve existing release and reject channel rollback').run,
    /tags\.json|git\/matching-refs|coder-run:/);
  const upload = step('publish-release', 'Upload or replace Coder release assets');
  assert.equal(upload.if, undefined);
  assert.equal(upload.with.overwrite_files, true);
  assert.equal(upload.with.body_path, 'release/CHANGELOG_CODER.md');
  assert.deepEqual(upload.with.files.trim().split('\n'), [
    'release/aily-coder-*.exe', 'release/aily-coder-*.dmg',
    'release/CHANGELOG_CODER.md', 'release/CHANGELOG_CODER_ZH.md',
  ]);
  assert.equal(upload.with.draft, "${{ steps.release.outputs.published != 'true' }}");
  assert.equal(upload.with.make_latest,
    "${{ steps.release.outputs.published == 'true' && needs.prepare.outputs.make_latest || 'false' }}");
});

test('reusing an existing release still cannot roll back a newer published channel version', () => {
  assert.throws(() => guard([
    { id: 7, tag_name: 'v0.1.7', draft: false, prerelease: false },
    { id: 8, tag_name: 'v0.1.8', draft: false, prerelease: false },
  ]), /older than published/);
});

async function finishRelease({ published = false, channel = 'stable', alter = () => {} } = {}) {
  const files = new Map(['CHANGELOG_CODER.md', 'CHANGELOG_CODER_ZH.md'].map(name => [name, Buffer.from(name)]));
  for (const platform of ['windows', 'macos']) for (const flavor of ['cn', 'global']) {
    const { manifest, packages } = releaseFiles(platform, flavor, environment.RELEASE_VERSION);
    for (const name of [manifest, ...packages]) files.set(name, Buffer.from(name));
  }
  const assets = [...files].filter(([name]) => /\.(exe|dmg|md)$/.test(name)).map(([name, content]) => ({ name, size: content.length, state: 'uploaded',
    digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}` }));
  alter(assets);
  const updates = [];
  await run('publish-release', 'Verify complete Release assets before publication', {
    'node:fs': {
      createReadStream: name => Readable.from(files.get(name.replace(/^release\//, ''))),
      statSync: name => ({ size: files.get(name.replace(/^release\//, '')).length }),
    },
    'node:child_process': { execFileSync(command, args, options) {
      assert.equal(command, 'gh');
      if (args.includes('PATCH')) updates.push(JSON.parse(options.input));
      else {
        assert.ok(args.includes('repos/target/repo/releases/7/assets?per_page=100'));
        return JSON.stringify([assets]);
      }
    } },
  }, { RELEASE_ID: '7', ALREADY_PUBLISHED: String(published), RELEASE_CHANNEL: channel, MAKE_LATEST: String(channel === 'stable') });
  return updates;
}

test('new drafts publish after asset verification and existing public releases are verified again', async () => {
  assert.deepEqual(await finishRelease(), [{ draft: false, prerelease: false, make_latest: 'true' }]);
  assert.deepEqual(await finishRelease({ channel: 'beta' }), [{ draft: false, prerelease: true, make_latest: 'false' }]);
  assert.deepEqual(await finishRelease({ published: true }), []);
  assert.deepEqual(await finishRelease({ published: true,
    alter: assets => assets.push({ name: 'previous-build.zip' }, { name: 'latest-coder.yml' }),
  }), []);
  for (const alter of [assets => assets.pop(), assets => { assets[0].digest = 'sha256:wrong'; },
    assets => { assets[0].state = 'starter'; }, assets => assets.push({ name: 'unexpected.txt' })]) {
    await assert.rejects(finishRelease({ alter }), /Release asset/);
    await assert.rejects(finishRelease({ published: true, alter }), /Release asset/);
  }
});

test('same-version feed contents may change while both endpoints reject lower release versions', async () => {
  const config = { regions: {
    eu: { updater: 'https://source.invalid/blockly/' },
    cn: { updater: 'https://mirror.invalid/blockly' },
  } };
  const expected = [
    'https://source.invalid/blockly/latest-coder-cn.yml',
    'https://source.invalid/blockly/latest-coder.yml',
    'https://source.invalid/blockly/latest-coder-mac-cn.yml',
    'https://source.invalid/blockly/latest-coder-mac.yml',
    'https://mirror.invalid/blockly/latest-coder.yml',
    'https://mirror.invalid/blockly/latest-coder-mac.yml',
  ];
  async function inspect(newerUrl) {
    const calls = [], errors = [];
    const processState = { env: environment, exitCode: 0 };
    await run('upload-stable-feed', 'Check final files and reject public feed rollback', {
      'js-yaml': yaml, './electron/config/config.json': config,
    }, {}, {
      process: processState, AbortSignal,
      console: { error: message => errors.push(message) },
      async fetch(url) {
        calls.push(url);
        return { status: 200, ok: true, arrayBuffer: async () => Buffer.from(yaml.dump({
          version: url === newerUrl ? '0.1.8' : '0.1.7',
          files: [{ url: 'previous-build.zip', sha512: 'previous-digest', size: 10 }],
        })) };
      },
    });
    return { calls, errors, exitCode: processState.exitCode };
  }
  const sameVersion = await inspect();
  assert.equal(sameVersion.exitCode, 0, sameVersion.errors.join('\n'));
  assert.deepEqual(sameVersion.calls, expected);
  for (const newerUrl of [expected[0], expected[4]]) {
    const rollback = await inspect(newerUrl);
    assert.equal(rollback.exitCode, 1);
    assert.match(rollback.errors.join('\n'), /Refusing feed rollback/);
    assert.ok(rollback.calls.includes(newerUrl));
  }
});

function saveBaseline({ previous = 'b'.repeat(40), relation = 'ahead', conflict = false, next = previous } = {}) {
  const updates = [];
  let reads = 0;
  run('save-source-baseline', "Save only this Coder channel's source SHA", {
    'node:child_process': {
      spawnSync(command, args) {
        assert.equal(command, 'gh');
        if (args[1].endsWith('/git/ref/heads/release-meta')) return { status: 0 };
        assert.equal(args[1], 'repos/source/repo/contents/last-sha-coder-stable?ref=release-meta');
        const source = reads++ === 0 ? previous : next;
        return source === null ? { status: 1, stderr: 'HTTP 404' } : { status: 0,
          stdout: JSON.stringify({ sha: `blob-${reads}`, content: Buffer.from(source).toString('base64') }) };
      },
      execFileSync(command, args, options) {
        assert.equal(command, 'gh');
        if (args.includes('--jq')) {
          assert.ok(args[1].endsWith(`...${environment.GITHUB_SHA}`));
          return Array.isArray(relation) ? relation.shift() : relation;
        }
        assert.equal(args[1], 'repos/source/repo/contents/last-sha-coder-stable');
        updates.push(JSON.parse(options.input));
        if (conflict) throw Object.assign(new Error('conflict'), { stderr: 'HTTP 409' });
        return '{}';
      },
    },
  });
  return updates;
}

test('baseline advances only from an ancestor and equal-source retries do not write', () => {
  const [update] = saveBaseline();
  assert.equal(update.sha, 'blob-1');
  assert.equal(update.branch, 'release-meta');
  assert.equal(Buffer.from(update.content, 'base64').toString(), `${environment.GITHUB_SHA}\n`);
  assert.deepEqual(saveBaseline({ previous: environment.GITHUB_SHA }), []);
  assert.equal(saveBaseline({ previous: null })[0].sha, undefined);
  for (const relation of ['behind', 'diverged']) assert.throws(() => saveBaseline({ relation }), /rewind or diverge/);
  assert.throws(() => saveBaseline({ previous: 'invalid' }), /Invalid Coder source baseline/);
});

test('baseline rereads after a conflict and never overwrites a concurrent newer SHA', () => {
  assert.equal(saveBaseline({ conflict: true, next: environment.GITHUB_SHA }).length, 1);
  assert.throws(() => saveBaseline({ conflict: true, next: 'c'.repeat(40), relation: ['ahead', 'behind'] }), /rewind or diverge/);
  assert.throws(() => saveBaseline({ conflict: true }), /conflict/);
});

test('artifacts support same-run retries and stable verification waits for domestic synchronization', () => {
  const uploads = Object.values(workflow.jobs).flatMap(job => job.steps).filter(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(uploads.length, 4);
  assert.ok(uploads.every(step => step.with.overwrite === true));
  assert.equal(workflow.jobs['prepare-release'].needs, 'prepare');
  assert.ok(!workflow.jobs['prepare-release'].steps.some(step => step.uses === 'actions/download-artifact@v4'));
  assert.ok(workflow.jobs['publish-release'].needs.includes('prepare-release'));
  assert.deepEqual(workflow.jobs['sync-stable-feed'].needs, ['prepare', 'upload-stable-feed']);
  assert.equal(workflow.jobs['sync-stable-feed'].if, "needs.prepare.outputs.channel == 'stable'");
  assert.deepEqual(workflow.jobs['verify-stable-feed'].needs, ['prepare', 'sync-stable-feed']);
  const syncWorkflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/coder-sync.yml'), 'utf8'));
  for (const source of [workflow, syncWorkflow]) {
    assert.deepEqual(source.jobs['sync-stable-feed'].steps[0].env, {
      SERVER_HOST: '${{ secrets.TRIGGER_SERVER_HOST }}', SERVER_USER: '${{ secrets.TRIGGER_SERVER_USER }}',
      SERVER_PASSWORD: '${{ secrets.TRIGGER_SERVER_PASSWORD }}', SERVER_SCRIPT_PATH: '${{ secrets.TRIGGER_CODER_SERVER_SCRIPT_PATH }}',
    });
  }
});
