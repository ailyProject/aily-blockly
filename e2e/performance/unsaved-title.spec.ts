import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

const sources = { large: process.env['AILY_E2E_PROJECT'] };
for (const [label, source] of Object.entries(sources)) test(`${label} project unsaved title runtime cost`, async ({}, info) => {
  test.skip(!source, 'Set AILY_E2E_PROJECT to an installed large Blockly project.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-title-performance-'));
  const project = path.join(root, 'project');
  const hash = async () => createHash('sha256').update(await readFile(path.join(source!, 'project.abi'))).digest('hex');
  const sourceHash = await hash();
  await cp(source!, project, {recursive: true, dereference: true, filter: file => !['.git', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock'].includes(path.basename(file))});
  const config = JSON.parse(await readFile(path.resolve('electron/config/config.json'), 'utf8'));
  config.lang = 'zh_CN'; config.blocklyOnboardingCompleted = true; config.blockly.autoSave = false; config.blockly.minimap = false;
  const launched = await launchAilyElectron({config});
  const win = await getMainWindow(launched.app);
  await win.addLocatorHandler(win.locator('app-login .login-close'), async button => {await button.click();});
  const report: any = {label, source, project, sourceHash, environment: {cpu: os.cpus()[0]?.model, arch:process.arch, platform:process.platform, build:'development', minimap:false}, errors:[], phases:[]};
  win.on('pageerror', e => report.errors.push(e.message));
  try {
    await openBlocklyProject(win, project);
    await win.waitForFunction(() => {const element=document.querySelector('app-blockly-editor');return element && (window as any).ng?.getComponent(element)?.npmService;});
    // Editor-only benchmark: omit compiler SDK downloads; editor and dirty checks run unchanged.
    await win.evaluate(() => {(window as any).ng.getComponent(document.querySelector('app-blockly-editor')).npmService.installBoardDeps = async () => {};});
    await expect.poll(async () => {try {return (await readAilyHostOperation(launched.app,'project_load_status',project)).ready;} catch{return false;}}, {timeout:120000}).toBe(true);
    await win.waitForTimeout(2500);
    report.initial = await win.evaluate(() => {
      const w=window as any, h=w.ng.getComponent(document.querySelector('app-header'));
      const editor=w.ng.getComponent(document.querySelector('app-blockly-editor'));
      const b=editor.blocklyService, p=w.titlePerf={calls:[], schedules:[], phase:'setup'};
      const sync=(obj:any,key:string,label:string) => {const original=obj[key]; if(typeof original!=='function')throw Error(`Missing ${label}`);obj[key]=function(...args:any[]){const start=performance.now();try{return original.apply(this,args);}finally{p.calls.push({phase:p.phase,label,start,ms:performance.now()-start});}};};
      const async=(obj:any,key:string,label:string) => {const original=obj[key];if(typeof original!=='function')throw Error(`Missing ${label}`);obj[key]=async function(...args:any[]){const start=performance.now();try{return await original.apply(this,args);}finally{p.calls.push({phase:p.phase,label,start,ms:performance.now()-start});}};};
      sync(h.projectService,'getProjectMode','mode-file-check');
      sync(b,'getProjectDocument','project-document-capture');
      sync(b.projectDirtyState,'viewport','viewport-hint');
      sync(b.projectDirtyState,'edited','edit-hint');
      sync(b.projectDirtyState,'reconcile','checkpoint-verification');
      sync(b,'captureProjectSnapshot','snapshot-and-revision');
      sync(b,'getProjectAbiForSave','abi-clone');
      sync(b,'normalizeProjectAbi','abi-normalize');
      sync(editor._projectService.cleanState,'compare','baseline-compare');
      async(h.projectService,'hasUnsavedLibraryChanges','library-status');
      async(h.projectService,'hasUnsavedChanges','full-unsaved-query');
      async(h,'refreshProjectUnsavedState','title-refresh');
      const schedule=h.scheduleUnsavedCheck;
      h.scheduleUnsavedCheck=function(){p.schedules.push({phase:p.phase,time:performance.now()});return schedule.call(this);};
      return {blocks:w.blocklyWorkspace.getAllBlocks(false).length,title:document.querySelector('app-header .project-box')?.textContent,dirty:h.hasUnsavedProjectChanges,scrollX:w.blocklyWorkspace.scrollX,scrollY:w.blocklyWorkspace.scrollY};
    });
    const phase = async (name:string, action:()=>Promise<any>) => {
      await win.evaluate(name=>{const p=(window as any).titlePerf;p.phase=name;p.start=performance.now();p.tasks=[];p.frames=[];p.previous=performance.now();p.active=true;p.observer=new PerformanceObserver(list=>p.tasks.push(...list.getEntries().map(e=>({start:e.startTime,ms:e.duration}))));p.observer.observe({entryTypes:['longtask']});const frame=(now:number)=>{p.frames.push(now-p.previous);p.previous=now;if(p.active)requestAnimationFrame(frame);};requestAnimationFrame(frame);},name);
      const result=await action();
      await win.waitForTimeout(60);
      report.phases.push(await win.evaluate(result=>{const w=window as any,p=w.titlePerf;p.active=false;p.tasks.push(...p.observer.takeRecords().map((e:any)=>({start:e.startTime,ms:e.duration})));p.observer.disconnect();return {name:p.phase,duration:performance.now()-p.start,result,calls:p.calls.filter((c:any)=>c.phase===p.phase),schedules:p.schedules.filter((c:any)=>c.phase===p.phase),longTasks:p.tasks,maxFrameMs:Math.max(...p.frames),dirty:w.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges};},result));
    };
    await phase('idle-5-seconds',async()=>{await win.waitForTimeout(5000);});
    await phase('six-explicit-title-checks',()=>win.evaluate(async()=>{const h=(window as any).ng.getComponent(document.querySelector('app-header'));for(let i=0;i<6;i++){await h.refreshProjectUnsavedState();await new Promise(r=>setTimeout(r,250));}}));
    await phase('single-pan-auto-check',async()=>{await win.evaluate(()=>{const ws=(window as any).blocklyWorkspace;ws.scroll(ws.scrollX-20,ws.scrollY-10);});await win.waitForTimeout(1500);});
    await phase('burst-30-pans-auto-check',async()=>{await win.evaluate(async()=>{const ws=(window as any).blocklyWorkspace;for(let i=0;i<30;i++){ws.scroll(ws.scrollX-2,ws.scrollY);await new Promise(r=>setTimeout(r,16));}});await win.waitForTimeout(1500);});
    const dirty = (value:boolean) => expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved',String(value),{timeout:30000});
    await dirty(true);
    await phase('restore-saved-viewport',async()=>{await win.evaluate(({scrollX,scrollY})=>(window as any).blocklyWorkspace.scroll(scrollX,scrollY),report.initial);await dirty(false);});
    for(const p of report.phases) {
      expect(p.calls.filter((c:any)=>['full-unsaved-query','mode-file-check','project-document-capture'].includes(c.label))).toEqual([]);
    }
    const edited = await win.evaluate(()=>{const ws=(window as any).blocklyWorkspace,b=ws.getTopBlocks(false).find((b:any)=>b.isMovable());const pos=b.getRelativeToSurfaceXY();return {id:b.id,x:pos.x,y:pos.y};});
    await phase('edit-without-title-serialization',async()=>{await win.evaluate(id=>(window as any).blocklyWorkspace.getBlockById(id).moveBy(40,0),edited.id);await dirty(true);});
    await phase('undo-to-saved-checkpoint',async()=>{await win.evaluate(()=>(window as any).blocklyWorkspace.undo(false));await dirty(false);});
    await win.evaluate(()=>(window as any).blocklyWorkspace.undo(true));await dirty(true);
    await win.keyboard.press('Meta+s');await dirty(false);
    const savedDisk=await readFile(path.join(project,'project.abi'),'utf8');
    await win.evaluate(()=>(window as any).blocklyWorkspace.undo(false));await dirty(true);
    await win.evaluate(()=>(window as any).blocklyWorkspace.undo(true));await dirty(false);
    await win.evaluate(id=>(window as any).blocklyWorkspace.getBlockById(id).moveBy(25,0),edited.id);await dirty(true);
    expect(await readFile(path.join(project,'project.abi'),'utf8')).toBe(savedDisk);
    await win.reload();
    await expect.poll(async()=>{try{return(await readAilyHostOperation(launched.app,'project_load_status',project)).ready;}catch{return false;}},{timeout:120000}).toBe(true);
    await dirty(false);
    const restored=await win.evaluate(id=>{const ws=(window as any).blocklyWorkspace,pos=ws.getBlockById(id).getRelativeToSurfaceXY();return{x:pos.x,y:pos.y,blocks:ws.getAllBlocks(false).length};},edited.id);
    expect(restored.x).toBeCloseTo(edited.x+40,5);expect(restored.y).toBeCloseTo(edited.y,5);expect(restored.blocks).toBe(report.initial.blocks);
    report.functional={edited,restored,saveUndoRedoAndDiscardReload:true};
    report.sourceUnchanged=(await hash())===sourceHash;
    expect(report.sourceUnchanged).toBe(true);
    console.log('[title-performance]',JSON.stringify({label,blocks:report.initial.blocks,phases:report.phases.map(p=>({name:p.name,checks:p.calls.filter(c=>c.label==='full-unsaved-query').map(c=>c.ms),mode:p.calls.filter(c=>c.label==='mode-file-check').map(c=>c.ms),schedules:p.schedules.length,longTasks:p.longTasks,maxFrameMs:p.maxFrameMs}))}));
  } finally {
    await writeFile(info.outputPath('measurement.json'),JSON.stringify(report,null,2));
    await launched.close();
  }
});
