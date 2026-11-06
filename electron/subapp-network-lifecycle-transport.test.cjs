'use strict';
// Actual TS controller/port/ProductService/dispatcher and actual compiled Node
// ParentIPC/Broker/producer. TypeScript transpilation stays in this process;
// no esbuild service, sockets, Main, Runtime or MCU is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const main = path.resolve(__dirname, '..');
const sim = process.env.AILY_G2B_SIMULATOR_SOURCE_ROOT || path.resolve(main, '../../simulator/source');
assert(path.isAbsolute(sim));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const protocol = require(sim + '/packages/simulator-protocol/dist/public/host.js');
const TYPES = protocol.SIMULATOR_SUBAPP_HOST_PROVIDER_TRANSPORT_MESSAGE_TYPES;
const sdk = require(main + '/node_modules/@aily-project/simulator-host-sdk/dist/index.js');
function transpile(file) { return ts.transpileModule(fs.readFileSync(file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText; }
const loaded = new Map();
function pureTs(relative) {
 const file = path.join(main,relative); if(loaded.has(file)) return loaded.get(file).exports;
 const mod = new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(main);loaded.set(file,mod);
 mod.require=name=>{
  if(name==='@aily-project/simulator-protocol/host') return protocol;
  if(name.startsWith('.')) { const candidate=path.resolve(path.dirname(file),name)+'.ts';if(fs.existsSync(candidate))return pureTs(path.relative(main,candidate)); }
  return require(name);
 };
 mod._compile(transpile(file),file);return mod.exports;
}
const {SubappWorkspaceHostProviderController}=pureTs('src/app/services/integrations/subapps/host-provider/subapp-workspace-host-provider-controller.ts');
const {createWorkspaceNetworkLifecycle}=pureTs('src/app/services/integrations/subapps/host-provider/subapp-workspace-network-lifecycle.ts');
const dispatcher=pureTs('src/app/services/integrations/subapps/host-provider/subapp-host-provider-dispatcher.ts');
const productFile=path.join(main,'src/app/integrations/simulator/simulator-host-provider-product.service.ts');
const pm=new Module(productFile,module);pm.filename=productFile;pm.paths=Module._nodeModulePaths(main);
pm.require=name=> name==='@angular/core'?{Injectable:()=>value=>value,NgZone:class{}}:
 name==='@integration/subapps/public-api'?dispatcher:name==='@aily-project/simulator-host-sdk'?sdk:
 new Proxy({}, {get:()=>function inertProductConstructorDependency(){}});
pm._compile(transpile(productFile),productFile);
const {SimulatorSubappHostProviderParentIpc}=require(sim+'/packages/simulator-gateway/dist/simulator-subapp-host-provider-parent-ipc.js');
const {SimulatorSubappHostProviderState}=require(sim+'/packages/simulator-gateway/dist/simulator-subapp-host-provider-state.js');
const {SimulatorSubappHostProviderInvocationBroker}=require(sim+'/packages/simulator-gateway/dist/simulator-subapp-host-provider-invocation-broker.js');
const {createBrowserProjectLocalNetwork}=require(sim+'/packages/simulator-gateway/dist/browser-project-local-network.js');
const {SimulatorSubappHostNetworkBindingIpc}=require(sim+'/packages/simulator-gateway/dist/simulator-subapp-host-network-binding-ipc.js');
const {isProductionHostCleanupMessage}=require(sim+'/packages/simulator-gateway/dist/production-parent-ipc-shutdown.js');
const scope={viewId:'view.original',sessionId:'session.original',sceneRevision:'a'.repeat(64)};
const grant=()=>({schemaVersion:1,kind:'aily-host-connectivity-grant',grantId:'grant.original',backendId:'backend.original',capability:'network.ip',profileId:'wifi-functional-host-ip-v1',executionId:'execution.original',executionLocation:'user-device',resourceLocation:'user-device',permissionAuthority:'local-user',scope:{sessionId:scope.sessionId,sceneRevision:scope.sceneRevision,worldId:'world-main',nodeId:'node-main',clockDomainId:'clock-main',runtimeGeneration:4,coreGeneration:9,timeEpoch:7,connectionEpoch:3},expiresAtUnixMs:1,resourceIds:['peer']});
const state=(host='simulator-host:workspace:test:1')=>({schemaVersion:1,kind:'aily-host-network-binding-lifecycle',hostInstanceId:host,revision:1,phase:'closing',selection:{requestId:'select.original',requestSequence:1},grant:protocol.hostNetworkGrantIdentityV1(grant())});
const closeResult=original=>({schemaVersion:1,kind:'aily-host-network-binding-close-result',hostInstanceId:original.hostInstanceId,selection:original.selection,grant:original.grant,state:'closed'});
async function fixture(t) {
 const h={sent:[],main:[],contexts:[],raw:[],closeGate:null,selectGate:null,failure:false,requests:[],currentBinding:null};let producer;
 const providerState=new SimulatorSubappHostProviderState({requestId:'g2b.composition',network:true});
 const parent=new SimulatorSubappHostProviderParentIpc({providerState,networkCloseWaitMs:1000,send:message=>{h.raw.push(message);controller.receive({toolId:'simulator',streamId:'stream.original',message});},onNetworkBindingLifecycle:value=>{producer?.observeBindingLifecycle(value);}});
 const broker=new SimulatorSubappHostProviderInvocationBroker({providerState,transport:parent});
 producer=createBrowserProjectLocalNetwork({hostSnapshot:()=>providerState.snapshot(),subscribeHost:listener=>providerState.subscribe(listener),closeOriginalBinding:value=>parent.closeOriginalNetworkBinding(value),async invoke(request,signal){const result=await broker.invoke({provider:'network',capability:'network.ip',payload:request},{signal});if(result.status!=='succeeded')throw Error('normal result failed');return result.payload;}});
 const service=Object.create(pm.exports.SimulatorHostProviderProductService.prototype);service.openCurrentProjectScope=async()=>null;
 const controller=new SubappWorkspaceHostProviderController({instanceId:'workspace:test',port:{
  async bindMessageController(input){h.currentBinding=input;return {success:true};},
  async unbindMessageController(){return {success:true};},
  async sendMessage(input){h.sent.push(input);parent.handleMessage(input.message);return {success:true};},
  async localNetwork(input){h.main.push(input);if(input.action==='cancel')return {ok:true,completionConfirmed:false};if(input.action==='close'){if(h.closeGate)await h.closeGate.promise;if(h.failure) return {ok:false,closed:false};return {ok:true,closed:true};}
   const request=input.request;h.requests.push(request);const result={schemaVersion:1,kind:'aily-host-network-provider-result',requestId:request.requestId,requestSequence:request.requestSequence,operation:request.operation,...(request.operation==='select'?{ok:true,outcome:'selected',grant:grant()}:request.operation==='release'?{ok:true,state:'released',releasedGrants:1}:{ok:true,catalog:{schemaVersion:1,kind:'aily-host-connectivity-catalog',hostInstanceId:'inner.catalog',backends:[]}})};
   if(request.operation==='select'&&h.selectGate)await h.selectGate.promise;return result;
  },
 },registry:{hasRegistration:()=>true,async open(context){h.contexts.push(context);return service.open(context);}}});
 await controller.update('project.original',[{toolId:'simulator',streamId:'stream.original',running:true,messagePort:{}}]);
 parent.publishNegotiationRequest();for(let n=0;n<8;n++){await tick();await parent.whenIdle();}
 assert.equal(providerState.snapshot().negotiation.hostInstanceId,'simulator-host:workspace:test:1');
 h.emit=(revision=1,phase='closing',changes={})=>{const req=h.requests.find(x=>x.operation==='select');const raw={...h.currentBinding,revision,phase,selection:{requestId:req.requestId,requestSequence:req.requestSequence},grant:protocol.hostNetworkGrantIdentityV1(grant()),...changes};controller.networkBindingState(raw);return raw;};
 t.after(async()=>{h.closeGate?.resolve();h.selectGate?.resolve();h.failure=false;await controller.close();broker.close();parent.close();await producer.dispose().catch(()=>{});});
 return {h,parent,broker,producer,controller,providerState};
}
test('actual Product dispatcher catalog id maps Main tuple to synchronous same-producer state and original close',async t=>{
 const {h,producer}=await fixture(t);assert((await producer.request('select',scope)).ok);const host=producer.snapshot().hostInstanceId;
 h.emit();await tick();assert.equal(producer.readLifecycle(scope).binding.hostInstanceId,host);assert.notEqual(host,h.currentBinding.bindingId);
 assert.equal(producer.snapshot().bindingLifecyclePhase,'closing');assert.equal((await producer.request('select',scope)).errorCode,'busy');
 h.closeGate=deferred();let done=false;const closing=producer.close(scope).then(()=>done=true);await tick();assert.equal(done,false);assert.equal(h.main.filter(x=>x.action==='close').length,1);
 assert.equal(h.requests.length,1,'no ordinary release/request sequence after fencing');h.closeGate.resolve();await closing;assert.equal(producer.snapshot().ownsSelection,false);assert.equal(h.raw.filter(x=>x.type===TYPES.networkBindingClose).length,1);
});
test('pending actual select cannot project Connected when sidecar arrives before its late result',async t=>{
 const {h,producer}=await fixture(t);h.selectGate=deferred();const selecting=producer.request('select',scope);while(!h.requests.length)await tick();h.emit();await tick();
 assert.equal(producer.readLifecycle(scope).selectionState,'pending');h.selectGate.resolve();const result=await selecting;assert.equal(result.ok,false);assert(!('grant'in result));await producer.close(scope);assert.equal(h.requests.length,1);
});
test('original expired identity survives controller no-longer-running; failed close retains explicit retry',async t=>{
 const {h,producer,controller}=await fixture(t);await producer.request('select',scope);h.emit();await tick();h.failure=true;
 await assert.rejects(controller.update('project.original',[{toolId:'simulator',streamId:'stream.original',running:false,messagePort:{}}]));
 await assert.rejects(producer.close(scope),/cleanup-unconfirmed/);assert.equal(producer.snapshot().ownsSelection,true);
 // Nonterminal does not force current Core/availability checks; original close
 // uses cleanup:true even when the ordinary controller guard would reject.
 const beforeRetry=h.main.filter(x=>x.action==='close').length;h.failure=false;await producer.close(scope);assert.equal(h.main.filter(x=>x.action==='close').length,beforeRetry+1);assert(h.main.filter(x=>x.action==='close').every(x=>x.bindingId===h.currentBinding.bindingId));assert.equal(h.requests.length,1);assert.equal(controller.snapshot()[0].ready,false);
});
test('foreign/stale tuple and full-scope close do not reach original Main resource',async t=>{
 const {h,producer,controller}=await fixture(t);await producer.request('select',scope);h.emit(1,'closing',{bindingId:'foreign'});await tick();assert.equal(producer.readLifecycle(scope),null);
 h.emit();await tick();const original=producer.readLifecycle(scope).binding;
 for(const mutate of [v=>v.hostInstanceId='foreign',v=>v.grant.scope.timeEpoch++,v=>v.selection.requestSequence++]){
  const value=structuredClone(original);mutate(value);controller.receive({toolId:'simulator',streamId:'stream.original',message:{type:TYPES.networkBindingClose,version:1,requestId:'foreign.close',original:value}});
 }
 await tick();assert.equal(h.main.filter(x=>x.action==='close').length,0);await producer.close(scope);
});
test('unknown close delivery/observer timeout retains one flight and late full ACK joins without resend',async()=>{
 const sent=[];const ipc=new SimulatorSubappHostNetworkBindingIpc({send:msg=>{sent.push(msg);throw Error('delivery unknown');},closeWaitMs:2});const original=state();
 await assert.rejects(ipc.closeOriginalBinding(original),/cleanup-unconfirmed/);assert.equal(ipc.snapshot().pendingOriginalCloses,1);assert.equal(ipc.snapshot().pendingObservers,0);
 const retry=ipc.closeOriginalBinding({...original,revision:2,phase:'cleanup-unconfirmed'});assert.equal(sent.length,1);
 ipc.handleMessage({type:TYPES.networkBindingCloseResult,version:1,requestId:sent[0].requestId,outcome:{ok:true,result:closeResult(original)}});
 assert.deepEqual(await retry,closeResult(original));assert.equal(ipc.snapshot().pendingOriginalCloses,0);ipc.close();
});
test('nonterminal/foreign result cannot ACK; explicit known failure permits only same cleanup lane retry',async()=>{
 const sent=[];const ipc=new SimulatorSubappHostNetworkBindingIpc({send:msg=>sent.push(msg),closeWaitMs:100});const original=state();const closing=ipc.closeOriginalBinding(original);
 ipc.handleMessage({type:TYPES.networkBindingCloseResult,version:1,requestId:sent[0].requestId,outcome:{ok:true,result:original}});assert.equal(ipc.snapshot().pendingOriginalCloses,1);
 ipc.handleMessage({type:TYPES.networkBindingCloseResult,version:1,requestId:sent[0].requestId,outcome:{ok:false,errorCode:'cleanup-unconfirmed'}});await assert.rejects(closing,/cleanup-unconfirmed/);
 const retry=ipc.closeOriginalBinding(original);assert.equal(sent.length,2);ipc.handleMessage({type:TYPES.networkBindingCloseResult,version:1,requestId:sent[1].requestId,outcome:{ok:true,result:closeResult(original)}});await retry;ipc.close();
});
test('retained Workspace state replays after failed push before related ordinary completion',async()=>{
 const sent=[];let fail=true;const lifecycle=createWorkspaceNetworkLifecycle({hostInstanceId:state().hostInstanceId,closeOriginal:async()=>{},async send(value){if(fail)throw Error('push unavailable');sent.push(value);}});
 assert(lifecycle.observe(state()));await tick();assert.equal(lifecycle.snapshot().submittedRevision,0);fail=false;await lifecycle.flush();assert.equal(sent.length,1);assert.equal(sent[0].state.revision,1);
 assert.equal(lifecycle.observe({...state(),revision:2,grant:{...state().grant,grantId:'foreign'}}),false);assert.equal(lifecycle.snapshot().retained.revision,1);
});
test('shutdown allowlist admits only validated exact original binding cleanup, never a state or ordinary request',()=>{
 const value={type:TYPES.networkBindingClose,version:1,requestId:'network-binding-close:1',original:state()};assert.equal(isProductionHostCleanupMessage(value),true);
 assert.equal(isProductionHostCleanupMessage({...value,original:{...state(),phase:'released'}}),false);assert.equal(isProductionHostCleanupMessage({...value,extra:true}),false);assert.equal(isProductionHostCleanupMessage({type:TYPES.networkBindingState,version:1,state:state()}),false);
});

test('original cleanup flights remain bounded after unknown delivery and cannot be evicted by later identities',async()=>{
 const sent=[];const ipc=new SimulatorSubappHostNetworkBindingIpc({send:value=>sent.push(value),closeWaitMs:1});
 const pending=Array.from({length:64},(_,index)=>ipc.closeOriginalBinding({...state(),hostInstanceId:`host.${index}`}));
 await Promise.allSettled(pending);assert.equal(ipc.snapshot().pendingOriginalCloses,64);
 await assert.rejects(ipc.closeOriginalBinding({...state(),hostInstanceId:'host.overflow'}),/capacity/);assert.equal(sent.length,64);
 const first=sent[0];const joining=ipc.closeOriginalBinding(first.original);assert.equal(sent.length,64);
 ipc.handleMessage({type:TYPES.networkBindingCloseResult,version:1,requestId:first.requestId,outcome:{ok:true,result:closeResult(first.original)}});
 await joining;assert.equal(ipc.snapshot().pendingOriginalCloses,63);ipc.close();
});
test('actual Main IPC forwards only original sender state and exposes preload sidecar listener',async()=>{
 const file=path.join(main,'electron/subapp-network-main-ipc.js');const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(main);
 let ownerOptions,installed;const messages=[];let mainWindow={isDestroyed:()=>false,webContents:{id:7,isDestroyed:()=>false,send:(...args)=>messages.push(args)}};
 mod.require=name=>{
  if(name==='./subapp-network-host-config')return {CONFIG_FILE_NAME:'inert.json',readMainNetworkHostConfiguration:async()=>({resources:[{endpointId:'peer',label:'Peer',detail:'Pure only',transports:['tcp'],recordTypes:['A']}]})};
  if(name==='./subapp-network-provider-owner')return {createMainNetworkProviderOwner:options=>{ownerOptions=options;return {bind:async()=>null,dispose:async()=>{}};}};
  return require(name.startsWith('.')?path.join(main,'electron',name):name);
 };
 mod._compile(fs.readFileSync(file,'utf8'),file);
 const host=mod.exports.registerConfiguredMainNetworkHostHandlers({ipcMain:{handle(){}},app:{getPath:()=>'/not-read/pure'},dialog:{showMessageBox:async()=>({response:0})},getMainWindow:()=>mainWindow,requireController(){},installHost:value=>installed=value,prepareLaunch:async()=>{},MessageChannelMain:class{},resolveOriginalOwnerNetworkControl:async()=>null,loadProtocol:async()=>({...require(sim+'/packages/simulator-protocol/dist/connectivity-network-provider.js'),...require(sim+'/packages/simulator-protocol/dist/connectivity-host.js')})});
 while(!ownerOptions)await tick();const original=state();ownerOptions.onBindingState({authority:{senderId:8,toolId:'simulator',streamId:'original',bindingId:'binding'},...original});assert.equal(messages.length,0);
 ownerOptions.onBindingState({authority:{senderId:7,toolId:'simulator',streamId:'original',bindingId:'binding'},revision:original.revision,phase:original.phase,selection:original.selection,grant:original.grant});
 assert.equal(messages.length,1);assert.equal(messages[0][0],'subapp-local-network-binding-state');assert.equal(messages[0][1].bindingId,'binding');assert(!('hostInstanceId' in messages[0][1]));assert(!('senderId' in messages[0][1]));
 assert.match(fs.readFileSync(path.join(main,'electron/preload.js'),'utf8'),/onNetworkBindingState:[\s\S]*?ipcRenderer.on\('subapp-local-network-binding-state'/);
 assert.equal(installed,host);await host.dispose();
});

test('Host sidecar processes synchronously ahead of generic ingress work and bounded observers release on timeout',async()=>{
 const providerState=new SimulatorSubappHostProviderState({requestId:'synchronous.sidecar',network:true});const observed=[];
 const parent=new SimulatorSubappHostProviderParentIpc({providerState,send(){},onNetworkBindingLifecycle:value=>observed.push(value)});
 assert(parent.handleMessage({type:TYPES.networkBindingState,version:1,state:state()}));assert.equal(observed.length,1,'not deferred behind ingressQueue');
 parent.handleMessage({type:TYPES.networkBindingState,version:1,state:{...state(),phase:'released'}});assert.equal(observed.length,1);parent.close();
 const ipc=new SimulatorSubappHostNetworkBindingIpc({send(){},closeWaitMs:3});const observers=Array.from({length:64},()=>ipc.closeOriginalBinding(state()));
 await assert.rejects(ipc.closeOriginalBinding(state()),/observer capacity/);assert.equal(ipc.snapshot().pendingObservers,64);
 await Promise.allSettled(observers);assert.equal(ipc.snapshot().pendingObservers,0);assert.equal(ipc.snapshot().pendingOriginalCloses,1);ipc.close();
});
