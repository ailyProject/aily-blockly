const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const { test } = require('node:test');
const yaml = require('js-yaml');
const { releaseFiles } = require('../../scripts/coder-release-manifest.cjs');

const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../../.github/workflows/coder.yml'), 'utf8'));
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

test('Windows signing invokes the artifact-aware helper with the uploaded id and existing SignPath configuration', async () => {
  const job = workflow.jobs['build-and-sign-windows'];
  const signing = step('build-and-sign-windows', 'Sign installer');
  assert.equal(signing.uses, 'actions/github-script@v7');
  assert.equal(signing.env.SIGNPATH_ARTIFACT_ID, '${{ steps.unsigned.outputs.artifact-id }}');
  assert.equal(signing.env.SIGNPATH_API_TOKEN, '${{ secrets.SIGNPATH_API_TOKEN }}');
  assert.equal(signing.env.SIGNPATH_SIGNING_POLICY, '${{ needs.prepare.outputs.signing_policy }}');
  assert.equal(signing.env.GITHUB_TOKEN, '${{ github.token }}');
  assert.ok(job.steps.indexOf(signing) > job.steps.findIndex(step => step.id === 'unsigned'));
  assert.ok(job.steps.indexOf(signing) < job.steps.findIndex(step => step.name === 'Verify Authenticode and generate final manifest'));
  let received;
  const github = {}, context = {}, core = {};
  await vm.runInNewContext(`(async () => { ${signing.with.script} })()`, {
    github, context, core,
    process: { env: { SIGNPATH_API_TOKEN: 'signpath-token', SIGNPATH_ARTIFACT_ID: '14344542516',
      SIGNPATH_SIGNING_POLICY: 'release-signing', GITHUB_TOKEN: 'github-token', RELEASE_VERSION: '0.1.7' } },
    require(name) {
      assert.equal(name, './scripts/sign-coder-installer.cjs');
      return async (scope, inputs) => {
        assert.equal(scope.github, github);
        assert.equal(scope.context, context);
        assert.equal(scope.core, core);
        received = JSON.parse(JSON.stringify(inputs));
      };
    },
  });
  assert.deepEqual(received, {
    'api-token': 'signpath-token', 'organization-id': 'bd01a768-a9e3-4a62-945d-fcfdc37a299e',
    'project-slug': 'aily-blockly', 'signing-policy-slug': 'release-signing',
    'artifact-configuration-slug': 'aily-coder', 'github-artifact-id': '14344542516',
    'github-token': 'github-token', 'parameters': 'version: "0.1.7"',
    'output-artifact-directory': 'dist/aily-coder',
  });
});

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

test('artifacts support same-run retries and stable baselines wait for domestic synchronization', () => {
  const uploads = Object.values(workflow.jobs).flatMap(job => job.steps).filter(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(uploads.length, 4);
  assert.ok(uploads.every(step => step.with.overwrite === true));
  assert.equal(workflow.jobs['prepare-release'].needs, 'prepare');
  assert.ok(!workflow.jobs['prepare-release'].steps.some(step => step.uses === 'actions/download-artifact@v4'));
  assert.ok(workflow.jobs['publish-release'].needs.includes('prepare-release'));
  assert.deepEqual(workflow.jobs['sync-stable-feed'].needs, ['prepare', 'upload-stable-feed']);
  assert.equal(workflow.jobs['sync-stable-feed'].if, "needs.prepare.outputs.channel == 'stable'");
  assert.equal(workflow.jobs['verify-stable-feed'], undefined);
  const baseline = workflow.jobs['save-source-baseline'];
  assert.deepEqual(baseline.needs, ['prepare', 'publish-release', 'sync-stable-feed']);
  for (const [channel, syncResult, publishResult, expected] of [
    ['stable', 'success', 'success', true],
    ['stable', 'failure', 'success', false],
    ['beta', 'skipped', 'success', true],
    ['beta', 'skipped', 'failure', false],
  ]) {
    assert.equal(vm.runInNewContext(baseline.if.replace(/needs\.([a-z-]+)/g, 'needs["$1"]'), {
      always: () => true,
      needs: { prepare: { outputs: { channel } }, 'publish-release': { result: publishResult },
        'sync-stable-feed': { result: syncResult } },
    }), expected);
  }
  const syncWorkflow = yaml.load(fs.readFileSync(path.join(__dirname, '../../.github/workflows/coder-sync.yml'), 'utf8'));
  assert.equal(syncWorkflow.on.workflow_dispatch.inputs.source_run_id.required, true);
  const repair = syncWorkflow.jobs['sync-stable-feed'];
  assert.equal(repair.if, "github.ref == 'refs/heads/deploy-coder'");
  const sources = [workflow.jobs['sync-stable-feed'], repair];
  for (const job of sources) {
    const dispatch = job.steps.at(-1);
    assert.equal(dispatch.run, 'bash scripts/dispatch-cn-feed.sh coder "$RELEASE_VERSION"');
    assert.equal(dispatch.env.GH_TOKEN, '${{ secrets.CN_FEED_DISPATCH_TOKEN }}');
  }
  assert.equal(sources[0].steps.at(-1).env.RELEASE_VERSION, '${{ needs.prepare.outputs.version }}');
  assert.equal(repair.steps.at(-1).env.SOURCE_RUN_ID, '${{ inputs.source_run_id }}');
  assert.equal(repair.steps.at(-1).env.SOURCE_SHA, '${{ steps.source.outputs.sha }}');
  assert.equal(repair.steps.at(-1).env.SOURCE_ATTEMPT, '${{ steps.source.outputs.attempt }}');
  assert.equal(repair.steps.at(-1).env.RELEASE_VERSION, '${{ steps.source.outputs.version }}');
});
