const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');

// Keep the existing official v1 implementation for submission, approval and download.
const actionUrl = 'https://raw.githubusercontent.com/SignPath/github-action-submit-signing-request/ced31329c0317e779dad2eec2a7c3bb46ea1343e/index.js';

function runAction(filename, env, missingArtifactMessage, core) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filename], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let artifactMissing = false;
    let otherError = false;
    let submitted = false;
    for (const stream of [child.stdout, child.stderr]) {
      const lines = readline.createInterface({ input: stream });
      lines.on('line', line => {
        if (line.startsWith(`::error::${missingArtifactMessage}`)) {
          artifactMissing = true;
          core.warning(line.slice('::error::'.length));
        } else {
          if (line.startsWith('::error')) otherError = true;
          core.info(line);
        }
        if (line.includes('SignPath signing request has been successfully submitted') ||
            line.includes('The signing request id is ')) submitted = true;
      });
    }
    child.on('error', reject);
    child.on('close', code => resolve({ code, artifactMissing, otherError, submitted }));
  });
}

module.exports = async function signCoderInstaller({ github, context, core }, inputs) {
  const artifactId = inputs['github-artifact-id'];
  const missingArtifactMessage = `There is no published artifact with id "${artifactId}" for workflow run id ${context.runId}.`;
  // An upload can finish before its metadata becomes visible through the REST API.
  for (let attempt = 1; ; attempt++) {
    try {
      const { data } = await github.rest.actions.getArtifact({ ...context.repo, artifact_id: Number(artifactId) });
      if (data.expired || data.workflow_run.id !== context.runId) throw new Error('Signing artifact is expired or belongs to another workflow run');
      break;
    } catch (error) {
      if (error.status !== 404 || attempt === 6) throw error;
      core.info(`Waiting for GitHub artifact ${artifactId} to become visible (${attempt}/6)`);
      await delay(10000);
    }
  }

  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'coder-signpath-'));
  try {
    const response = await fetch(actionUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Cannot download pinned SignPath action: HTTP ${response.status}`);
    const filename = path.join(directory, 'index.cjs');
    fs.writeFileSync(filename, await response.text());
    const actionInputs = {
      'connector-url': 'https://githubactions.connectors.signpath.io',
      'wait-for-completion': 'true',
      'wait-for-completion-timeout-in-seconds': '600',
      'service-unavailable-timeout-in-seconds': '600',
      'download-signed-artifact-timeout-in-seconds': '300',
      ...inputs,
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const output = path.join(directory, `output-${attempt}`);
      fs.writeFileSync(output, '');
      const env = { ...process.env, GITHUB_OUTPUT: output };
      for (const [key, value] of Object.entries(actionInputs)) env[`INPUT_${key.toUpperCase()}`] = String(value);
      const result = await runAction(filename, env, missingArtifactMessage, core);
      const outputs = fs.readFileSync(output, 'utf8');
      if (result.code === 0) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, outputs);
        return;
      }
      // Never resubmit after creating a request, including approval/download failures.
      if (result.code !== 1 || !result.artifactMissing || result.otherError || result.submitted ||
          /^signing-request-id(?:=|<<)/m.test(outputs) || attempt === 3) {
        throw new Error(`SignPath action failed (exit ${result.code}); no further signing submission will be attempted`);
      }
      core.warning(`SignPath cannot yet see GitHub artifact ${artifactId}; retrying the same artifact (${attempt}/3)`);
      await delay(15000);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
