const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {test}=require('node:test');
const original=fs.readFileSync(path.join(__dirname,'blockly-simulator-web-publication.test.cjs'),'utf8');
const marker="publicationTest('publication borrows";assert(original.includes(marker));
// Reuse declarations only; none of the old publication cases is registered.
const {subject,fixture,origin,deferred}=new Function('require','__dirname',original.slice(0,original.indexOf(marker))+'\nreturn {subject,fixture,origin,deferred};')(require,__dirname);
async function withOrigin(work){const saved=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{configurable:true,value:{origin}});try{await work();}finally{if(saved)Object.defineProperty(globalThis,'location',saved);else delete globalThis.location;}}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function preparedFixture(){
 const f=fixture(),control={expired:false,currentContext:f.context,contextGate:null,closeFailures:0},counts={prepares:0,finalContexts:0};
 const authority=Object.freeze({activation:f.session.signal,artifact:f.source.artifact,
 requireCurrent(){assert.equal(this,authority);f.scope.requireCurrent();if(control.expired)throw Object.assign(new Error('Original descriptor expired'),{code:'reference-expired'});},
 async readCurrentContext(signal){assert.equal(this,authority);counts.finalContexts++;await control.contextGate?.();return control.currentContext;}});
 f.scope.captureArtifactReadAuthority=function(){assert.equal(this,f.scope);return authority;};
 f.source.preparation=Object.freeze({authority,capturedContext:f.context,artifact:f.source.artifact,prepared:Object.freeze({sameVerifiedSource:true})});
 f.source.prepareArtifact=async signal=>{signal.throwIfAborted();counts.prepares++;};
 f.source.close=async()=>{f.calls.sourceCloses++;f.calls.order.push('source');if(control.closeFailures-->0)throw Error('Original source cleanup unknown');};
 return Object.assign(f,{control,counts,authority,trigger:new AbortController(),consumer:new AbortController()});
}
const bounded={timeout:10000};
test('prewarm invokes the original source before click and one claim adopts exactly that caller',bounded,()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject,f=preparedFixture(),publication=createBlocklySimulatorWebPublication(f.options);
 const warm=publication.preparePublication(f.activation,f.trigger.signal);await warm.ready;
 assert.equal(f.counts.prepares,1);assert.equal(f.calls.opened,1);assert.equal(f.counts.finalContexts,0);assert.equal(warm.snapshot().state,'ready');
 const result=await warm.readPublication(f.activation.path,f.consumer.signal);
 assert.equal(f.calls.opened,1);assert.equal(result.activation.project.store,f.source.store);assert.equal(result.activation.project.artifact,f.source.artifact);
 assert.equal(result.activation.project.preparedArtifact.binding,f.source.preparation);assert.equal(f.counts.finalContexts,1);
 assert.equal(warm.snapshot().triggerSignals,0);assert.equal(warm.snapshot().consumerSignals,1);
 f.trigger.abort();await warm.close();assert.equal(f.calls.sourceCloses,0);assert.equal(result.activation.activation.aborted,false);
 await result.activation.project.ownedStore.close();assert.equal(f.calls.sourceCloses,1);assert.equal(f.calls.scopeCloses,1);assert.equal(warm.snapshot().consumerSignals,0);await publication.close();
}));
test('the local prepared handle is one-shot and cannot serve a second View or Agent caller',bounded,()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject,f=preparedFixture(),publication=createBlocklySimulatorWebPublication(f.options),warm=publication.preparePublication(f.activation,f.trigger.signal);
 const first=warm.readPublication(f.activation.path,f.consumer.signal);await assert.rejects(warm.readPublication(f.activation.path,new AbortController().signal),{code:'prewarm-unavailable'});
 const result=await first;assert.equal(f.calls.opened,1);assert.equal(f.counts.finalContexts,1);await result.activation.project.ownedStore.close();await publication.close();
}));
test('cancelling before a late original scope result joins and retires that exact scope',bounded,()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject,f=preparedFixture(),entered=deferred(),release=deferred();
 f.options.openCurrentProjectScope=async()=>{f.calls.opened++;entered.resolve();await release.promise;return f.scope;};
 const publication=createBlocklySimulatorWebPublication(f.options),warm=publication.preparePublication(f.activation,f.trigger.signal);void warm.ready.catch(()=>{});await entered.promise;
 f.trigger.abort();let closed=false;const closing=warm.close().then(()=>{closed=true;});await turn();assert.equal(closed,false);assert.equal(f.calls.scopeCloses,0);
 release.resolve();await assert.rejects(warm.ready);await closing;assert.equal(f.calls.scopeCloses,1);assert.equal(f.calls.factories.length,0);await publication.close();
}));
test('cancelling a source factory that ignores abort adopts its late source before actual cleanup',bounded,()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject,f=preparedFixture(),entered=deferred(),release=deferred();
 f.module.createHostCallbackProjectSource=async input=>{f.calls.factories.push(input);entered.resolve();await release.promise;return f.source;};
 const publication=createBlocklySimulatorWebPublication(f.options),warm=publication.preparePublication(f.activation,f.trigger.signal);void warm.ready.catch(()=>{});await entered.promise;
 f.trigger.abort();let closed=false;const closing=warm.close().then(()=>{closed=true;});await turn();assert.equal(closed,false);assert.equal(f.calls.sourceCloses,0);
 release.resolve();await assert.rejects(warm.ready);await closing;assert.equal(f.calls.sourceCloses,1);assert.equal(f.calls.scopeCloses,1);await publication.close();
}));
test('claim rechecks the original real-validity capability without renewing an expired descriptor',bounded,()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject,f=preparedFixture(),publication=createBlocklySimulatorWebPublication(f.options),warm=publication.preparePublication(f.activation,f.trigger.signal);
 await warm.ready;f.control.expired=true;await assert.rejects(warm.readPublication(f.activation.path,f.consumer.signal),{code:'reference-expired'});
 assert.equal(f.calls.opened,1);assert.equal(f.counts.prepares,1);assert.equal(f.counts.finalContexts,0);assert.equal(f.calls.sourceCloses,1);await publication.close();
}));
test('claim rejects changed context and a different original project generation',bounded,()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject;
 const f=preparedFixture(),publication=createBlocklySimulatorWebPublication(f.options),warm=publication.preparePublication(f.activation,f.trigger.signal);await warm.ready;
 f.control.currentContext={...f.context,activeArtifactRevision:'b'.repeat(64)};await assert.rejects(warm.readPublication(f.activation.path,f.consumer.signal),{code:'prewarm-unavailable'});
 assert.equal(f.calls.opened,1);assert.equal(f.calls.sourceCloses,1);await publication.close();
 const g=preparedFixture();g.scope.activation={...g.activation,projectSessionId:'different-original-generation'};
 const second=createBlocklySimulatorWebPublication(g.options),wrong=second.preparePublication(g.activation,g.trigger.signal);await assert.rejects(wrong.ready,{code:'prewarm-unavailable'});await wrong.close();
 assert.equal(g.calls.contexts,0);assert.equal(g.calls.scopeCloses,1);await second.close();
}));
test('consumer cancellation after handoff keeps original source cleanup and failed-close retry ownership',bounded,()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject,f=preparedFixture(),publication=createBlocklySimulatorWebPublication(f.options),warm=publication.preparePublication(f.activation,f.trigger.signal);
 await warm.ready;const result=await warm.readPublication(f.activation.path,f.consumer.signal);f.control.closeFailures=1;
 f.consumer.abort();assert.equal(result.activation.activation.aborted,true);await turn();assert.equal(publication.snapshot().retainedCleanupResponsibility,true);
 assert.equal(f.calls.sourceCloses,1);assert.equal(f.calls.scopeCloses,1);await warm.close();assert.equal(f.calls.sourceCloses,1);
 await result.activation.project.ownedStore.close();assert.equal(f.calls.sourceCloses,2);assert.equal(f.calls.scopeCloses,1);assert.equal(warm.snapshot().consumerSignals,0);
 await publication.close();assert.equal(publication.snapshot().retainedCleanupResponsibility,false);
}));
test('legacy normal reads retain sealed fallback while unsupported prewarm closes its original caller',bounded,()=>withOrigin(async()=>{
 const {createBlocklySimulatorWebPublication}=await subject,f=fixture(),normal=createBlocklySimulatorWebPublication(f.options);
 const result=await normal.readPublication(f.activation.path,f.request.signal);assert.equal(result.activation.project.artifact,f.source.artifact);await result.activation.project.ownedStore.close();await normal.close();
 const g=fixture(),publication=createBlocklySimulatorWebPublication(g.options),warm=publication.preparePublication(g.activation,g.request.signal);
 await assert.rejects(warm.ready,{code:'prewarm-unsupported'});await warm.close();assert.equal(g.calls.opened,1);assert.equal(g.calls.sourceCloses,1);assert.equal(g.calls.scopeCloses,1);await publication.close();
 // Controlled capability/activation doubles, not actual Main or a new source bundle.
}));
