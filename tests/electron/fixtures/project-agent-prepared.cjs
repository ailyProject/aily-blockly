const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fork } = require('node:child_process');

// Test-only process: exercise real Agent service/operations modules, not a simulated writer.
async function run() {
  const [project, agentRoot] = process.argv.slice(2);
  const load = relative => import(pathToFileURL(path.join(agentRoot, 'dist', relative)).href);
  const { runWithBlocklyWorkspace } = await load('blockly/workspace-context.js');
  const { absExport } = await load('blockly/services/abs/conversion.js');
  const { absImport } = await load('blockly/services/abs/import.js');
  const { createTools } = await load('tools/create-tools.js');
  const history = { executionRoot: project, mapWorkspacePath: p => p, mapWorkspaceReadPath: p => p, toWorkspacePath: p => p };
  const tools = createTools(project, history, { allowsApprovedExternalPath: () => false }, []);
  const read = tools.find(tool => tool.name === 'read'); const write = tools.find(tool => tool.name === 'write');
  const abi = fs.readFileSync(path.join(project, 'project.abi'), 'utf8');
  await read.execute('prepare-version', { path: 'project.abi' }, undefined, undefined, {});
  const result = await runWithBlocklyWorkspace(project, project, () => ({
    exported: absExport(project),
    imported: absImport(project, '# Project Data Schema: 1 (external-only)\n', { writeAbs: true })
  }));
  const timeout = setTimeout(() => { console.error('Prepared Agent test release timed out'); process.exit(1); }, 30000);
  process.once('message', async () => {
    clearTimeout(timeout);
    try {
      await write.execute('stale-version', { path: 'project.abi', content: abi }, undefined, undefined, {});
      process.send({ type: 'result', status: 'COMMITTED' });
    } catch (error) {
      process.send({ type: 'result', status: 'REJECTED', error: error.message });
    } finally { process.disconnect(); }
  });
  process.send({ type: 'ready', ...result });
}

async function startPreparedAgent(project, agentRoot) {
  const child = fork(__filename, [project, agentRoot], { windowsHide: true, silent: true });
  let stderr = ''; child.stderr.on('data', value => stderr += value); child.stdout.resume();
  let resolveReady; let rejectReady; let resolveResult; let rejectResult;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {});
  const fail = error => { rejectReady(error); rejectResult(error); };
  child.on('error', fail);
  child.on('exit', code => { if (code !== 0) fail(new Error(stderr || `Prepared Agent child exit ${code}`)); });
  child.on('message', message => {
    if (message.type === 'ready') resolveReady(message);
    if (message.type === 'result') resolveResult(message);
  });
  // Cold imports of the actual tool registry can exceed 15s on a busy development machine.
  const timeout = setTimeout(() => { fail(new Error(`Prepared Agent did not become ready: ${stderr || 'no stderr'}`)); child.kill(); }, 45000);
  try {
    const prepared = await ready;
    return { prepared, release: async () => { child.send({ release: true }); return result; },
      close: () => { if (child.exitCode === null) child.kill(); } };
  } catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timeout); }
}

module.exports = { startPreparedAgent };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
