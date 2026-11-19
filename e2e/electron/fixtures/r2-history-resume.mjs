import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {loadHistorySdk} from './r2-history-sdk.mjs'
import {historyExpectedDocument} from './r2-history-document.mjs'
import {sha,documentHash} from './r1-customer-native.mjs'

// Test-only continuation of the exact preserved suite after the pre-fault
// Playwright setup crash. This never selects a new navigation goal or publishes.
export async function loadHistoryResume({resultFile,testRoot,projectInput,agentRoot,hostHash,caseName}) {
  assert.ok(path.isAbsolute(resultFile))
  const raw=await fs.readFile(resultFile),previous=JSON.parse(raw)
  assert.equal(previous.ok,false);assert.equal(previous.case,caseName)
  assert.equal(previous.hostHash,hostHash)
  assert.equal(previous.phases.at(-1)?.name,'second-undo-terminal-genuine-COMMITTED-response-lost')
  assert.equal(previous.launches.length,1)
  assert.equal(previous.undoRedo?.undo?.ok,true);assert.equal(previous.undoRedo?.redo?.ok,true)
  assert.ok(previous.undoRedo.undo.nativeHistory&&previous.undoRedo.redo.nativeHistory)
  assert.equal(previous.undoRedo.unrelatedCPreserved,true)
  assert.equal(previous.pending,undefined);assert.equal(previous.sdkOwnerStop,undefined)
  const suite=path.resolve(previous.suite),project=path.join(suite,'project')
  assert.equal(path.dirname(suite).toLowerCase(),path.resolve(testRoot).toLowerCase())
  assert.ok(path.basename(suite).startsWith(`r2-customer-history-${caseName}-`))
  assert.equal(path.resolve(previous.project).toLowerCase(),project.toLowerCase())
  for(const directory of [suite,project,path.join(suite,'sdk-sessions'),path.join(project,'.workspace-history')]) {
    const stat=await fs.lstat(directory)
    assert.ok(stat.isDirectory()&&!stat.isSymbolicLink())
    assert.equal((await fs.realpath(directory)).toLowerCase(),directory.toLowerCase())
  }
  for(const name of ['r2-history-fault-0.json','r2-history-fault-1.json'])
    await assert.rejects(fs.stat(path.join(suite,name)),{code:'ENOENT'},'The old run must not have installed its fault')
  assert.equal(previous.agentBefore.length,8)
  for(const module of previous.agentBefore)
    assert.equal(sha(await fs.readFile(path.join(agentRoot,'dist',module.name+'.js'))),module.sha256,'The resumed run must use the original sealed SDK')
  const original=JSON.parse(await fs.readFile(path.join(projectInput,'project.abi'),'utf8'))
  const expectedA=historyExpectedDocument(original,previous.plans.A,previous.plans.A.valueA)
  const expectedAC=historyExpectedDocument(expectedA,previous.plans.C,previous.plans.C.valueA)
  const expectedC=historyExpectedDocument(original,previous.plans.C,previous.plans.C.valueA)
  assert.equal(documentHash(expectedAC),previous.undoRedo.redoFullDocumentHash)
  assert.equal(documentHash(expectedC),previous.undoRedo.undoFullDocumentHash)
  assert.equal(documentHash(JSON.parse(await fs.readFile(path.join(project,'project.abi'),'utf8'))),documentHash(expectedAC))
  const sdk=await loadHistorySdk(agentRoot),store=new sdk.WorkspaceHistoryStore(project,path.join(project,'.workspace-history'))
  const checkpoint=previous.historyCommit.checkpoint
  assert.equal(path.resolve(checkpoint.workspaceRoot).toLowerCase(),project.toLowerCase())
  const sessions=(await fs.readdir(path.join(suite,'sdk-sessions'))).filter(name=>name.endsWith('.jsonl'))
  assert.equal(sessions.length,1)
  const sessionFile=path.join(suite,'sdk-sessions',sessions[0]),sessionRaw=await fs.readFile(sessionFile)
  const entries=sessionRaw.toString('utf8').trim().split('\n').map(line=>JSON.parse(line))
  assert.equal(entries.length,4)
  assert.equal(path.resolve(entries[0].cwd).toLowerCase(),project.toLowerCase())
  assert.equal(entries[1].message.role,'user');assert.equal(entries[2].message.role,'assistant')
  assert.equal(entries[2].parentId,entries[1].id);assert.equal(entries[3].parentId,entries[2].id)
  assert.equal(entries[3].customType,'aily.workspace-history');assert.deepEqual(entries[3].data,checkpoint)
  const manager=sdk.SessionManager.open(sessionFile)
  assert.deepEqual(sdk.latestCheckpoint(manager,undefined,project),checkpoint,'Restore the exact original JSONL checkpoint, not latest across sessions')
  const session=store.readSession(checkpoint.historySessionId)
  assert.equal(session.commits.length,1)
  assert.equal(session.commits[0].commitId,checkpoint.checkpointId)
  assert.equal(session.commits[0].active,true);assert.equal(session.commits[0].reverted,false)
  assert.equal(store.listTransactions().length,0,'No second undo was dispatched before the setup crash')
  assert.equal((await fs.readdir(path.join(project,'.workspace-history/overlays'))).length,0)
  await assert.rejects(fs.stat(path.join(project,'.aily/abs-sync/prepared.json')),{code:'ENOENT'})
  const commit=store.readCommit(checkpoint.checkpointId),program=commit.changes.find(change=>change.path==='project.abs')
  assert.equal(program.beforeHash,previous.historyCommit.before);assert.equal(program.afterHash,previous.historyCommit.after)
  for(const hash of [program.beforeHash,program.afterHash])assert.equal(sha(store.readBlob(hash)),hash)
  const audits=store.listCommitIds().map(id=>store.readCommit(id)).flatMap(record=>record.programPublications??[])
  for(const completed of [previous.undoRedo.undo,previous.undoRedo.redo]){
    assert.equal(completed.nativeHistory.completed,true);assert.equal(completed.nativeHistory.requests.length,1)
    const matches=audits.filter(item=>item.request?.requestId===completed.nativeHistory.requests[0])
    assert.equal(matches.length,1);assert.equal(matches[0].state,'completed')
    assert.equal(matches[0].result.publication.status,'COMMITTED')
  }
  const redo=audits.find(item=>item.request?.requestId===previous.undoRedo.redo.nativeHistory.requests[0])
  const binding=redo.result.projectionReceipt.output.binding
  const attachment=redo.result.publicationObservation.attachment
  assert.equal(path.resolve(attachment.root).toLowerCase(),project.toLowerCase())
  const beforeRoot=await fs.lstat(project,{bigint:true}),handle=await fs.open(project,'r')
  let physical
  try{
    physical=await handle.stat({bigint:true});const afterRoot=await fs.lstat(project,{bigint:true})
    assert.ok(physical.isDirectory())
    for(const root of [beforeRoot,afterRoot]){
      assert.ok(root.isDirectory()&&!root.isSymbolicLink());assert.equal(root.ino,physical.ino);assert.equal(root.birthtimeNs,physical.birthtimeNs)
      if(root.dev!==0n)assert.equal(root.dev,physical.dev)
    }
    assert.deepEqual(attachment.identity,{dev:String(physical.dev),ino:String(physical.ino),birthtimeNs:String(physical.birthtimeNs)})
  }finally{await handle.close()}
  for(const[name,key]of [['project.abi','abiHash'],['project.abs','absHash'],['project.abs.map.json','mapHash']])
    assert.equal('sha256:'+sha(await fs.readFile(path.join(project,name))),binding[key])
  const pointer=JSON.parse(await fs.readFile(path.join(project,'.aily/abs-sync/committed.json'),'utf8'))
  assert.equal(pointer.generation,binding.generation)
  assert.equal(pointer.hash,'sha256:'+sha(await fs.readFile(path.join(project,'.aily/abs-sync/baselines',pointer.generation+'.json'))))
  const mirrorNames=['project.abi','project.abs','project.abs.map.json','.aily/abs-sync/committed.json']
  const mirrors=await Promise.all(mirrorNames.map(async name=>({name,sha256:sha(await fs.readFile(path.join(project,name)))})))
  return {previous,suite,project,sdk,store,manager,sessionFile,checkpoint,original,expectedAC,expectedC,session,mirrors,
    provenance:{resultFile,resultSha256:sha(raw),sessionFile,sessionSha256:sha(sessionRaw),suite,checkpointId:checkpoint.checkpointId,
      resumedStage:'second-undo-terminal-genuine-COMMITTED-response-lost',reusedVerifiedUndoRedo:true,replayedVerifiedUndoRedo:false,
      originalResultModified:false,preFaultInstalled:false,originalSdkHashes:previous.agentBefore,originalHostHash:hostHash,
      originalPhysicalAttachment:attachment,originalUserEntryId:entries[1].id,originalCheckpointEntryId:entries[3].id,mirrorsBeforeLaunch:mirrors}}
}
