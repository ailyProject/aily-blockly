import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [agentRoot, project, profileRoot, report] = process.argv.slice(2)
assert.ok([agentRoot,project,profileRoot,report].every(path.isAbsolute))
process.env.PI_CODING_AGENT_DIR = profileRoot
const load = name => import(pathToFileURL(path.join(agentRoot, 'dist', name + '.js')).href)
const { WorkspaceHistoryRuntime } = await load('extensions/pi-workspace-history/runtime')
const { createBlocklyWorkspaceHistorySynchronizer } = await load('blockly/workspace-history-sync')
const { createBlocklyToolRegistry } = await load('blockly/tools/registry')
const { AbsWorkflowGuard } = await load('blockly/abs-workflow-guard')
const { registerLibInstallLocal } = await load('blockly/tools/registrars/library/lib-install-local')
const { registerLibRemove } = await load('blockly/tools/registrars/library/lib-remove')
const history = new WorkspaceHistoryRuntime(project, createBlocklyWorkspaceHistorySynchronizer())
const registry = createBlocklyToolRegistry(project, history, 'blockly')
const context={registry,workspace:project,workspaceHistory:history,absWorkflow:new AbsWorkflowGuard()}
registerLibRemove(context);registerLibInstallLocal(context)
let outcome = {}
const dependency = '@aily-project/lib-save-c'
const manifest = () => JSON.parse(fs.readFileSync(path.join(project,'package.json'),'utf8'))
try {
  await history.begin(undefined)
  const result = await registry.definitions().find(tool=>tool.name==='lib_remove').execute({project,packages:[dependency]})
  const structured = result.details?.result ?? JSON.parse(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'))
  assert.equal(structured.ok,true,JSON.stringify(structured))
  assert.equal(manifest().dependencies[dependency],undefined)
  const checkpoint = await history.finalize()
  assert.ok(checkpoint)
  outcome = {result:structured,checkpoint}
  const session = checkpoint.historySessionId ?? checkpoint.sessionId
  const turn = checkpoint.turnIndex
  await history.revertTurn(session,turn)
  assert.ok(manifest().dependencies[dependency])
  outcome.undo = {abi:JSON.parse(fs.readFileSync(path.join(project,'project.abi'),'utf8')),dependencies:manifest().dependencies}
  await history.reapplyTurn(session,turn)
  assert.equal(manifest().dependencies[dependency],undefined)
  outcome.redo = {abi:JSON.parse(fs.readFileSync(path.join(project,'project.abi'),'utf8')),dependencies:manifest().dependencies}
  const source=path.join(profileRoot,'external-library-b'), installed='@aily-project/lib-save-b';
  fs.cpSync(path.join(project,'local-libraries','b'),source,{recursive:true});
  await history.begin(checkpoint);
  const installation=await registry.definitions().find(tool=>tool.name==='lib_install_local').execute({project,source});
  const installedResult=installation.details?.result??JSON.parse(installation.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
  assert.equal(installedResult.ok,true,JSON.stringify(installedResult));
  assert.ok(fs.existsSync(path.join(project,'node_modules',installed,'src','Save.h')));
  assert.ok(fs.lstatSync(path.join(project,'node_modules',installed)).isSymbolicLink(),'Local library must remain linked to its canonical source');
  const installedCheckpoint=await history.finalize();
  outcome.install={result:installedResult,checkpoint:installedCheckpoint};
  await history.revertTurn(installedCheckpoint.historySessionId,installedCheckpoint.turnIndex);
  assert.equal(manifest().dependencies[installed],undefined);
  outcome.installUndo={abi:JSON.parse(fs.readFileSync(path.join(project,'project.abi'),'utf8')),dependencies:manifest().dependencies};
  await history.reapplyTurn(installedCheckpoint.historySessionId,installedCheckpoint.turnIndex);
  assert.ok(manifest().dependencies[installed]);
  assert.ok(fs.existsSync(path.join(project,'node_modules',installed,'src','Save.h')));
  assert.ok(fs.lstatSync(path.join(project,'node_modules',installed)).isSymbolicLink(),'Local library must remain linked to its canonical source');
  outcome.installRedo={abi:JSON.parse(fs.readFileSync(path.join(project,'project.abi'),'utf8')),dependencies:manifest().dependencies};
} catch(error) { outcome.error = error.stack; throw error }
finally {fs.writeFileSync(report,JSON.stringify(outcome,null,2));await history.dispose()}
