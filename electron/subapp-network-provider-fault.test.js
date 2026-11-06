'use strict';
// Actual Main owner + common MessagePort server/client. Injected private control,
// in-memory linked EventEmitters and inert provider/driver only. No OS/Electron,
// real chooser/permission, socket, Core/MCU, Main launch or product acceptance.
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const path=require('node:path');const {pathToFileURL}=require('node:url');
const {createMainNetworkProviderOwner}=require('./subapp-network-provider-owner');
const {adaptMainNetworkMessagePort}=require('./subapp-network-installed-backend');
// Test loader only: use a separately frozen/built shared workspace after integration.
const sharedSourceRoot=process.env.AILY_NETWORK_G1_SHARED_SOURCE_ROOT??path.resolve(__dirname,'../../../simulator/source');
const common=import(pathToFileURL(path.join(sharedSourceRoot,'packages/simulator-connectivity/dist/index.js')).href);
const deferred=()=>Promise.withResolvers(),turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<150;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('controlled boundary not reached');}
const request=(sequence,operation='catalog')=>({schemaVersion:1,kind:'aily-host-network-provider-request',requestId:'request-'+sequence,requestSequence:sequence,operation});
async function fixture(options={}){
 const api=await common,calls=[],states=[],terminals=[],channels=[],attachments=[],servers=[],callbacks=new Set();
 const authority=Object.freeze({senderId:7,toolId:'simulator',streamId:'original-stream',bindingId:'workspace:1'});
 const scope={sessionId:'session',sceneRevision:'a'.repeat(64),worldId:'world',nodeId:'node',clockDomainId:'clock',runtimeGeneration:1,coreGeneration:2,timeEpoch:3,connectionEpoch:4};
 const descriptor={schemaVersion:1,kind:'aily-host-network-backend',backendId:'aily.local-network.ip.v1',capability:'network.ip',executionLocation:'user-device',resourceLocation:'user-device',permissionAuthority:'local-user',availability:'available',permissionState:'granted',unavailableReason:null,protocols:['tcp','udp','dns'],ipVersions:[4,6],limits:{maxLeases:8,maxPendingRequests:16,maxQueuedRecords:128,maxQueuedBytes:65536,maxReadRecords:32,maxReadBytes:4096,maxPayloadBytes:4096,idleTimeoutMs:30000}};
 const grant=number=>({schemaVersion:1,kind:'aily-host-connectivity-grant',grantId:'grant-'+number,backendId:descriptor.backendId,capability:'network.ip',profileId:'wifi-functional-host-ip-v1',executionId:'execution',executionLocation:'user-device',resourceLocation:'user-device',permissionAuthority:'local-user',scope,expiresAtUnixMs:Date.now()+60000,resourceIds:['peer']});
 class Port extends EventEmitter{
  closed=false;sent=[];start(){}
  postMessage(value){calls.push(['reply-or-request',value.operation,value.ok]);if(options.dropAck&&value.operation==='dispose'&&value.ok!==undefined)throw Error('controlled ACK lost');this.sent.push(value);queueMicrotask(()=>{if(!this.peer.closed)this.peer.emit('message',{data:structuredClone(value)});});}
  close(){if(!this.closed){this.closed=true;this.emit('close');}}
 }
 class Channel{constructor(){this.port1=new Port();this.port2=new Port();this.port1.peer=this.port2;this.port2.peer=this.port1;channels.push(this);}}
 const module={HOST_NETWORK_MESSAGE_PORT_DISPOSAL_SETTLEMENT_VERSION:options.oldApi?undefined:api.HOST_NETWORK_MESSAGE_PORT_DISPOSAL_SETTLEMENT_VERSION,
  HOST_NETWORK_MESSAGE_PORT_TERMINAL_RESULT_SETTLEMENT_VERSION:options.oldApi?undefined:api.HOST_NETWORK_MESSAGE_PORT_TERMINAL_RESULT_SETTLEMENT_VERSION,
  HOST_CONNECTIVITY_LIMITS:descriptor.limits,validateHostNetworkBackendDescriptorV1:value=>value,validateSessionNetworkContextSnapshot:value=>value,validateHostConnectivityScopeV1:value=>value,
  createNodeHostNetworkDriver(){calls.push('driver-create');return{async dispose(){calls.push('driver-dispose');}};},
  createNodeHostNetworkProvider(){calls.push('provider-create');return{bind(input){let closed=false;const unsubscribe=input.registerOwnerRelease(async()=>{closed=true;unsubscribe();});return{
   async request(value,signal){calls.push(['request',value.operation,value.requestSequence]);await input.trustedCurrentContextAsync(signal);if(value.operation==='select')return{schemaVersion:1,kind:'aily-host-network-provider-result',requestId:value.requestId,requestSequence:value.requestSequence,ok:true,operation:'select',outcome:'selected',grant:grant(value.requestSequence)};return{ok:true,operation:value.operation};},
   acquireGrantBackend(id){calls.push(['grant-acquire',id]);let retired=false;return{descriptor,async execute(){throw Error('No business I/O in this pure fixture');},async dispose(){calls.push(['grant-dispose',id]);if(!retired){await options.grantDispose?.();retired=true;}}};},
   async close(){if(closed)return;calls.push('binding-close');await options.bindingClose?.();closed=true;unsubscribe();}
  };},async dispose(){calls.push('provider-dispose');await options.providerDispose?.();}};},
  serveHostNetworkMessagePort(input){const actual=api.serveHostNetworkMessagePort(input);servers.push({actual,input});return{...actual,close(){calls.push('server-owner-close');return actual.close();}};}};
 const control={requireCurrent(){},async query(){calls.push('query');return{sessionId:scope.sessionId,sceneRevision:scope.sceneRevision,runtimeGeneration:scope.runtimeGeneration,sessionState:'running',network:{descriptor:{executionId:'execution',scope:{worldId:scope.worldId,nodeId:scope.nodeId,clockDomainId:scope.clockDomainId}},snapshot:{state:'open',generation:scope.coreGeneration,timeEpoch:scope.timeEpoch,connectionEpoch:scope.connectionEpoch}}};},
  async attach(input,remotePort){calls.push(['attach',input.grant.grantId]);const backend=api.createHostNetworkMessagePortBackend({port:adaptMainNetworkMessagePort(remotePort),descriptor:input.descriptor,grant:input.grant,timeoutMs:options.timeoutMs??100});attachments.push({input,backend});await options.attach?.();},
  async detach(sessionId,id){calls.push(['detach',sessionId,id]);const original=attachments.find(value=>value.input.grant.grantId===id);assert(original);await original.backend.dispose();await options.detach?.();},
  registerOwnerRelease(callback){callbacks.add(callback);return()=>callbacks.delete(callback);}};
 let manager;manager=createMainNetworkProviderOwner({configuration:{endpoints:[],routes:[{endpointId:'peer',tcpPort:18080,udpPort:18081}]},MessageChannelMain:Channel,
  loadBackend:async()=>{calls.push('load');return{module,async release(){calls.push('holder-release');await options.holderRelease?.();}};},resolveOriginalOwnerNetworkControl:async()=>control,
  onBindingState(value){states.push(value);return options.onBindingState?.(value);},onBindingRetired(value){terminals.push(value);calls.push('terminal');}});
 const bind=(selected=authority)=>manager.bind({authority:selected,requireCurrentController(){},selection:{}});
 return{manager,bind,calls,states,terminals,channels,attachments,servers,callbacks,authority,scope,grant};
}
test('missing settlement API rejects before driver/provider/grant/channel/transfer and actually releases original holder',async()=>{
 const f=await fixture({oldApi:true});assert.equal(await f.bind(),null);assert.deepEqual(f.calls,['load','holder-release']);assert.equal(f.channels.length,0);assert.equal(f.attachments.length,0);assert.equal(f.states.length,0);assert.equal(f.terminals.length,0);await f.manager.dispose();
});
test('old API holder release failure retains exact quarantine owner for explicit retry without a never-existing hook wait',async()=>{
 let fail=true;const f=await fixture({oldApi:true,holderRelease:async()=>{if(fail)throw Error('held old-module holder');}}),port=await f.bind();assert(port);await assert.rejects(port.request(request(1)),/fenced/);await assert.rejects(port.close(),/old-module holder/);fail=false;await port.close();assert.equal(f.calls.filter(x=>x==='load').length,1);assert.equal(f.channels.length,0);assert.equal(f.terminals.length,0);await f.manager.dispose();
});
test('expected grant release preserves producer sequence and does not emit fault or terminal state',async()=>{
 const f=await fixture(),port=await f.bind(),signal=new AbortController().signal;await port.request(request(1,'select'),signal);await port.request(request(2,'release'),signal);await port.request(request(3),signal);
 assert.deepEqual(f.calls.filter(x=>Array.isArray(x)&&x[0]==='request').map(x=>x.slice(1)),[['select',1],['release',2],['catalog',3]]);assert.deepEqual(f.states,[]);assert.deepEqual(f.terminals,[]);assert(!f.calls.includes('holder-release'));await port.close();assert.equal(f.terminals.length,1);await f.manager.dispose();
});
test('spontaneous disposal fences immediately, waits actual grant ACK then joins exact Runtime/server/holder before terminal event',async()=>{
 const close=deferred(),detach=deferred(),holder=deferred();const f=await fixture({grantDispose:()=>close.promise,detach:()=>detach.promise,holderRelease:()=>holder.promise}),port=await f.bind();await port.request(request(1,'select'),new AbortController().signal);
 const remote=f.attachments[0].backend.dispose();await until(()=>f.states.length===1);assert.equal(f.states[0].phase,'closing');assert.equal(f.states[0].revision,1);assert.deepEqual(f.states[0].authority,f.authority);assert.deepEqual(f.states[0].selection,{requestId:'request-1',requestSequence:1});assert.deepEqual(f.states[0].grant,{grantId:'grant-1',backendId:'aily.local-network.ip.v1',executionId:'execution',profileId:'wifi-functional-host-ip-v1',scope:f.scope});assert(Object.isFrozen(f.states[0])&&Object.isFrozen(f.states[0].grant.scope));
 await assert.rejects(port.request(request(2,'select'),new AbortController().signal),/owner ended/);assert(!f.calls.some(x=>Array.isArray(x)&&x[0]==='detach'));assert.equal(f.terminals.length,0);assert(!f.channels[0].port1.closed);
 close.resolve();await remote;await until(()=>f.calls.some(x=>Array.isArray(x)&&x[0]==='detach'));assert.equal(f.terminals.length,0);assert(!f.calls.includes('server-owner-close'));
 detach.resolve();await until(()=>f.calls.includes('holder-release'));assert.equal(f.terminals.length,0);holder.resolve();await port.close();assert.equal(f.terminals.length,1);assert.equal(f.calls.at(-1),'terminal');assert(f.channels.every(c=>c.port1.closed&&c.port2.closed));await f.manager.dispose();
});
test('reentrant state callback returning original close cannot self-wait or close before dispose response submission',async()=>{
 let port;const close=deferred(),f=await fixture({grantDispose:()=>close.promise,onBindingState:()=>port.close()});port=await f.bind();await port.request(request(1,'select'),new AbortController().signal);
 const remote=f.attachments[0].backend.dispose();await until(()=>f.states.length===1);assert(!f.calls.some(x=>Array.isArray(x)&&x[0]==='detach'));close.resolve();await remote;await port.close();assert.equal(f.terminals.length,1);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='detach').length,1);await f.manager.dispose();
});
test('lost grant ACK keeps original attachment and cleanup-unconfirmed; exact close retry uses same owner with no selection replay',async()=>{
 const options={dropAck:true,timeoutMs:20},f=await fixture(options),port=await f.bind();await port.request(request(1,'select'),new AbortController().signal);
 await assert.rejects(f.attachments[0].backend.dispose(),/cleanup-unconfirmed/);await until(()=>f.states.at(-1)?.phase==='cleanup-unconfirmed');assert.equal(f.terminals.length,0);assert(!f.calls.includes('holder-release'));assert(!f.channels[0].port1.closed);
 options.dropAck=false;await port.close();assert.deepEqual(f.states.map(x=>x.phase),['closing','cleanup-unconfirmed','closing']);assert.deepEqual(f.states.map(x=>x.revision),[1,2,3]);assert.equal(f.terminals.length,1);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='grant-acquire').length,1);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='request'&&x[1]==='select').length,1);await f.manager.dispose();
});
test('actual holder close rejection retains fenced original close handle and emits no early terminal event',async()=>{
 let fail=true;const f=await fixture({holderRelease:async()=>{if(fail)throw Error('actual holder failed');}}),port=await f.bind();await port.request(request(1,'select'),new AbortController().signal);await f.attachments[0].backend.dispose();await until(()=>f.states.at(-1)?.phase==='cleanup-unconfirmed');assert.equal(f.terminals.length,0);await assert.rejects(port.request(request(2),new AbortController().signal),/owner ended/);fail=false;await port.close();assert.equal(f.terminals.length,1);await f.manager.dispose();
});
test('old expected attachment disposal and settlement cannot fence a new grant or a successor binding',async()=>{
 const f=await fixture(),signal=new AbortController().signal,old=await f.bind();await old.request(request(1,'select'),signal);const predecessor=f.servers[0];await old.request(request(2,'release'),signal);await old.request(request(3,'select'),signal);
 await predecessor.input.backend.dispose();predecessor.input.onDisposeSettled({cause:'remote-dispose',requestId:99,cleanupConfirmed:true,responseSubmitted:true});await turn();assert.equal(f.states.length,0);assert.equal(f.attachments[1].backend.snapshot().retired,false);await old.close();
 const successor=await f.bind({...f.authority,bindingId:'workspace:2'});await successor.request(request(1,'select'),signal);const count=f.terminals.length;predecessor.input.onDisposeSettled({cause:'transport-fault',cleanupConfirmed:true,responseSubmitted:false});await turn();assert.equal(f.terminals.length,count);assert.equal(f.states.length,0);assert.equal(f.attachments[2].backend.snapshot().retired,false);await successor.close();await f.manager.dispose();
});
test('CLI-style cause-undeclared normal grant ending closes honestly without an error phase or automatic selection',async()=>{
 const f=await fixture(),port=await f.bind();await port.request(request(1,'select'),new AbortController().signal);
 // Runtime lifecycle may dispose its grant without a Main-before-detach label.
 // This pure vector deliberately supplies no invented hardware/network cause.
 await f.attachments[0].backend.dispose();await port.close();assert.deepEqual(f.states.map(x=>x.phase),['closing']);assert.equal(f.terminals.length,1);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='request'&&x[1]==='select').length,1);assert.equal(f.calls.filter(x=>x==='load').length,1);assert.equal(f.channels.length,1);await f.manager.dispose();
});
test('transport-ended original grant joins real detach and emits terminal only after the same original owner is gone',async()=>{
 const f=await fixture(),port=await f.bind();await port.request(request(1,'select'),new AbortController().signal);
 f.servers[0].input.port.onmessageerror();await until(()=>f.terminals.length===1);assert.deepEqual(f.states.map(x=>x.phase),['closing']);assert.equal(f.attachments[0].backend.snapshot().retired,true);await port.close();assert.equal(f.terminals.length,1);await f.manager.dispose();
});
test('late completed predecessor disposal/handoff cannot retire or publish state for successor original binding',async()=>{
 const f=await fixture(),signal=new AbortController().signal,old=await f.bind();await old.request(request(1,'select'),signal);const previous=f.servers[0];await f.attachments[0].backend.dispose();await old.close();assert.equal(f.terminals.length,1);
 const current=await f.bind({...f.authority,bindingId:'workspace:2'});await current.request(request(1,'select'),signal);const states=f.states.length;await previous.input.backend.dispose();previous.input.onDisposeSettled({cause:'remote-dispose',requestId:500,cleanupConfirmed:true,responseSubmitted:true});await turn();assert.equal(f.states.length,states);assert.equal(f.terminals.length,1);assert.equal(f.attachments[1].backend.snapshot().retired,false);await current.close();assert.equal(f.terminals.length,2);await f.manager.dispose();
});
test('existing exact Main close IPC joins retained undeclared cleanup even after controller end; foreign tuple cannot reuse receipt',async()=>{
 const {createMainNetworkHostBoundary}=require('./subapp-network-host-boundary');const {createMainNetworkEndpointSelection}=require('./subapp-network-endpoint-selection');
 const root=path.join(sharedSourceRoot,'packages/simulator-protocol/dist');const protocol={...await import(pathToFileURL(root+'/connectivity-network-provider.js')),...await import(pathToFileURL(root+'/connectivity-host.js'))};
 const options={dropAck:true,timeoutMs:20},f=await fixture(options),sender={id:7,mainFrame:{},isDestroyed:()=>false},main={webContents:sender,isDestroyed:()=>false},event={sender,senderFrame:sender.mainFrame};let controller=true;
 const selection=createMainNetworkEndpointSelection({resources:[{endpointId:'peer',label:'Pure peer',detail:'Inert fixture',transports:['tcp','udp'],recordTypes:['A']}],showChooser:async()=>({outcome:'cancelled'})});
 const boundary=createMainNetworkHostBoundary({protocol,getMainWindow:()=>main,requireController(){if(!controller)throw Error('controller ended');},selection,resolveOriginalOwnerNetworkPort:input=>f.manager.bind(input)});
 const tuple={toolId:'simulator',streamId:'original-stream',bindingId:'workspace:1'};
 const selected=await boundary.invoke(event,{action:'request',...tuple,request:request(1,'select')});assert.equal(selected.ok,true);assert.equal(selected.outcome,'selected');
 await assert.rejects(f.attachments[0].backend.dispose(),/cleanup-unconfirmed/);await until(()=>f.states.at(-1)?.phase==='cleanup-unconfirmed');controller=false;options.dropAck=false;
 const result=await boundary.invoke(event,{action:'close',...tuple});assert.deepEqual(result,{ok:true,closed:true});assert.equal(f.terminals.length,1);assert.equal(boundary.snapshot().bindings,0);
 const foreign=await boundary.invoke(event,{action:'close',...tuple,bindingId:'workspace:foreign'});assert.equal(foreign.errorCode,'permission-denied');assert.equal(f.terminals.length,1);await boundary.dispose();await f.manager.dispose();
});

test('concurrent undeclared disposal and original owner release join the same held Runtime detach before terminal cleanup',async()=>{
 const backend=deferred(),detach=deferred();let detachConfirmed=false;
 const f=await fixture({grantDispose:()=>backend.promise,detach:async()=>{await detach.promise;detachConfirmed=true;}}),port=await f.bind();
 await port.request(request(1,'select'),new AbortController().signal);
 const remote=f.attachments[0].backend.dispose();await until(()=>f.states.length===1);
 const release=[...f.callbacks][0]();await until(()=>f.calls.some(x=>Array.isArray(x)&&x[0]==='detach'));
 const explicit=port.close();let explicitDone=false;void explicit.then(()=>{explicitDone=true;});
 backend.resolve();await remote;await turn();await turn();
 assert.equal(detachConfirmed,false);assert.equal(explicitDone,false);assert.equal(f.terminals.length,0);
 assert.equal(f.channels[0].port1.closed,false); // The actual remote client may close its own port after its real dispose ACK.
 assert(!f.calls.includes('server-owner-close'));assert(!f.calls.includes('holder-release'));assert.equal(f.callbacks.size,1);
 assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='detach').length,1);
 detach.resolve();await Promise.all([release,explicit]);
 assert.equal(detachConfirmed,true);assert.equal(f.terminals.length,1);assert.equal(f.callbacks.size,0);
 assert.deepEqual(f.states.map(x=>x.phase),['closing']);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='detach').length,1);
 await f.manager.dispose();
});
test('concurrent original detach rejection remains unconfirmed without auto retry and explicit same-owner retry needs its real ACK',async()=>{
 const backend=deferred(),first=deferred(),second=deferred();let attempts=0;
 const f=await fixture({grantDispose:()=>backend.promise,detach:()=>++attempts===1?first.promise:second.promise}),port=await f.bind();
 await port.request(request(1,'select'),new AbortController().signal);
 const remote=f.attachments[0].backend.dispose();await until(()=>f.states.length===1);
 const release=[...f.callbacks][0]();const releaseFailed=assert.rejects(release,/unconfirmed/);
 await until(()=>f.calls.some(x=>Array.isArray(x)&&x[0]==='detach'));backend.resolve();await remote;await until(()=>attempts===1);await turn();
 first.reject(Error('actual original detach failed'));
 await releaseFailed;await until(()=>f.states.at(-1)?.phase==='cleanup-unconfirmed');await turn();
 assert.equal(attempts,1);assert.equal(f.terminals.length,0);assert.equal(f.callbacks.size,1);
 assert.equal(f.channels[0].port1.closed,false); // The actual remote client may close its own port after its real dispose ACK.
 assert(!f.calls.includes('server-owner-close'));assert(!f.calls.includes('holder-release'));
 let retried=false;const retry=port.close().then(()=>{retried=true;});await until(()=>attempts===2);await turn();
 assert.equal(retried,false);assert.equal(f.terminals.length,0);assert.equal(f.channels[0].port1.closed,false);
 second.resolve();await retry;assert.equal(f.terminals.length,1);assert.equal(f.callbacks.size,0);
 assert.deepEqual(f.states.map(x=>x.phase),['closing','cleanup-unconfirmed','closing']);
 assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='request'&&x[1]==='select').length,1);
 assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='grant-acquire').length,1);
 await f.manager.dispose();
});
