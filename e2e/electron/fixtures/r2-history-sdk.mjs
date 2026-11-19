import fs from 'node:fs/promises'
import path from 'node:path'
import {findPackageJSON} from 'node:module'
import {pathToFileURL} from 'node:url'

/** Resolve the actual dependency's public ESM export. createRequire().resolve
 * selects the CJS condition, which this import-only package intentionally lacks. */
export async function loadHistorySdk(agentRoot) {
  const name='@earendil-works/pi-coding-agent'
  const packageFile=findPackageJSON(name,pathToFileURL(path.join(agentRoot,'package.json')).href)
  if(!packageFile)throw Error('The selected SDK has no Pi dependency package')
  const manifest=JSON.parse(await fs.readFile(packageFile,'utf8'))
  const target=manifest.exports?.['.']?.import
  if(manifest.name!==name||typeof target!=='string'||!target.startsWith('./'))
    throw Error('The selected SDK Pi dependency has no supported public import export')
  const entry=pathToFileURL(path.resolve(path.dirname(packageFile),target)).href
  const load=relative=>import(pathToFileURL(path.join(agentRoot,'dist',relative+'.js')).href)
  const [{SessionManager},{WorkspaceHistoryRuntime},{WorkspaceHistoryStore},{createWorkspaceHistoryExtension,latestCheckpoint},{inspectHistoryProgram}]=await Promise.all([
    import(entry),load('extensions/pi-workspace-history/runtime'),load('extensions/pi-workspace-history/store'),
    load('extensions/pi-workspace-history/extension'),load('blockly/services/abs/history-publication')])
  if(typeof SessionManager?.create!=='function'||typeof SessionManager?.open!=='function')throw Error('The actual Pi import lacks SessionManager')
  return {SessionManager,WorkspaceHistoryRuntime,WorkspaceHistoryStore,createWorkspaceHistoryExtension,latestCheckpoint,inspectHistoryProgram,
    dependency:{name:manifest.name,version:manifest.version,entry,condition:'exports[.].import'}}
}

export function wireHistoryLifecycle(sdk,project,manager,onNotice=()=>{}) {
  const history=new sdk.WorkspaceHistoryRuntime(project),handlers=new Map()
  const context={cwd:project,sessionManager:manager,ui:{notify:onNotice}}
  sdk.createWorkspaceHistoryExtension({workspaceHistory:history}).factory({on:(event,handler)=>handlers.set(event,handler),
    appendEntry:(type,data)=>manager.appendCustomEntry(type,data)})
  for(const event of ['session_start','before_agent_start','agent_settled','session_shutdown'])
    if(typeof handlers.get(event)!=='function')throw Error('Actual History lifecycle did not register '+event)
  return {history,handlers,context}
}

export function appendHistoryUserAnchor(manager) {
  manager.appendMessage({role:'user',content:'R2 isolated program history acceptance',timestamp:Date.now()})
  manager.appendMessage({role:'assistant',content:[],api:'openai-responses',provider:'offline-fixture',model:'no-provider-call',stopReason:'stop',timestamp:Date.now(),
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})
}
