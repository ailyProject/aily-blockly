const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../../scripts/sign-coder-installer.cjs'), 'utf8');
const artifactId = '14344542516';
const runId = 44063532722;
const missingArtifact = `::error::There is no published artifact with id "${artifactId}" for workflow run id ${runId}.Please check the "github-artifact-id" field.`;
const inputNames = ['api-token', 'organization-id', 'project-slug', 'signing-policy-slug', 'artifact-configuration-slug',
  'github-artifact-id', 'github-token', 'parameters', 'output-artifact-directory', 'connector-url',
  'wait-for-completion', 'wait-for-completion-timeout-in-seconds', 'service-unavailable-timeout-in-seconds',
  'download-signed-artifact-timeout-in-seconds'];

// This small downloaded action runs in a real child process, including its output streams and GITHUB_OUTPUT file.
const action = `
const fs = require('node:fs');
const filename = process.env.TEST_SIGNPATH_CALLS;
const calls = JSON.parse(fs.readFileSync(filename, 'utf8'));
const response = JSON.parse(process.env.TEST_SIGNPATH_RESPONSES)[calls.length];
calls.push({ inputs: Object.fromEntries(${JSON.stringify(inputNames)}.map(name =>
  [name, process.env['INPUT_' + name.toUpperCase()]])),
  output: process.env.GITHUB_OUTPUT, runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY });
fs.writeFileSync(filename, JSON.stringify(calls));
if (!response) throw new Error('Unexpected signing attempt');
for (const [stream, chunks] of Object.entries(response.logs || {})) {
  for (const chunk of chunks) process[stream].write(chunk);
}
if (response.output) fs.appendFileSync(process.env.GITHUB_OUTPUT, response.output);
process.exitCode = response.code || 0;
`;

function fixture(t, { responses = [{ output: 'signing-request-id=request-123\n' }], statuses = [200], data,
  downloadStatus = 200 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-signing-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'parent-output');
  const callsFile = path.join(directory, 'calls.json');
  fs.writeFileSync(output, 'existing=value\n');
  fs.writeFileSync(callsFile, '[]');
  const calls = { artifacts: [], delays: [], downloads: [], info: [], warnings: [] };
  const inputs = {
    'api-token': 'fixture-signpath-token', 'organization-id': 'fixture-organization',
    'project-slug': 'aily-blockly', 'signing-policy-slug': 'release-signing',
    'artifact-configuration-slug': 'aily-coder', 'github-artifact-id': artifactId,
    'github-token': 'fixture-github-token', 'parameters': 'version: "0.1.7"',
    'output-artifact-directory': 'dist/aily-coder',
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, AbortSignal,
    process: { execPath: process.execPath, env: { ...process.env,
      RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_RUN_ID: String(runId), GITHUB_REPOSITORY: 'source/repo',
      TEST_SIGNPATH_CALLS: callsFile, TEST_SIGNPATH_RESPONSES: JSON.stringify(responses),
    } },
    require(name) {
      if (name === 'node:timers/promises') return { setTimeout: async ms => { calls.delays.push(ms); } };
      if (['node:fs', 'node:path', 'node:child_process', 'node:readline'].includes(name)) return require(name);
      throw new Error(`Unexpected dependency: ${name}`);
    },
    async fetch(url) {
      calls.downloads.push(url);
      return { ok: downloadStatus === 200, status: downloadStatus, text: async () => action };
    },
  });
  return {
    calls, inputs, directory, output,
    attempts: () => JSON.parse(fs.readFileSync(callsFile, 'utf8')),
    run: () => module.exports({
      context: { repo: { owner: 'source', repo: 'repo' }, runId },
      core: { info: line => calls.info.push(line), warning: line => calls.warnings.push(line) },
      github: { rest: { actions: { async getArtifact(args) {
        const status = statuses[Math.min(calls.artifacts.length, statuses.length - 1)];
        calls.artifacts.push(args);
        if (status !== 200) throw Object.assign(new Error(`HTTP ${status}`), { status });
        return { data: data || { expired: false, workflow_run: { id: runId } } };
      } } } },
    }, inputs),
  };
}

test('official action receives signing inputs and defaults, and successful outputs pass through unchanged', async t => {
  const outputs = 'signing-request-id<<delimiter\nrequest-123\ndelimiter\nsigning-request-web-url=https://signing.invalid/request-123\n';
  const context = fixture(t, { responses: [{ output: outputs,
    logs: { stdout: ['submission complete\n'], stderr: ['deprecation warning\n'] } }] });
  await context.run();
  const [attempt] = context.attempts();
  assert.deepEqual(attempt.inputs, { ...context.inputs,
    'connector-url': 'https://githubactions.connectors.signpath.io', 'wait-for-completion': 'true',
    'wait-for-completion-timeout-in-seconds': '600', 'service-unavailable-timeout-in-seconds': '600',
    'download-signed-artifact-timeout-in-seconds': '300',
  });
  assert.equal(attempt.runId, String(runId));
  assert.equal(attempt.repository, 'source/repo');
  assert.notEqual(attempt.output, context.output);
  assert.equal(fs.readFileSync(context.output, 'utf8'), `existing=value\n${outputs}`);
  assert.deepEqual(context.calls.downloads,
    ['https://raw.githubusercontent.com/SignPath/github-action-submit-signing-request/ced31329c0317e779dad2eec2a7c3bb46ea1343e/index.js']);
  assert.deepEqual(context.calls.info.sort(), ['deprecation warning', 'submission complete']);
  assert.deepEqual(context.calls.delays, []);
  assert.ok(!fs.readdirSync(context.directory).some(name => name.startsWith('coder-signpath-')));
});

test('split missing-artifact errors on either stream retry the same artifact and can recover', async t => {
  const context = fixture(t, { responses: [
    { code: 1, logs: { stdout: [missingArtifact.slice(0, 30), `${missingArtifact.slice(30)}\n`] } },
    { code: 1, logs: { stderr: [missingArtifact.slice(0, 60), `${missingArtifact.slice(60)}\n`] } },
    { output: 'signing-request-id=recovered\n' },
  ] });
  await context.run();
  const attempts = context.attempts();
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(attempt => attempt.inputs['github-artifact-id'] === artifactId));
  assert.equal(new Set(attempts.map(attempt => attempt.output)).size, 3);
  assert.equal(context.calls.downloads.length, 1);
  assert.equal(context.calls.artifacts.length, 1);
  assert.deepEqual(context.calls.delays, [15000, 15000]);
  assert.equal(context.calls.warnings.filter(line => line.startsWith('There is no published artifact')).length, 2);
  assert.ok(context.calls.info.every(line => !line.startsWith('::error::')));
  assert.equal(fs.readFileSync(context.output, 'utf8'), 'existing=value\nsigning-request-id=recovered\n');
});

test('an artifact that remains invisible stops after three signing attempts', async t => {
  const context = fixture(t, { responses: Array.from({ length: 3 }, () => ({
    code: 1, output: 'partial=value\n', logs: { stderr: [`${missingArtifact}\n`] },
  })) });
  await assert.rejects(context.run(), /no further signing submission/);
  assert.equal(context.attempts().length, 3);
  assert.deepEqual(context.calls.delays, [15000, 15000]);
  assert.equal(fs.readFileSync(context.output, 'utf8'), 'existing=value\n');
  assert.ok(!fs.readdirSync(context.directory).some(name => name.startsWith('coder-signpath-')));
});

test('other signing errors, including an error for a different artifact, never resubmit', async t => {
  for (const [code, error] of [[1, '::error::Invalid SignPath API token'],
    [1, missingArtifact.replace(artifactId, '123')],
    [1, `${missingArtifact}\n::error::CI system validation failed`], [2, missingArtifact]]) {
    const context = fixture(t, { responses: [{ code, logs: { stderr: [`${error}\n`] } }] });
    await assert.rejects(context.run(), /no further signing submission/);
    assert.equal(context.attempts().length, 1);
    assert.deepEqual(context.calls.delays, []);
  }
});

test('a submitted signing request is never retried even if the missing-artifact error also appears', async t => {
  const context = fixture(t, { responses: [{ code: 1, logs: { stdout: [
    'SignPath signing request has been successfully submitted\n', `${missingArtifact}\n`,
  ] } }] });
  await assert.rejects(context.run(), /no further signing submission/);
  assert.equal(context.attempts().length, 1);
  assert.deepEqual(context.calls.delays, []);
});

test('a signing request id output prevents resubmission without relying on action log messages', async t => {
  for (const output of ['signing-request-id=request-123\n', 'signing-request-id<<delimiter\nrequest-123\ndelimiter\n']) {
    const context = fixture(t, { responses: [{ code: 1, output, logs: { stderr: [`${missingArtifact}\n`] } }] });
    await assert.rejects(context.run(), /no further signing submission/);
    assert.equal(context.attempts().length, 1);
    assert.deepEqual(context.calls.delays, []);
    assert.equal(fs.readFileSync(context.output, 'utf8'), 'existing=value\n');
  }
});

test('GitHub metadata 404 waits before downloading and signing the artifact', async t => {
  const context = fixture(t, { statuses: [404, 404, 200] });
  await context.run();
  assert.equal(context.calls.artifacts.length, 3);
  for (const args of context.calls.artifacts) {
    assert.equal(args.owner, 'source');
    assert.equal(args.repo, 'repo');
    assert.equal(args.artifact_id, Number(artifactId));
  }
  assert.deepEqual(context.calls.delays, [10000, 10000]);
  assert.equal(context.calls.downloads.length, 1);
  assert.equal(context.attempts().length, 1);
});

test('permanent metadata 404 is bounded and a permission failure stops immediately', async t => {
  for (const [status, attempts] of [[404, 6], [403, 1]]) {
    const context = fixture(t, { statuses: [status] });
    await assert.rejects(context.run(), error => error.status === status);
    assert.equal(context.calls.artifacts.length, attempts);
    assert.deepEqual(context.calls.delays, Array(attempts - 1).fill(10000));
    assert.deepEqual(context.calls.downloads, []);
    assert.deepEqual(context.attempts(), []);
  }
});

test('expired or foreign-run artifacts cannot be submitted', async t => {
  for (const data of [{ expired: true, workflow_run: { id: runId } },
    { expired: false, workflow_run: { id: runId + 1 } }]) {
    const context = fixture(t, { data });
    await assert.rejects(context.run(), /expired or belongs to another workflow run/);
    assert.equal(context.calls.artifacts.length, 1);
    assert.deepEqual(context.calls.downloads, []);
    assert.deepEqual(context.attempts(), []);
  }
});

test('failure to download the pinned action does not launch signing', async t => {
  const context = fixture(t, { downloadStatus: 503 });
  await assert.rejects(context.run(), /Cannot download pinned SignPath action: HTTP 503/);
  assert.equal(context.calls.downloads.length, 1);
  assert.deepEqual(context.attempts(), []);
  assert.ok(!fs.readdirSync(context.directory).some(name => name.startsWith('coder-signpath-')));
});
