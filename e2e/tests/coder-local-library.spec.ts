import { cp, mkdir, mkdtemp, readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { constants, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, test } from '../fixtures/electron-app';

const source = process.env['AILY_E2E_CODER_LOCAL_PROJECT'];
const platform = process.env['AILY_E2E_PLATFORM_SEED'];
const names = ['Adafruit_GFX_Library', 'Adafruit_BusIO', 'GuwenUI', 'GxEPD2'];
async function digest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (relative = '') => {
    for (const entry of (await readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name=path.join(relative,entry.name);
      if(entry.isDirectory()) await walk(name);else {hash.update(name);hash.update(await readFile(path.join(root,name)));}
    }
  };
  await walk();return hash.digest('hex');
}

test('real local Coder project: all four library roots uninstall, cancel, discard, refresh and save', async ({}, info) => {
  test.skip(!source || !platform, 'Supply AILY_E2E_CODER_LOCAL_PROJECT and installed platform.');
  const original=await digest(path.join(source!,'sketch'));
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'aily-local-library-')));
  const project=path.join(root,'project');await mkdir(project);
  for(const relative of ['package.json','package-lock.json','node_modules','sketch']) {
    await cp(path.join(source!,relative),path.join(project,relative),{recursive:true,mode:constants.COPYFILE_FICLONE});
  }
  const baseline=await digest(path.join(project,'sketch/libraries'));
  const launch=await launchAilyElectron({environment:{AILY_BUILD_PRODUCT:'coder',AILY_E2E_TOOLCHAIN_SEED:process.env['AILY_E2E_TOOLCHAIN_SEED'] || platform!,AILY_E2E_TOOLCHAIN_PROJECT:project},config:{lang:'zh_CN',blocklyOnboardingCompleted:true,devmode:{enabled:true,autoSave:false}}});
  await cp(path.join(platform!,'npm-global/app/store/subapp-aily-coder-editor'),path.join(launch.userDataDir,'npm-global/app/store/subapp-aily-coder-editor'),{recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});
  const win=await getMainWindow(launch.app);
  win.on('pageerror', error=>console.log('Renderer error:',error.message));
  win.on('response', async response=>{
    if(response.url().includes('/api/component-libraries/')) console.log('Library response:',response.url(),await response.text().catch(()=>''));
  });
  await win.addLocatorHandler(win.locator('app-login .login-close'),async button=>button.click());
  const ready=()=>expect(win.locator('iframe.coder-embed-frame.is-ready')).toHaveCount(1,{timeout:90_000});
  const frame=()=>win.frames().find(frame=>frame.url().includes('nativeFsBridge=true'))!;
  const dirty=(value:boolean)=>expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved',String(value));
  const installed=()=>names.filter(name=>existsSync(path.join(project,'sketch/libraries',name)));
  const snapshots:any[]=[];
  const record=async(step:string)=>snapshots.push({step,installed:installed(),status:await win.evaluate(p=>(window as any).libraryDependencies.status(p),project)});
  try {
    await win.evaluate(p=>(window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(p),project);
    await ready();await dirty(false);
    await win.bringToFront();
    await writeFile(info.outputPath('initial-tree.txt'),JSON.stringify(await frame().getByRole('treeitem').allTextContents(),null,2));
    await win.screenshot({path:info.outputPath('initial.png')});
    const remove=async(name:string,cancel=false,dirtyEditor?:'cancel'|'discard')=>{
      const item=frame().getByRole('treeitem').filter({hasText:new RegExp(`^${name}$`)});
      await item.click({button:'right'});
      // Monaco arms menu mouse-up handlers 100 ms after rendering.
      await frame().getByRole('menuitem',{name:/卸载库/}).click({delay:150});
      await win.screenshot({path:info.outputPath('uninstall-menu.png')});
      const confirm=frame().getByRole('button',{name:'仍然卸载',exact:true});
      await expect.poll(async()=>await confirm.isVisible() || !installed().includes(name)).toBe(true);
      if(cancel){await frame().getByRole('button',{name:'取消',exact:true}).click();return;}
      if(await confirm.isVisible())await confirm.click();
      if(dirtyEditor){
        const discard=frame().getByRole('button',{name:/不保存/});
        await expect(discard).toBeVisible();
        if(dirtyEditor==='cancel'){await frame().getByRole('button',{name:/取消/}).click();return;}
        await discard.click();
      }
      await expect.poll(()=>installed().includes(name)).toBe(false);await dirty(true);
    };
    await remove('Adafruit_GFX_Library',true);expect(installed()).toEqual(names);await dirty(false);
    for(const name of names){
      if(name==='GuwenUI'){
        await frame().locator('.monaco-editor').first().click();
        await win.keyboard.press(process.platform==='darwin'?'Meta+p':'Control+p');
        await frame().locator('.quick-input-widget input').fill('sketch/libraries/GuwenUI/src/GuwenUI.cpp');await win.keyboard.press('Enter');
        await expect(frame().getByRole('tab',{name:/GuwenUI.cpp/})).toBeVisible();
        await frame().locator('.monaco-editor').first().click();await win.keyboard.insertText('x');
        await remove(name,false,'cancel');expect(installed()).toContain(name);
        await remove(name,false,'discard');
      } else await remove(name);
      await record(`remove-${name}`);
    }
    expect(installed()).toEqual([]);
    await win.reload();await ready();await dirty(false);
    expect(installed()).toEqual(names);expect(await digest(path.join(project,'sketch/libraries'))).toBe(baseline);await record('refresh-restores-all-bytes');
    await remove('GuwenUI');
    await win.evaluate(()=>{const w=window as any;w.discardDecision=w.ng.getComponent(document.querySelector('app-header')).checkUnsavedChanges('close');});
    await win.locator('app-unsave-dialog').getByRole('button',{name:'跳过保存',exact:true}).click();
    expect(await win.evaluate(()=>(window as any).discardDecision)).toBe(true);
    await dirty(false);expect(await digest(path.join(project,'sketch/libraries'))).toBe(baseline);await record('explicit-discard');
    const agent=process.env['AILY_E2E_AGENT_ROOT'];
    if(agent){
      const load=(file:string)=>import(pathToFileURL(path.join(agent,'packages/aily-agent/dist',file)).href);
      const {WorkspaceHistoryEngine}=await load('extensions/pi-workspace-history/history-engine.js');
      const {synchronizeBlocklyWorkspaceHistory}=await load('blockly/workspace-history-sync.js');
      const {runWithRuntimeTargetMode}=await load('blockly/runtime-target-context.js');
      const sync=()=>runWithRuntimeTargetMode('coder',()=>synchronizeBlocklyWorkspaceHistory({workspaceRoot:project,operation:'turn-revert',changedPaths:['sketch/libraries/HistoryLocal/library.properties']}));
      const history=new WorkspaceHistoryEngine(project,path.join(root,'history'));
      await history.begin('local-library-chat','turn-0',0,process.pid);await history.prepareExternalMutation('turn-0');
      await cp(path.join(project,'sketch/libraries/GuwenUI'),path.join(project,'sketch/libraries/HistoryLocal'),{recursive:true});
      await history.captureExternalMutation('turn-0');expect((await history.finalize('turn-0')).commitId).toBeTruthy();
      await sync();await ready();await dirty(false);
      const removed=await frame().evaluate(async project=>(await fetch('/api/component-libraries/remove',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspaceRoot:project,libraryId:'workspace:HistoryLocal',source:'aily',version:'1.0.0'})
      })).json(),project);
      expect(removed.ok).toBe(true);await dirty(true);
      await history.revertTurn('local-library-chat',0);await sync();await ready();await dirty(false);
      expect(existsSync(path.join(project,'sketch/libraries/HistoryLocal'))).toBe(false);await record('chat-revert-does-not-resurrect-local-library');
      await history.reapplyTurn('local-library-chat',0);await sync();await ready();await dirty(false);
      expect(existsSync(path.join(project,'sketch/libraries/HistoryLocal'))).toBe(true);
      await history.revertTurn('local-library-chat',0);await sync();await ready();await dirty(false);
      expect(await digest(path.join(project,'sketch/libraries'))).toBe(baseline);await record('chat-reapply-and-revert');
    }
    for(const name of names)await remove(name);
    await win.locator('app-footer .footer-box').click({position:{x:600,y:10}});
    await win.keyboard.press(process.platform==='darwin'?'Meta+s':'Control+s');await dirty(false);
    await win.reload();await ready();await dirty(false);expect(installed()).toEqual([]);await record('saved-removals-survive-refresh');
    expect(existsSync(path.join(project,'.temp/package.json'))).toBe(false);
    expect(await digest(path.join(source!,'sketch'))).toBe(original);
    await win.screenshot({path:info.outputPath('saved.png')});
  } finally {
    await writeFile(info.outputPath('measurement.json'),JSON.stringify({source,project,original,baseline,snapshots},null,2));
    await launch.close();
  }
});
