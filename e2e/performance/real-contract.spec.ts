import {test, expect} from '@playwright/test';
import {launchAilyElectron, getMainWindow, openBlocklyProject, ROOT} from '../fixtures/electron-app';
import {cp, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const out=path.join(ROOT,'e2e/.artifacts/blockly-real-project-2026-09-28');
for(const topology of ['original','expanded']) test(`real ${topology}: pointer edits, colour, undo, save and reopen`,async()=>{
 test.setTimeout(300_000);
 const tmp=await mkdtemp(path.join(os.tmpdir(),'aily-real-contract-'));
 const project=path.join(tmp,'project');
 await cp(path.join(out,topology==='original'?'project':'project-expanded'),project,{recursive:true,verbatimSymlinks:true});
 const app=await launchAilyElectron({environment:{AILY_E2E_MINIMAP:'1'}});
 const win=await getMainWindow(app.app), errors:string[]=[];
 win.on('pageerror',e=>errors.push(e.message));
 win.on('console',m=>{if(/Code generation error|Failed to generate the project source artifact|Canonical JSON exceeds|Maximum call stack/.test(m.text()))errors.push(m.text());});
 const report:any={topology};
 const fieldPoint=async(id:string,name:string)=>{
  await win.evaluate(({id,name})=>{
   const ws=(window as any).blocklyWorkspace;
   const field=ws.getBlockById(id).getField(name).getSvgRoot().getBoundingClientRect();
   const viewport=ws.getInjectionDiv().getBoundingClientRect();
   ws.scroll(ws.scrollX+(viewport.left+viewport.right-field.left-field.right)/2,
    ws.scrollY+(viewport.top+viewport.bottom-field.top-field.bottom)/2);
  },{id,name});
  await win.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  return win.evaluate(({id,name})=>{
   const field=(window as any).blocklyWorkspace.getBlockById(id).getField(name).getSvgRoot();
   const rect=field.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;
   if(!field.contains(document.elementFromPoint(x,y)))throw new Error(`Field pointer hit mismatch: ${id}/${name} at ${x},${y}`);
   return{x,y};
  },{id,name});
 };

 const ready=()=>win.waitForFunction(()=>document.querySelector('iframe[data-blockly-generator-runtime]')?.getAttribute('data-runtime-ready')==='true',null,{timeout:120000});
 const code=()=>win.evaluate(()=>{const r=(document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;return r.projectService.application.blocklyService.runWithPreparedProjectCode(prepared=>prepared.code);});
 try{
  await (await app.app.browserWindow(win)).evaluate(w=>w.setContentSize(1440,800));
  await openBlocklyProject(win,project);await ready();
  await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-ready','true',{timeout:90000});
  console.log('[real-contract] loaded',topology);
  const initial=await code();
  report.before=await win.evaluate(()=>{const ws=(window as any).blocklyWorkspace;return {count:ws.getAllBlocks(false).length,variables:ws.getVariableMap().getAllVariables().length};});
  expect(report.before.count).toBe(topology==='original'?7765:8265);expect(report.before.variables).toBe(320);
  const target=await win.evaluate(()=>{
   const ws=(window as any).blocklyWorkspace;ws.clearUndo();
   const b=ws.getAllBlocks(false).find(b=>b.type==='math_number');ws.centerOnBlock(b.id);
   return {id:b.id,value:b.getFieldValue('NUM')};
  });
  await win.waitForTimeout(500);
  const point=await fieldPoint(target.id,'NUM');
  await win.mouse.click(point.x,point.y);
  const input=win.locator('.blocklyHtmlInput:visible');await expect(input).toHaveCount(1);
  await input.fill(String(Number(target.value)+1));await input.press('Enter');
  await expect.poll(()=>win.evaluate(id=>(window as any).blocklyWorkspace.getBlockById(id).getFieldValue('NUM'),target.id)).toBe(Number(target.value)+1);
  expect(await code()).not.toBe(initial);
  await win.waitForTimeout(300);
  await win.evaluate(()=>(window as any).blocklyWorkspace.undo(false));
  expect(await code()).toBe(initial);report.numericPointerEditUndo=true;console.log('[real-contract] numeric edit and undo passed');
  const colour=await win.evaluate(()=>{
   const ws=(window as any).blocklyWorkspace;ws.clearUndo();
   const b=ws.getAllBlocks(false).find(b=>b.type==='lvgl_obj_set_style_bg_color'&&b.getFieldValue('COLOR')==='#3a1f6b');
   if(!b)throw new Error('Real custom LVGL colour was not retained');ws.centerOnBlock(b.id);return{id:b.id,value:b.getFieldValue('COLOR')};
  });
  await win.waitForTimeout(500);
  const colourPoint=await fieldPoint(colour.id,'COLOR');
  await win.mouse.click(colourPoint.x,colourPoint.y);
  const slider=win.locator('.fieldColourSlider:visible').first();await expect(slider).toBeVisible();
  await slider.focus();await slider.press('ArrowRight');
  await expect.poll(()=>win.evaluate(id=>(window as any).blocklyWorkspace.getBlockById(id).getFieldValue('COLOR'),colour.id)).not.toBe(colour.value);
  await win.evaluate(()=>(window as any).Blockly.hideChaff(false));
  await win.waitForTimeout(300);await win.evaluate(()=>(window as any).blocklyWorkspace.undo(false));
  expect(await code()).toBe(initial);report.colourPointerEditUndo=true;console.log('[real-contract] colour edit and undo passed');
  const save=await win.evaluate(async()=>{const r=(document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;return r.projectService.save(undefined,90000);});
  expect(save.success,JSON.stringify(save)).toBe(true);
  await win.evaluate(()=>location.hash='#/main/guide');await expect(win.locator('app-blockly-editor')).toHaveCount(0);
  await openBlocklyProject(win,project);await ready();expect(await code()).toBe(initial);
  expect(await win.evaluate(()=>(window as any).blocklyWorkspace.getAllBlocks(false).length)).toBe(report.before.count);
  expect(await win.evaluate(()=>(window as any).blocklyWorkspace.getVariableMap().getAllVariables().length)).toBe(320);
  report.savedAndReopened=true;report.codeSha256=createHash('sha256').update(initial).digest('hex');report.errors=errors;expect(errors).toEqual([]);
  const shot=await(await app.app.browserWindow(win)).evaluate(async w=>(await w.webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(out,`contract-${topology}.png`),Buffer.from(shot,'base64'));report.passed=true;
 }catch(error){report.failure=String(error);throw error;}finally{
  if(!report.passed)await win.screenshot({path:path.join(out,`contract-${topology}-failure.png`)}).catch(()=>{});
  await writeFile(path.join(out,`contract-${topology}.json`),JSON.stringify(report,null,2));await app.close();await rm(tmp,{recursive:true,force:true});}
});
