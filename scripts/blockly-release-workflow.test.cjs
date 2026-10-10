const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const { test } = require('node:test');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/main.yml'), 'utf8'));
const step = (job, name) => workflow.jobs[job].steps.find(step => step.name === name);
const environment = {
  GITHUB_REPOSITORY: 'source/repo', GITHUB_RUN_ID: '123', GITHUB_SHA: 'a'.repeat(40),
  GITHUB_OUTPUT: 'output', RELEASE_REF_TYPE: 'branch', RELEASE_BRANCH: 'deploy',
  RELEASE_VERSION: '0.9.105', RELEASE_TAG: 'v0.9.105',
};
const marker = `<!-- blockly-run:source/repo:123:${environment.GITHUB_SHA} -->`;

test('macOS manifests refresh final DMG metadata after stapling and before rename or upload', () => {
  for (const [job, suffix] of [['build-macos', ''], ['build-macos-cn', ' (CN)']]) {
    const steps = workflow.jobs[job].steps;
    const refresh = step(job, `Refresh DMG update metadata after stapling${suffix}`);
    assert.equal(refresh.run, 'for manifest in dist/aily-blockly/*-mac.yml; do\n' +
      '  node scripts/refresh-macos-dmg-manifest.cjs "$manifest"\ndone\n');
    const orderedNames = [
      `Manual Notarization (if needed)${suffix}`, `Final Verification${suffix}`, refresh.name,
      ...(suffix ? ['Rename latest-mac manifest (CN)'] : []), `Archive macOS Artifact${suffix}`,
    ];
    const indexes = orderedNames.map(name => steps.findIndex(step => step.name === name));
    assert.ok(indexes.every((index, i) => index >= 0 && (i === 0 || index > indexes[i - 1])));
  }
});

function run(job, name, modules, env = {}) {
  const source = step(job, name).run.match(/node <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  return vm.runInNewContext(source, {
    Buffer, process: { env: { ...environment, ...env } },
    require(name) {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (['semver', 'node:crypto', 'node:path'].includes(name)) return require(name);
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
}

test('only deploy/beta branches run, preserving package.json version formats', () => {
  for (const [branch, version] of [['deploy', '0.9.105'], ['beta', '0.9.105'], ['beta', '0.9.105-beta.1']]) {
    let output;
    run('prepare', 'Resolve Blockly release branch and version', {
      './package.json': { version }, 'node:fs': { appendFileSync: (_, value) => { output = value; } },
    }, { RELEASE_BRANCH: branch });
    assert.equal(output, `version=${version}\ntag=v${version}\n`);
  }
  for (const env of [{ RELEASE_BRANCH: 'main' }, { RELEASE_REF_TYPE: 'tag' }]) {
    assert.throws(() => run('prepare', 'Resolve Blockly release branch and version', { 'node:fs': {} }, env), /deploy or beta branch/);
  }
});

function guard(releases = [], tags = [], env = {}) {
  const written = {};
  run('release', 'Reject reused tags or older channel versions', {
    './releases.json': [releases], './tags.json': tags,
    'node:fs': {
      readFileSync: () => 'Archived changelog',
      writeFileSync: (name, value) => { written[name] = value; },
      appendFileSync: (name, value) => { written[name] = value; },
    },
  }, env);
  return written;
}

test('same-run draft/public recovery is allowed, historical tags and newer channel releases are rejected', () => {
  assert.match(guard().output, /published=false/);
  const own = { id: 7, tag_name: environment.RELEASE_TAG, body: marker, draft: true, prerelease: false };
  const tags = [{ ref: `refs/tags/${environment.RELEASE_TAG}` }];
  const recovered = guard([own], tags);
  assert.match(recovered.output, /published=false\nrelease_id=7/);
  assert.equal(recovered['release-body.md'], `Archived changelog\n\n${marker}\n`);
  assert.match(guard([{ ...own, draft: false }], tags).output, /published=true\nrelease_id=7/);
  assert.throws(() => guard([], tags), /another run/);
  for (const draft of [true, false]) {
    assert.throws(() => guard([{ ...own, body: marker.replace(':123:', ':124:'), draft }], tags), /another run/);
  }
  for (const branch of ['deploy', 'beta']) {
    const newer = { tag_name: 'v0.9.106', draft: false, prerelease: branch === 'beta' };
    assert.throws(() => guard([newer], [], { RELEASE_BRANCH: branch }), /newer than published/);
  }
});

async function finishRelease({ published = false, branch = 'deploy', alter = () => {}, extraPackage = false } = {}) {
  const paths = ['release/CHANGELOG.md', 'release/CHANGELOG_ZH.md',
    'release/aily-blockly-Setup-0.9.105.exe', 'release-cn/aily-blockly-CN-Setup-0.9.105.exe',
    'release/aily-blockly-macos-0.9.105-arm64.dmg', 'release-mac-cn/aily-blockly-CN-macos-0.9.105-arm64.dmg'];
  if (extraPackage) paths.push('release/extra.exe');
  const files = new Map(paths.map(name => [name, Buffer.from(name)]));
  const assets = [...files].map(([name, content]) => ({ name: path.basename(name), size: content.length, state: 'uploaded',
    digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}` }));
  alter(assets);
  const updates = [];
  await run('release', 'Verify complete Release assets before publication', {
    'node:fs': {
      readdirSync: directory => paths.filter(name => path.posix.dirname(name) === directory).map(name => path.basename(name)),
      createReadStream: name => Readable.from(files.get(name)), statSync: name => ({ size: files.get(name).length }),
    },
    'node:child_process': { execFileSync(command, args, options) {
      assert.equal(command, 'gh');
      if (args.includes('PATCH')) updates.push(JSON.parse(options.input));
      else {
        assert.ok(args.includes('repos/source/repo/releases/7/assets?per_page=100'));
        return JSON.stringify([assets]);
      }
    } },
  }, { RELEASE_ID: '7', ALREADY_PUBLISHED: String(published), RELEASE_BRANCH: branch });
  return updates;
}

test('six complete matching assets publish; retries of an already public Release never mutate it', async () => {
  assert.deepEqual(await finishRelease(), [{ draft: false, prerelease: false, make_latest: 'true' }]);
  assert.deepEqual(await finishRelease({ branch: 'beta' }), [{ draft: false, prerelease: true, make_latest: 'false' }]);
  assert.deepEqual(await finishRelease({ published: true }), []);
  for (const alter of [assets => assets.pop(), assets => { assets[0].digest = 'sha256:wrong'; }, assets => { assets[0].state = 'starter'; }]) {
    await assert.rejects(finishRelease({ alter }), /Release asset/);
    await assert.rejects(finishRelease({ published: true, alter }), /Release asset/);
  }
  await assert.rejects(finishRelease({ extraPackage: true }), /exactly one/);
});

function saveBaseline({ previous = 'b'.repeat(40), relation = 'ahead', conflicts = [], next = previous, branch = 'deploy' } = {}) {
  const updates = [];
  let reads = 0;
  run('save-source-baseline', "Save only this Blockly branch's source SHA", {
    'node:child_process': {
      spawnSync(command, args) {
        assert.equal(command, 'gh');
        if (args[1].endsWith('/git/ref/heads/release-meta')) return { status: 0 };
        assert.equal(args[1], `repos/source/repo/contents/last-sha-${branch}?ref=release-meta`);
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
        assert.equal(args[1], `repos/source/repo/contents/last-sha-${branch}`);
        updates.push(JSON.parse(options.input));
        if (conflicts.length) throw Object.assign(new Error('conflict'), { stderr: `HTTP ${conflicts.shift()}` });
        return '{}';
      },
    },
  }, { RELEASE_BRANCH: branch });
  return updates;
}

test('branch baselines advance only from an ancestor, equal-source retries do not write', () => {
  for (const branch of ['deploy', 'beta']) {
    const [update] = saveBaseline({ branch });
    assert.equal(update.sha, 'blob-1');
    assert.equal(update.branch, 'release-meta');
    assert.equal(Buffer.from(update.content, 'base64').toString(), `${environment.GITHUB_SHA}\n`);
  }
  assert.deepEqual(saveBaseline({ previous: environment.GITHUB_SHA }), []);
  assert.equal(saveBaseline({ previous: null })[0].sha, undefined);
  for (const relation of ['behind', 'diverged']) assert.throws(() => saveBaseline({ relation }), /rewind or diverge/);
  assert.throws(() => saveBaseline({ previous: 'invalid' }), /Invalid Blockly source baseline/);
});

test('409/422 conflicts reread the latest blob; newer concurrent baselines cannot be overwritten', () => {
  for (const status of [409, 422]) assert.equal(saveBaseline({ conflicts: [status] })[1].sha, 'blob-2');
  assert.equal(saveBaseline({ conflicts: [409], next: environment.GITHUB_SHA }).length, 1);
  assert.throws(() => saveBaseline({ conflicts: [409], next: 'c'.repeat(40), relation: ['ahead', 'behind'] }), /rewind or diverge/);
  assert.throws(() => saveBaseline({ conflicts: [409, 422, 409] }), /conflict/);
});

test('fixed logs precede release, artifacts can retry, and baseline waits for the correct success condition', () => {
  assert.deepEqual(workflow.concurrency, { group: 'aily-blockly-${{ github.ref_name }}', 'cancel-in-progress': false });
  const uploads = Object.values(workflow.jobs).flatMap(job => job.steps).filter(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(uploads.length, 8);
  assert.ok(uploads.every(step => step.with.overwrite === true && step.with['if-no-files-found'] === 'error'));
  assert.equal(workflow.jobs['prepare-release'].needs, 'prepare');
  assert.ok(!workflow.jobs['prepare-release'].steps.some(step => step.uses === 'actions/download-artifact@v4'));
  assert.ok(workflow.jobs.release.needs.includes('prepare-release'));
  const draft = step('release', 'Upload packages and changelogs to a draft');
  assert.equal(draft.if, "steps.release.outputs.published != 'true'");
  assert.equal(draft.with.draft, true);
  assert.equal(draft.with['fail_on_unmatched_files'], true);
  assert.equal(step('release', 'Archive stable update manifests').if, "github.ref_name == 'deploy'");
  assert.equal(step('release', 'Archive stable update manifests').with.name, 'AilyBlockly-Manifests');
  assert.match(step('release', 'Collect stable update manifests').run,
    /cp release\/latest\.yml release\/latest-mac\.yml release-cn\/latest-cn\.yml release-mac-cn\/latest-mac-cn\.yml feed\//);
  assert.deepEqual(workflow.jobs['save-source-baseline'].needs, ['prepare', 'release', 'trigger-server-script']);
  const condition = workflow.jobs['save-source-baseline'].if.replace('needs.trigger-server-script', "needs['trigger-server-script']");
  const maySave = (branch, release, sync) => vm.runInNewContext(condition, {
    always: () => true, github: { ref_name: branch }, needs: { release: { result: release }, 'trigger-server-script': { result: sync } },
  });
  assert.equal(maySave('deploy', 'success', 'success'), true);
  assert.equal(maySave('deploy', 'success', 'failure'), false);
  assert.equal(maySave('beta', 'success', 'skipped'), true);
  assert.equal(maySave('beta', 'failure', 'skipped'), false);
  assert.equal(maySave('main', 'success', 'success'), false);
});
