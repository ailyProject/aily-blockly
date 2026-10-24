const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const old=fs.readFileSync(path.join(__dirname,'blockly-simulator-web-publication.test.cjs'),'utf8');
const marker="publicationTest('publication borrows";
assert(old.includes(marker));
// Reuse only the original controlled fixture declarations, not its old tests.
const {subject,fixture,origin,deferred}=new Function('require','__dirname',old.slice(0,old.indexOf(marker))+'\nreturn {subject,fixture,origin,deferred};')(require,__dirname);
async function withOrigin(work){const before=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{configurable:true,value:{origin}});
 try{await work();}finally{if(before)Object.defineProperty(globalThis,'location',before);else delete globalThis.location;}}
function prepare(f){
 let captured=null,prepared=false;
 f.scope.captureArtifactReadAuthority=function(input){assert.equal(this,f.scope);assert.equal(input.artifact,f.source.artifact);captured=Object.freeze({activation:f.session.signal,artifact:input.artifact,requireCurrent(){f.scope.requireCurrent();},async readCurrentContext(){return f.context;}});return captured;};
 f.module.createHostCallbackProjectSource=async input=>{f.calls.factories.push(input);const authority=input.capturePreparationAuthority({context:f.context,descriptor:{originalReference:true},artifact:f.source.artifact,activation:input.activation});
 f.source.preparation=Object.freeze({authority,capturedContext:f.context,artifact:f.source.artifact,prepared:Object.freeze({originalPreparedPool:true})});
 f.source.prepareArtifact=async signal=>{signal.throwIfAborted();f.calls.order.push('prepare');prepared=true;};return f.source;};
 return{get authority(){return captured;},get prepared(){return prepared;}};
}
test('publication prepares under the exact original project-read scope then forwards the unchanged same-owner sideband',()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject,f=fixture(),control=prepare(f),publication=createBlocklySimulatorWebPublication(f.options);
 const result=await publication.readPublication(f.activation.path,f.request.signal),project=result.activation.project;
 assert.equal(control.prepared,true);assert.equal(project.artifact,f.source.artifact);assert.equal(project.preparedArtifact.binding,f.source.preparation);
 assert.equal(project.preparedArtifact.authority,control.authority);assert.equal(project.preparedArtifact.context,f.context);assert(Object.isFrozen(project.preparedArtifact));
 assert.equal('Runtime' in project,false);assert.equal('Session' in project,false);assert.deepEqual(f.calls.order,['prepare']);
 await project.ownedStore.close();assert.deepEqual(f.calls.order,['prepare','source','scope']);await publication.close();assert.equal(publication.snapshot().retainedCleanupResponsibility,false);
}));
test('cancelled preparation retains and joins its original source and scope before publication cleanup completes',()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject,f=fixture();prepare(f);const entered=deferred(),release=deferred();
 const originalFactory=f.module.createHostCallbackProjectSource.bind(f.module);f.module.createHostCallbackProjectSource=async input=>{const source=await originalFactory(input);
 source.prepareArtifact=async()=>{entered.resolve();await release.promise;};return source;};
 const publication=createBlocklySimulatorWebPublication(f.options),reading=publication.readPublication(f.activation.path,f.request.signal);void reading.catch(()=>{});await entered.promise;
 f.request.abort();let closed=false;const closing=publication.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(f.calls.sourceCloses,0);
 release.resolve();await assert.rejects(reading);await closing;assert.equal(f.calls.sourceCloses,1);assert.equal(f.calls.scopeCloses,1);assert.equal(publication.snapshot().retainedCleanupResponsibility,false);
}));

test('legacy GS-shaped source with both preparation feature fields absent keeps the original sealed path',()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject,f=fixture();
 f.scope.captureArtifactReadAuthority=function(){throw Error('A legacy source must not invent a TTL capability');};
 const publication=createBlocklySimulatorWebPublication(f.options),result=await publication.readPublication(f.activation.path,f.request.signal);
 assert.equal(result.activation.project.artifact,f.source.artifact);assert.equal('preparedArtifact' in result.activation.project,false);
 assert.equal(f.calls.factories.length,1);assert.equal(typeof f.calls.factories[0].capturePreparationAuthority,'function');
 await result.activation.project.ownedStore.close();assert.deepEqual(f.calls.order,['source','scope']);await publication.close();
 // This is an exact old return-shape fixture, not actual frozen GS browser acceptance.
}));
