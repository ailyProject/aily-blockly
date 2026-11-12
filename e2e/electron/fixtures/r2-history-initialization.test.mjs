import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import nativeFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {randomUUID} from 'node:crypto'
import test from 'node:test'

import {loadHistorySdk,wireHistoryLifecycle,appendHistoryUserAnchor} from './r2-history-sdk.mjs'
import {historyFieldPlans,historyExpectedDocument,pendingHistoryStep} from './r2-history-document.mjs'
import {installHistoryPublicationFault} from './r2-history-publication-fault.mjs'
import {indexCustomerProject} from './customer-project-baseline-case.mjs'
import {sha,documentHash} from './r1-customer-native.mjs'

const agent=process.env.AILY_R2_INITIALIZATION_AGENT_ROOT
const projects=JSON.parse(process.env.AILY_R2_INITIALIZATION_PROJECTS??'[]')
const evidence={qualification:'No Electron, HOST, model or native publication; actual compiled SDK, Pi JSONL, History Runtime/Store/Worker, document oracles and transparent HTTP observer construction.',rows:[]}
test.after(async()=>{if(process.env.AILY_R2_INITIALIZATION_RECEIPT)await fs.writeFile(process.env.AILY_R2_INITIALIZATION_RECEIPT,JSON.stringify(evidence,null,2)+'\n')})

for(const[name,input]of projects)test(`no-HOST initialization uses actual ESM Pi, Runtime/Store/Worker, JSONL and ${name} document fixtures`,{skip:!agent},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'aily-r2-history-init-'))
  const prior={PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR,AILY_PORTABLE_ROOT:process.env.AILY_PORTABLE_ROOT}
  let wired
  try{
    process.env.PI_CODING_AGENT_DIR=path.join(root,'agent');delete process.env.AILY_PORTABLE_ROOT
    const project=path.join(root,'project');await fs.mkdir(project)
    const sourceBefore={}
    for(const file of ['project.abi','project.abs','project.abs.map.json','package.json','package-lock.json','.npmrc']){
      try{const bytes=await fs.readFile(path.join(input,file));sourceBefore[file]=sha(bytes);await fs.writeFile(path.join(project,file),bytes)}
      catch(error){if(error.code!=='ENOENT'||['project.abi','project.abs'].includes(file))throw error}
    }
    const sdk=await loadHistorySdk(agent),document=JSON.parse(await fs.readFile(path.join(project,'project.abi'),'utf8'))
    assert.equal(sdk.dependency.condition,'exports[.].import')
    const active=document.pages.find(page=>page.id===document.activePageId)
    assert.ok(active)
    const visible=[...indexCustomerProject({...document,pages:[active]}).keys()],plans=historyFieldPlans(document,visible)
    assert.notEqual(plans.A.blockId,plans.C.blockId)
    const withA=historyExpectedDocument(document,plans.A,plans.A.valueA),withAC=historyExpectedDocument(withA,plans.C,plans.C.valueA)
    assert.equal(indexCustomerProject(withAC).get(plans.A.blockId).fields.NUM,plans.A.valueA)
    assert.equal(indexCustomerProject(withAC).get(plans.C.blockId).fields.NUM,plans.C.valueA)
    assert.equal(withAC.pages.length,document.pages.length)
    assert.deepEqual(withAC.sharedModel,document.sharedModel)
    const manager=sdk.SessionManager.create(project,path.join(root,'sessions'));appendHistoryUserAnchor(manager)
    wired=wireHistoryLifecycle(sdk,project,manager)
    const store=new sdk.WorkspaceHistoryStore(project,path.join(project,'.workspace-history'))
    await wired.handlers.get('session_start')({},wired.context)
    await wired.handlers.get('before_agent_start')({},wired.context)
    assert.equal(wired.history.hasActiveTurn,true)
    const source=await fs.readFile(path.join(project,'project.abs'))
    assert.ok(source.equals(await fs.readFile(path.join(wired.history.executionRoot,'project.abs'))))
    for(const method of ['adoptAbsRepair','revertTurn','reapplyTurn','dispose'])assert.equal(typeof wired.history[method],'function')
    await fs.writeFile(path.join(wired.history.executionRoot,'smoke-note.txt'),'ordinary smoke note\n')
    await wired.handlers.get('agent_settled')({},wired.context)
    assert.equal(wired.history.hasActiveTurn,false)
    const checkpoint=sdk.latestCheckpoint(manager,undefined,project)
    assert.ok(checkpoint?.checkpointId&&!checkpoint.checkpointId.startsWith('noop:'))
    const commit=store.readCommit(checkpoint.checkpointId)
    assert.ok(commit.changes.some(change=>change.path==='smoke-note.txt'))
    const sessionFile=manager.getSessionFile()
    assert.ok((await fs.readFile(sessionFile,'utf8')).includes(checkpoint.checkpointId))
    const reopened=sdk.SessionManager.open(sessionFile)
    assert.deepEqual(sdk.latestCheckpoint(reopened,undefined,project),checkpoint)
    await wired.history.dispose();wired=wireHistoryLifecycle(sdk,project,reopened)
    await wired.handlers.get('session_start')({},wired.context)
    await wired.handlers.get('before_agent_start')({},wired.context)
    assert.ok(source.equals(await fs.readFile(path.join(wired.history.executionRoot,'project.abs'))))
    await wired.history.abort();assert.equal(wired.history.hasActiveTurn,false)
    const requestId='pub2-'+randomUUID(),transaction={id:'smoke-only-pending-shape',status:'prepared',programNavigation:{steps:[{state:'dispatched',request:{requestId},executorPid:process.pid}]}}
    assert.deepEqual(pendingHistoryStep([transaction]),{transactionId:transaction.id,requestId,executorPid:process.pid})
    assert.throws(()=>pendingHistoryStep([transaction,transaction]))
    for(const[file,hash]of Object.entries(sourceBefore))assert.equal(sha(await fs.readFile(path.join(input,file))),hash,'Original input remains readonly')
    evidence.rows.push({name,ok:true,dependency:sdk.dependency,checkpoint:true,actualJsonl:true,actualCompiledWorker:true,privateSourceHash:sha(source),documentHash:documentHash(document),pages:document.pages.length,guiOraclePlans:plans,originalInputUnchanged:true})
  }finally{
    await wired?.history.dispose()
    for(const[key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value
    assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('aily-r2-history-init-'))
    await fs.rm(root,{recursive:true,force:true})
  }
})

test('no-HOST fixture installs the actual transparent history HTTP observer without replacing a result or requiring a terminal',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'aily-r2-history-fault-init-')),project=path.join(root,'aily-project/dev-tests/project')
  const prior=process.env.AILY_APPDATA_PATH
  let server,installed=false
  try{
    await fs.mkdir(project,{recursive:true});const appData=path.join(root,'appdata');await fs.mkdir(appData)
    process.env.AILY_APPDATA_PATH=appData
    server=http.createServer(async(request,response)=>{for await(const chunk of request){void chunk}response.setHeader('content-type','application/json');response.end('{"ok":false,"code":"NO_NATIVE_TERMINAL_IN_SETUP_SMOKE"}')})
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    const requestId='pub2-'+randomUUID(),proofFile=path.join(path.dirname(project),'r2-history-fault-0.json')
    assert.equal(installHistoryPublicationFault(undefined,JSON.stringify({pid:process.pid,project,appData,port:server.address().port,proofFile,expectedDocument:{pages:[]}})).available,true)
    installed=true
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/command',{method:'POST',body:JSON.stringify({action:'blockly-live-operation',operation:'abs_recovery',path:project,
      params:{action:'history_publish',requestId,history:{id:'smoke-only',candidate:{hash:'sha256:'+'1'.repeat(64),bytes:1}}}})})
    assert.equal((await response.json()).code,'NO_NATIVE_TERMINAL_IN_SETUP_SMOKE')
    const snapshot=globalThis.__ailyR2HistoryFault.snapshot()
    assert.equal(snapshot.commands.length,1);assert.equal(snapshot.requestId,requestId);assert.equal(snapshot.drops,0);assert.deepEqual(snapshot.failures,[])
    assert.ok(nativeFs.existsSync(proofFile))
    evidence.rows.push({name:'transparent-observer-construction',ok:true,realLocalHttp:true,host:false,terminalFabricated:false,drops:0})
  }finally{
    if(installed){globalThis.__ailyR2HistoryFault.restore();delete globalThis.__ailyR2HistoryFault}
    server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve))
    if(prior===undefined)delete process.env.AILY_APPDATA_PATH;else process.env.AILY_APPDATA_PATH=prior
    assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('aily-r2-history-fault-init-'))
    await fs.rm(root,{recursive:true,force:true})
  }
})
