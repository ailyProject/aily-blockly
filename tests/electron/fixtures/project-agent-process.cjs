const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

// Test-only entry: execute the current independent Agent's actual history controller.
async function run() {
  const [project, agentRoot, hold] = process.argv.slice(2);
  const { HistoryTransactionController } = await import(pathToFileURL(path.join(agentRoot,
    'dist/extensions/pi-workspace-history/transaction-controller.js')).href);
  const history = new HistoryTransactionController(project, path.join(project, '.aily/test-agent-history'));
  const state = history.readDiskFile('project.abi');
  if (hold) history.store.writeSession = () => {
    fs.writeFileSync(path.join(project, '.aily/test-agent-ready'), 'ready');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(project, '.aily/test-agent-release'))) {
      if (Date.now() > deadline) throw new Error('Agent publication test release timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
  try {
    history.executeTransaction([{ path: 'project.abi', ...state }], new Map([['project.abi', state]]), hold ? { nextSession: {} } : {});
    process.stdout.write(JSON.stringify({ status: 'COMMITTED' }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'REJECTED', code: error.code, error: error.message }));
  }
}

async function startAgentPublication(project, agentRoot) {
  const child = spawn(process.execPath, [__filename, project, agentRoot, 'hold'], { windowsHide: true });
  let output = ''; let error = '';
  child.stdout.on('data', value => output += value); child.stderr.on('data', value => error += value);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error || `Agent child exit ${code}`)));
  });
  done.catch(() => {});
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(project, '.aily/test-agent-ready'))) {
    if (child.exitCode !== null) throw new Error(`Agent did not acquire lock: ${output} ${error}`);
    if (Date.now() > deadline) { child.kill(); throw new Error('Agent did not become ready'); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return async () => {
    fs.writeFileSync(path.join(project, '.aily/test-agent-release'), 'release');
    return done;
  };
}

module.exports = { startAgentPublication };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
