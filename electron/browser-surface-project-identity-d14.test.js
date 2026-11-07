'use strict';
// Actual captured Angular TS projections/Controller/BrowserSurface/Presentation/UI completion.
// Only native process/View endpoints and dependency injection are inert memory doubles.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const main=process.env.AILY_D14_MAIN_SOURCE_ROOT||path.resolve(__dirname,'..'),ts=require(main+'/node_modules/typescript');
const sim=process.env.AILY_NETWORK_TEST_PROTOCOL_ROOT||path.resolve(main,'../../simulator/source'),protocol=require(sim+'/packages/simulator-protocol/dist/public/host.js');
const noop=()=>{},decorator=()=>noop,unknown=new Proxy(function inertDependency(){},{get:()=>function inertDependency(){}});
class Emitter{values=[];emit(value){this.values.push(value);}}
class Subject{constructor(value){this.value=value;}next(value){this.value=value;}asObservable(){return this;}subscribe(){return{unsubscribe(){}};}}
const core={Injectable:()=>x=>x,Component:()=>x=>x,Input:decorator,Output:decorator,ViewChild:decorator,Optional:decorator,Inject:decorator,EventEmitter:Emitter};
const loaded=new Map();function actualTs(relative){const file=path.join(main,relative);if(loaded.has(file))return loaded.get(file).exports;const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(main);loaded.set(file,m);m.require=id=>{if(id==='@angular/core')return core;if(id==='rxjs')return{BehaviorSubject:Subject,Subject,Subscription:class{add(){}unsubscribe(){}},merge:()=>({subscribe:()=>({unsubscribe(){}})})};if(id==='@aily-project/simulator-protocol/host')return protocol;if(id.endsWith('configs/tool.config'))return{getChildToolConfig:()=>({runtime:{browserExecution:{}},ui:{surfaces:{full:{entry:'index.html'}}}})};if(id.startsWith('.')){const p=path.resolve(path.dirname(file),id)+'.ts';if(/subapp-workspace-(host-provider-controller|network-lifecycle|network-controller-port)\.ts$/.test(p)||/subapp-owner-guard\.ts$/.test(p)||/subapp-browser-(presentation|surface)\.service\.ts$/.test(p))return actualTs(path.relative(main,p));}return unknown;};m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText,file);return m.exports;}
const root='src/app/services/integrations/subapps/';
const{SubappWorkspaceHostProviderService}=actualTs(root+'host-provider/subapp-workspace-host-provider.service.ts'),{SubappWorkspaceHostProviderController}=actualTs(root+'host-provider/subapp-workspace-host-provider-controller.ts'),{SubappBrowserPresentationService}=actualTs(root+'subapp-browser-presentation.service.ts'),{SubappBrowserSurfaceService}=actualTs(root+'subapp-browser-surface.service.ts'),{ChildToolBrowserSurfaceComponent}=actualTs('src/app/tools/child-tool-browser-surface/child-tool-browser-surface.component.ts'),{ChildToolHostComponent}=actualTs('src/app/tools/child-tool-host/child-tool-host.component.ts'),{UiService}=actualTs('src/app/services/core/app-shell/ui.service.ts');
const facts=[];const project=()=>({currentProjectPath:'/original-project',isProjectOpening:false,code:false,loaded:true,isAilyCodeProject(){return this.code;},getBlocklyProjectLoadStatus(){return{ready:this.loaded};}});
function projection(p=project(),registered=true){const registry={hasRegistration:()=>registered},s=new SubappWorkspaceHostProviderService(registry,p),h=Object.create(ChildToolHostComponent.prototype);Object.assign(h,{currentUrl:'/main',toolId:'simulator',resolvedToolId:'simulator',workspaceHostProviders:s,standaloneWorkspace:undefined});return{p,s,h};}
async function borrowedFixture(t){const q=projection(),trace=[],gate=Promise.withResolvers(),bindingInputs=[];let shouldHold=false,refs=1,ownerAlive=true;const old={window:global.window,document:global.document,setTimeout:global.setTimeout,clearTimeout:global.clearTimeout};const runtimeId='11111111-1111-1111-1111-111111111111',connectionId='22222222-2222-2222-2222-222222222222';global.window={innerWidth:1000,innerHeight:800,electronAPI:{childToolSession:{async superviseOwner(x){trace.push('supervision:'+x.action);return{ok:true,generation:'generation'};},async browserExecution(x){trace.push('browser:'+x.action);if(x.action==='bindProcess')return{endpoint:{kind:'browser-message-port',runtimeId},connectionId};if(x.action==='openView')return{executionId:runtimeId,connectionId,presentation:'embedded'};if(x.action==='closeView')return{detached:true,physicalClosed:true};if(x.action==='updateView')return{updated:true};throw Error('Unexpected memory View command');}}}};global.document={visibilityState:'visible'};global.setTimeout=()=>1;global.clearTimeout=noop;
 const runtime={toolId:'simulator',streamId:'stream.original',running:true,messagePort:{}},controller=new SubappWorkspaceHostProviderController({instanceId:'workspace.original',port:{async bindMessageController(x){bindingInputs.push(x);return{success:true};},async unbindMessageController(){trace.push('provider-unbind');return{success:true};},async sendMessage(){return{success:true};}},registry:{hasRegistration:()=>true,async open(){return{async close(){trace.push('provider-close-entered');if(shouldHold)await gate.promise;trace.push('provider-close-returned');}};}}});q.s.controller=controller;q.s.runtimes=[runtime];await controller.update(q.p.currentProjectPath,[runtime]);q.s.readyBaseWorkspaceSubject.next(q.p.currentProjectPath);
 const ui=Object.create(UiService.prototype);Object.assign(ui,{openToolList:['simulator'],toolPresentationIds:{},actionSubject:{next:x=>trace.push('UI:'+x.action)}});const presentations=new SubappBrowserPresentationService(),ticket=presentations.prepare('simulator','agent-original',()=>assert.equal(ownerAlive,true));ui.toolPresentationIds.simulator=ticket.id;presentations.registerMount('simulator',ticket.id,()=>{trace.push('original-ticket-completed');ui.completeToolPresentationClose('simulator',ticket.id);});const surfaces=new SubappBrowserSurfaceService({async acquire(){refs++;trace.push('process-acquire');return{pid:1,url:'memory-only'};},async release(){refs--;trace.push('process-release');}},presentations),surface=new ChildToolBrowserSurfaceComponent({nativeElement:{getBoundingClientRect:()=>({left:0,top:0,right:200,bottom:100,width:200,height:100})}},surfaces);Object.assign(surface,{toolId:'simulator',presentationId:ticket.id,workspace:q.h.browserSurfaceWorkspace,initialized:true});await surface.mount();await ticket.ready;
 const apply=async()=>{const value=q.h.browserSurfaceWorkspace;if(value!==surface.workspace){const previousValue=surface.workspace;surface.workspace=value;surface.ngOnChanges({workspace:{previousValue,currentValue:value,firstChange:false}});await surface.mounting;}return value;};
 t.after(async()=>{gate.resolve();shouldHold=false;try{await controller.close();await surface.close();}finally{Object.assign(global,old);}});
 return{...q,trace,ui,surface,ticket,controller,runtime,bindingInputs,gate,apply,hold(){shouldHold=true;},get refs(){return refs;},get ownerAlive(){return ownerAlive;}};}
test('D14 actual passive provider turnover preserves borrowed Surface and exact ticket while ordinary Host authority is temporarily absent',async t=>{const f=await borrowedFixture(t);assert.equal(f.s.readReadyWorkspace('simulator'),'/original-project');f.hold();const current=f.bindingInputs.at(-1),turnover=f.controller.networkLifetimeEnded({...current});assert.equal(f.s.readReadyWorkspace('simulator'),null);assert.equal(await f.apply(),'/original-project');assert.deepEqual(f.ui.openToolList,['simulator']);assert.equal(f.surface.failed.values.length,0);assert.equal(f.trace.filter(x=>x==='browser:closeView').length,0);f.gate.resolve();await turnover;assert.equal(f.bindingInputs.length,2);assert.equal(f.s.readReadyWorkspace('simulator'),'/original-project');await f.apply();assert.equal(f.surface.ready.values.length,1);assert.equal(f.trace.filter(x=>x==='process-acquire').length,1);assert.equal(f.refs,2);assert.equal(f.ownerAlive,true);assert.equal(f.ui.toolPresentationIds.simulator,f.ticket.id);facts.push({case:'passive-turnover',ordinaryAuthorityWasNull:true,ViewCloses:0,readyEvents:1,sameTicket:true,refs:2});});
test('D14 initially loaded registered project does not need passive provider readiness and grants no ordinary Host authority',()=>{const{p,s,h}=projection();assert.equal(s.readReadyWorkspace('simulator'),null);assert.equal(h.browserSurfaceWorkspace,p.currentProjectPath);assert.equal(s.readReadyWorkspace('simulator'),null);});
for(const[name,change]of[['close',p=>p.currentProjectPath=''],['switch',p=>p.currentProjectPath='/successor-project'],['opening',p=>p.isProjectOpening=true],['not-loaded',p=>p.loaded=false]])test('D14 real loaded-project '+name+' still retires the original borrowed presentation',async t=>{const f=await borrowedFixture(t);change(f.p);await f.apply();assert.equal(f.trace.filter(x=>x==='browser:closeView').length,1);assert.deepEqual(f.ui.openToolList,[]);assert.equal(f.refs,1);assert.equal(f.ownerAlive,true);assert.equal(f.trace.filter(x=>x==='browser:release').length,0);facts.push({case:name,ViewClosed:true,borrowedAgentOwnerStillAlive:true});});
test('D14 same-path reload opening/not-ready lifetime closes once and cannot reuse the original Agent ticket',async t=>{const f=await borrowedFixture(t);f.p.isProjectOpening=true;await f.apply();f.p.isProjectOpening=false;f.p.loaded=false;await f.apply();f.p.loaded=true;await f.apply();assert.equal(f.trace.filter(x=>x==='browser:closeView').length,1);assert.equal(f.trace.filter(x=>x==='process-acquire').length,1);assert.deepEqual(f.ui.openToolList,[]);assert.equal(f.ui.toolPresentationIds.simulator,undefined);assert(f.surface.failed.values.every(x=>/Browser presentation grant is invalid or expired/.test(x)));});
test('D14 registered stopping/null/opening/not-ready and stale cached readybase use actual current loaded-project state',()=>{for(const change of[q=>q.s.stopping=true,q=>q.p.currentProjectPath='',q=>q.p.isProjectOpening=true,q=>q.p.loaded=false]){const q=projection();q.s.readyBaseWorkspaceSubject.next('/old-cached-project');change(q);assert.equal(q.s.readBrowserSurfaceWorkspace('simulator'),null);}const q=projection();q.s.readyBaseWorkspaceSubject.next('/old-cached-project');assert.equal(q.s.readBrowserSurfaceWorkspace('simulator'),'/original-project');assert.equal(q.s.readReadyWorkspace('simulator'),null);});
test('D14 unregistered legacy tool retains exact raw-path semantics including stopping/opening/code state',()=>{const q=projection(project(),false);q.p.isProjectOpening=true;q.p.loaded=false;q.p.code=true;q.s.stopping=true;assert.equal(q.s.readBrowserSurfaceWorkspace('legacy'),q.s.readReadyWorkspace('legacy'));assert.equal(q.s.readBrowserSurfaceWorkspace('legacy'),'/original-project');q.p.currentProjectPath='';assert.equal(q.s.readBrowserSurfaceWorkspace('legacy'),null);});
test('D14 detached/standalone explicit workspace branch including null is unchanged and undefined falls back to Main stable projection',()=>{const q=projection();q.h.currentUrl='/child-tool/simulator';q.h.standaloneWorkspace='/detached';assert.equal(q.h.browserSurfaceWorkspace,'/detached');q.h.standaloneWorkspace=null;assert.equal(q.h.browserSurfaceWorkspace,null);q.h.standaloneWorkspace=undefined;assert.equal(q.h.browserSurfaceWorkspace,'/original-project');});
test('D14 a late old completion still cannot remove a successor exact presentation',()=>{const ui=Object.create(UiService.prototype);Object.assign(ui,{openToolList:['simulator'],toolPresentationIds:{simulator:'new-ticket'},actionSubject:{next:noop}});ui.completeToolPresentationClose('simulator','old-ticket');assert.deepEqual(ui.openToolList,['simulator']);assert.equal(ui.toolPresentationIds.simulator,'new-ticket');});
test('Coder A/B retain distinct Browser identities and ordinary UI joins old owner ACK before new View', async t => {
  const q = projection(); q.p.code = true; q.p.currentProjectPath = '/coder-a';
  assert.equal(q.h.browserSurfaceWorkspace, '/coder-a');
  const originalGlobals = { window: global.window, document: global.document, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  const trace = [], releaseGate = Promise.withResolvers();
  let processRefs = 0, generation = 0;
  const id = (prefix, value) => `${prefix}0000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  global.window = { innerWidth: 1000, innerHeight: 800, electronAPI: { childToolSession: {
    async superviseOwner() { return { ok: true, generation: 'ordinary-ui-generation' }; },
    async browserExecution(input) {
      trace.push({ action: input.action, ownerSessionId: input.ownerSessionId });
      if (input.action === 'bindProcess') {
        generation++;
        return { endpoint: { kind: 'browser-message-port', runtimeId: id('1', generation) }, connectionId: id('2', generation) };
      }
      if (input.action === 'openView') return { executionId: id('1', generation), connectionId: id('3', generation), presentation: 'embedded' };
      if (input.action === 'updateView') return { updated: true };
      if (input.action === 'closeView') return { detached: true, physicalClosed: true };
      if (input.action === 'release') { if (generation === 1) await releaseGate.promise; return { released: true, refCount: 0, acknowledged: true, physicalClosed: true }; }
      throw Error('Unexpected ordinary UI fixture action');
    },
  } } };
  global.document = { visibilityState: 'visible' }; global.setTimeout = () => 1; global.clearTimeout = noop;
  const surfaces = new SubappBrowserSurfaceService({
    async acquire() { processRefs++; return { pid: 1, url: 'memory-only' }; },
    async release() { processRefs--; trace.push({ action: 'process-release' }); },
  });
  const surface = new ChildToolBrowserSurfaceComponent({ nativeElement: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) } }, surfaces);
  Object.assign(surface, { toolId: 'simulator', workspace: q.h.browserSurfaceWorkspace, initialized: true });
  t.after(async () => { releaseGate.resolve(); try { await surface.mounting; await surface.close(); } finally { Object.assign(global, originalGlobals); } });
  await surface.mount();
  assert.deepEqual(surface.failed.values, []);
  assert.equal(surface.ready.values.length, 1);
  const originalOwner = surface.ownerSessionId;
  q.p.currentProjectPath = '/coder-b';
  const successorWorkspace = q.h.browserSurfaceWorkspace;
  assert.equal(successorWorkspace, '/coder-b');
  surface.workspace = successorWorkspace;
  surface.ngOnChanges({ workspace: { previousValue: '/coder-a', currentValue: successorWorkspace, firstChange: false } });
  for (let turn = 0; turn < 20 && !trace.some(value => value.action === 'release'); turn++) await Promise.resolve();
  assert.equal(trace.filter(value => value.action === 'openView').length, 1, 'B cannot mount before A owner cleanup is confirmed');
  assert.equal(processRefs, 1);
  assert.equal(trace.find(value => value.action === 'release').ownerSessionId, originalOwner);
  releaseGate.resolve(); await surface.mounting;
  assert.equal(trace.filter(value => value.action === 'openView').length, 2);
  assert.notEqual(surface.ownerSessionId, originalOwner);
  assert.equal(surface.runtimeId, id('1', 2));
  assert.equal(processRefs, 1);
  assert.equal(surface.failed.values.length, 0);
  const releaseIndex = trace.findIndex(value => value.action === 'process-release');
  const newBindIndex = trace.findIndex(value => value.action === 'bindProcess' && value.ownerSessionId !== originalOwner);
  assert(releaseIndex >= 0 && releaseIndex < newBindIndex);
  await surface.close(); assert.equal(processRefs, 0);
  facts.push({ case: 'coder-a-to-b-normal-ui', distinctRoots: true, oldOwnerAcknowledgedBeforeNewView: true, oldFirmwareViewReused: false, finalProcessRefs: 0 });
});
test.after(()=>{const output=process.env.AILY_D14_EVIDENCE_DIR;if(output){assert(output.startsWith('/Volumes/data/aily-work/test-results/'));fs.writeFileSync(path.join(output,'actual-memory-facts.json'),JSON.stringify({kind:'D14-actual-Main-TS-memory-only-lifecycle-facts',facts,noMainUiApiNetworkMcuCalls:true},null,2)+'\n',{flag:'wx'});}});
