import { cp, mkdir, mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, getMainWindow, launchAilyElectron, test, ROOT } from '../fixtures/electron-app';

const platform = process.env['AILY_E2E_PLATFORM_SEED'];
const coder = process.env['AILY_E2E_CODER_ROOT'];
const agent = process.env['AILY_E2E_AGENT_ROOT'];
const { runDependencyWorker } = require('../../electron/library-dependencies');
const name = (id: string) => `@aily-project-coder/lib-save-${id}`;

test('Coder library save, uninstall discard, editor undo and Chat restore use the saved baseline', async ({}, info) => {
  test.skip(!platform || !coder || !agent, 'Supply installed platform, Coder and Agent source roots.');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-coder-save-')));
  const project = path.join(root, 'project');
  const write = async (file: string, text: string) => { await mkdir(path.dirname(file), {recursive:true}); await writeFile(file,text); };
  const packages = new Map<string, any>();
  const tar = require(path.join(ROOT, 'child/node/lib/node_modules/npm/node_modules/tar'));
  for (const id of ['a','b','c','broken']) {
    const directory = path.join(root, 'registry', id);
    const manifest = {name:name(id),version:'1.0.0'};
    await write(path.join(directory,'package/package.json'),JSON.stringify(manifest));
    await write(path.join(directory,'package/src/library.properties'),`name=Save ${id}\nversion=1.0.0\narchitectures=*\n`);
    await write(path.join(directory,'package/src/src',`Save${id}.h`),'#pragma once\n');
    if (id !== 'a') {
      execFileSync(path.join(ROOT,'child/7zz'),['a','src.7z','src'],{cwd:path.join(directory,'package'),stdio:'ignore'});
      await rm(path.join(directory,'package/src'),{recursive:true});
    }
    if (id === 'broken') await write(path.join(directory,'package/src.7z'),'invalid archive');
    await tar.c({gzip:true,file:path.join(directory,'package.tgz'),cwd:directory},['package']);
    const body=await readFile(path.join(directory,'package.tgz'));
    packages.set(name(id),{manifest,body,integrity:`sha512-${createHash('sha512').update(body).digest('base64')}`});
  }
  const server=createServer((req,res)=>{
    const key=decodeURIComponent(req.url!.split('/-/')[0].slice(1)),pkg=packages.get(key);
    if(!pkg){res.writeHead(404);res.end();return;}
    if(req.url!.includes('/-/')){res.end(pkg.body);return;}
    const version={...pkg.manifest,dist:{tarball:`${registry}/${key}/-/package.tgz`,integrity:pkg.integrity}};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({name:key,'dist-tags':{latest:'1.0.0'},versions:{'1.0.0':version}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const registry=`http://127.0.0.1:${(server.address() as any).port}`;
  const board='@aily-project/board-arduino_uno';
  await cp(path.join(platform!,'node_modules',board),path.join(project,'local-board'),{recursive:true,mode:constants.COPYFILE_FICLONE});
  await write(path.join(project,'package.json'),JSON.stringify({name:'coder-save-acceptance',version:'1.0.0',type:'coder',framework:'arduino',entry:'src/main.cpp',dependencies:{[board]:'file:local-board',[name('a')]:'1.0.0'}},null,2));
  await write(path.join(project,'sketch/src/main.cpp'),'#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n');
  const largeSource = process.env['AILY_E2E_CODER_LARGE_SOURCE'];
  if (largeSource) await cp(largeSource,path.join(project,'sketch/src/workload'),{recursive:true,mode:constants.COPYFILE_FICLONE});
  await runDependencyWorker(project,{save:true,options:{'@aily-project-coder:registry':registry}});
  await runDependencyWorker(project,{options:{'@aily-project-coder:registry':registry}});
  const launch=await launchAilyElectron({environment:{AILY_BUILD_PRODUCT:'coder',AILY_E2E_TOOLCHAIN_SEED:process.env['AILY_E2E_TOOLCHAIN_SEED']||platform!},config:{lang:'zh_CN',blocklyOnboardingCompleted:true,devmode:{enabled:true,autoSave:false},regions:{cn:{npm_registry_coder:registry}}}});
  await cp(path.join(platform!,'npm-global/app/store/subapp-aily-coder-editor'),path.join(launch.userDataDir,'npm-global/app/store/subapp-aily-coder-editor'),{recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});
  const catalog={libraries:['a','b','c','broken'].map(id=>({name:name(id),nickname:`Save ${id}`,version:'1.0.0',architectures:['*'],description:'Save regression fixture'}))};
  const index='https://blockly.yiyu.pro/libraries-coder-index.json';
  await write(path.join(launch.userDataDir,'cache/coder-package-libraries',`${createHash('sha256').update(index).digest('hex')}.json`),JSON.stringify(catalog));
  const win=await getMainWindow(launch.app);
  // Startup normalizes official regional URLs. Configure the disposable
  // profile afterwards so npm uses the real local test registry.
  const config=JSON.parse(await readFile(path.join(launch.userDataDir,'config.json'),'utf8'));
  config.regions.cn.npm_registry_coder=registry;
  await writeFile(path.join(launch.userDataDir,'config.json'),JSON.stringify(config));
  await win.evaluate(registry=>{(window as any).ng.getComponent(document.querySelector('app-header')).configService.data.regions.cn.npm_registry_coder=registry;},registry);
  await win.addLocatorHandler(win.locator('app-login .login-close'), async button=>button.click());
  const ready=()=>expect(win.locator('iframe.coder-embed-frame.is-ready')).toHaveCount(1,{timeout:90_000});
  const dirty=(value:boolean)=>expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved',String(value));
  const manifest=()=>readFile(path.join(project,'package.json'),'utf8');
  const installed=()=>['a','b','c'].filter(id=>existsSync(path.join(project,'node_modules',name(id),'package.json')));
  const sourceReady=(id:string)=>expect(existsSync(path.join(project,'node_modules',name(id),'src/src',`Save${id}.h`))).toBe(true);
  const status=()=>win.evaluate(project=>(window as any).libraryDependencies.status(project),project);
  const frame=()=>win.frames().find(frame=>frame.url().includes('nativeFsBridge=true'))!;
  const api=async (action:string,id:string)=>frame().evaluate(async ({action,id,project})=>{
    const response=await fetch(`/api/component-libraries/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspaceRoot:project,source:'registry',libraryId:`coder:@aily-project-coder/lib-save-${id}`,version:'1.0.0',query:'Save'})});
    return response.json();
  },{action,id,project});
  const snapshots:any[]=[];
  let performanceEvidence:any;
  const agentCall=async(tool:string,id:string)=>{
    const connection=JSON.parse(await readFile(path.join(os.homedir(),'.aily-blockly/cli-bridge',`${launch.app.process().pid}.json`),'utf8'));
    const response=await launch.app.context().request.post(`http://127.0.0.1:${connection.port}/command`,{data:{
      token:connection.token,action:'blockly-live-operation',operation:'subapp_agent_call',path:project,params:{
        toolId:'aily-coder-editor',tool,params:{libraryRef:`coder:${name(id)}`,version:'1.0.0'},
        sessionId:'coder-save-e2e',requestId:`${tool}-${Date.now()}`,context:{workspaceRoot:project,developmentMode:'coder'},
      },
    },timeout:120000});
    return response.json();
  };
  const changeFromUI=async(id:string,action:'install'|'remove')=>{
    let panel;
    for(const f of win.frames()) if(await f.locator('#arduino-tab').count()){panel=f;break;}
    if(!panel){
      await frame().getByRole('button',{name:'展开或收起库列表',exact:true}).click();
      await expect.poll(async()=>{
        for(const f of win.frames()) if(await f.locator('#arduino-tab').count()){panel=f;return true;}
        return false;
      }).toBe(true);
    }
    await panel!.locator('#arduino-tab').click();
    const card=panel!.locator('.card').filter({has:panel!.locator('.title',{hasText:new RegExp(`^Save ${id}$`)})});
    await card.getByRole('button',{name:action==='install'?'安装':'卸载',exact:true}).click();
    await expect.poll(()=>installed().includes(id)).toBe(action==='install');
    await dirty(true);
  };
  const record=async(step:string)=>{snapshots.push({step,installed:installed(),disk:JSON.parse(await manifest()),status:await status(),title:await win.locator('app-header .project-box').innerText()});};
  try {
    await win.evaluate(project=>(window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project),project);
    await ready(); await dirty(false);
    await writeFile(info.outputPath('initial-dom.txt'),await frame().locator('body').innerText());
    const baseline=await manifest(),baselineLock=await readFile(path.join(project,'package-lock.json'),'utf8');
    for(const [action,id] of [['remove','a'],['install','b'],['install','c']]){
      await changeFromUI(id,action as 'install'|'remove');
      expect(await manifest()).toBe(baseline);expect(await readFile(path.join(project,'package-lock.json'),'utf8')).toBe(baselineLock);await record(`${action}-${id}`);
    }
    expect(installed()).toEqual(['b','c']);
    sourceReady('b'); sourceReady('c');
    expect(await api('install','broken')).toMatchObject({ok:false});
    expect(existsSync(path.join(project,'node_modules',name('broken')))).toBe(false);
    expect(await manifest()).toBe(baseline); expect(installed()).toEqual(['b','c']);
    sourceReady('b'); sourceReady('c'); await dirty(true); await record('failed-install-rollback');
    expect(JSON.stringify(await agentCall('coder_library_install','a'))).toContain('LIBRARY_CHANGES_UNSAVED');
    expect((await api('search','')).libraries.filter((item:any)=>item.installed).map((item:any)=>item.packageName).sort()).toEqual([name('b'),name('c')]);
    await win.locator('app-footer .footer-box').click({position:{x:600,y:10}});
    await win.keyboard.press(process.platform==='darwin'?'Meta+s':'Control+s');
    await dirty(false); expect((await status()).dirty).toBe(false);
    expect(Object.keys(JSON.parse(await manifest()).dependencies).filter(key=>key.startsWith('@aily-project-coder/')).sort()).toEqual([name('b'),name('c')]);
    const saved=await manifest();await record('saved');
    expect(await api('remove','b')).toMatchObject({ok:true});await dirty(true);expect(await manifest()).toBe(saved);
    await win.reload();await ready();await dirty(false);expect(installed()).toEqual(['b','c']);expect(await manifest()).toBe(saved);await record('unsaved-uninstall-refresh');
    sourceReady('b');
    expect(await api('remove','c')).toMatchObject({ok:true});expect(await api('install','a')).toMatchObject({ok:true});await dirty(true);
    await win.evaluate(()=>{const w=window as any;w.discardDecision=w.ng.getComponent(document.querySelector('app-header')).checkUnsavedChanges('close');});
    await expect(win.locator('app-unsave-dialog')).toBeVisible();
    await win.locator('app-unsave-dialog').getByRole('button',{name:'跳过保存',exact:true}).click();
    expect(await win.evaluate(()=>(window as any).discardDecision)).toBe(true);
    await dirty(false);expect(installed()).toEqual(['b','c']);expect(await manifest()).toBe(saved);await record('explicit-discard');
    sourceReady('c');
    // Real Monaco edits: undo must clear the title, and iframe Save commits both
    // editor contents and the host's pending dependency manifest.
    const editor=()=>frame().locator('.monaco-editor').first();
    await editor().click({position:{x:420,y:65}});await win.keyboard.press('Control+Home');
    const editorBefore=await editor().locator('.view-lines').innerText();
    await win.keyboard.insertText('x');await dirty(true);
    await win.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');
    await expect(editor().locator('.view-lines')).toHaveText(editorBefore,{useInnerText:true});
    await dirty(false);
    expect(await api('remove','c')).toMatchObject({ok:true});await dirty(true);
    await editor().click({position:{x:420,y:65}});await win.keyboard.press(process.platform==='darwin'?'Meta+s':'Control+s');
    await dirty(false);expect(JSON.parse(await manifest()).dependencies[name('c')]).toBeUndefined();await record('iframe-save-removal');
    expect(await api('install','c')).toMatchObject({ok:true});await dirty(true);
    await editor().click({position:{x:420,y:65}});await win.keyboard.press(process.platform==='darwin'?'Meta+s':'Control+s');await dirty(false);
    // Actual Coder Agent RPC + Chat history engine, with dirty editor and
    // library state present when a previous version is restored.
    const loadAgent=(file:string)=>import(pathToFileURL(path.join(agent!,'packages/aily-agent/dist',file)).href);
    const {WorkspaceHistoryEngine}=await loadAgent('extensions/pi-workspace-history/history-engine.js');
    const {synchronizeBlocklyWorkspaceHistory}=await loadAgent('blockly/workspace-history-sync.js');
    const {runWithRuntimeTargetMode}=await loadAgent('blockly/runtime-target-context.js');
    const sync=()=>runWithRuntimeTargetMode('coder',()=>synchronizeBlocklyWorkspaceHistory({workspaceRoot:project,operation:'turn-revert',changedPaths:['package.json','sketch/src/main.cpp']}));
    const history=new WorkspaceHistoryEngine(project,path.join(root,'history'));
    const beforeChat=await manifest(),beforeCode=await readFile(path.join(project,'sketch/src/main.cpp'),'utf8');
    await history.begin('coder-save-chat','turn-0',0,process.pid);await history.prepareExternalMutation('turn-0');
    expect(await agentCall('coder_library_install','a')).toMatchObject({ok:true});
    await writeFile(path.join(project,'sketch/src/main.cpp'),beforeCode+'\n// Chat version\n');
    await history.captureExternalMutation('turn-0');expect((await history.finalize('turn-0')).commitId).toBeTruthy();
    const chatManifest=await manifest();await sync();await ready();await dirty(false);
    expect(installed()).toEqual(['a','b','c']);
    expect(await api('remove','b')).toMatchObject({ok:true});
    await editor().click({position:{x:420,y:65}});await win.keyboard.insertText('// must not overwrite Chat restore\n');await dirty(true);
    await history.revertTurn('coder-save-chat',0);await sync();await ready();await dirty(false);
    expect(JSON.parse(await manifest())).toEqual(JSON.parse(beforeChat));expect(installed()).toEqual(['b','c']);
    expect(await readFile(path.join(project,'sketch/src/main.cpp'),'utf8')).toBe(beforeCode);await record('chat-revert');
    await history.reapplyTurn('coder-save-chat',0);await sync();await ready();await dirty(false);
    expect(JSON.parse(await manifest())).toEqual(JSON.parse(chatManifest));expect(installed()).toEqual(['a','b','c']);await record('chat-reapply');
    if (largeSource) {
      await editor().click({position:{x:420,y:65}});
      await win.keyboard.press(process.platform==='darwin'?'Meta+p':'Control+p');
      await frame().locator('.quick-input-widget input').fill('sketch/src/workload/Arduino_GFX.cpp');
      await win.keyboard.press('Enter');
      await expect(frame().getByRole('tab',{name:/Arduino_GFX.cpp/})).toBeVisible();
      await editor().click({position:{x:420,y:65}});await win.keyboard.insertText('x');await dirty(true);
      await win.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');await dirty(false);
    }
    // Measure the real title check and count disk-based mode lookups while a
    // complete, unmodified large source tree is loaded in the Coder workspace.
    performanceEvidence=await win.evaluate(async()=>{
      const header=(window as any).ng.getComponent(document.querySelector('app-header'));
      const service=header.projectService,original=service.getProjectMode;let diskModeReads=0;
      service.getProjectMode=function(...args:any[]){diskModeReads++;return original.apply(this,args);};
      const samples=[];for(let i=0;i<30;i++){const start=performance.now();await header.refreshProjectUnsavedState();samples.push(performance.now()-start);}
      service.getProjectMode=original;samples.sort((a,b)=>a-b);return {checks:samples.length,medianMs:samples[15],maxMs:samples.at(-1),diskModeReads};
    });
    expect(performanceEvidence.diskModeReads).toBe(0);
    await win.screenshot({path:info.outputPath('coder-restored.png')});
  } finally {
    await writeFile(info.outputPath('measurement.json'),JSON.stringify({root,project,largeSource,performanceEvidence,snapshots},null,2));
    await launch.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
