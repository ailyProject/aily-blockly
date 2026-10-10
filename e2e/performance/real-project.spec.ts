import {test, expect} from '@playwright/test';
import {getMainWindow, launchAilyElectron, openBlocklyProject, ROOT} from '../fixtures/electron-app';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
const out=path.join(ROOT,'e2e/.artifacts/blockly-real-project-2026-09-28');
test('capture real installed project and native library replay', async()=>{
 const app=await launchAilyElectron({environment:{AILY_E2E_MINIMAP:'1'}});
 const win=await getMainWindow(app.app);const errors:string[]=[];const logs:string[]=[];
 win.on('pageerror',e=>{errors.push(e.stack||e.message);console.log('REAL ERROR',e.message)});
 win.on('console',m=>{logs.push(m.text());if(m.type()==='error')console.log('REAL CONSOLE',m.text().slice(0,500))});
 try{
  await (await app.app.browserWindow(win)).evaluate(w=>w.setContentSize(1440,800));
  const start=Date.now();await openBlocklyProject(win,path.join(out,'project'));
  await win.waitForFunction(()=>document.querySelector('iframe[data-blockly-generator-runtime]')?.getAttribute('data-runtime-ready')==='true'||document.body.innerText.includes('加载项目失败'),null,{timeout:180000});
  expect(await win.locator('body').innerText()).not.toContain('加载项目失败');
  const loadMs=Date.now()-start; console.log('REAL ready',loadMs);
  await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-ready','true',{timeout:90000});
  const data=JSON.parse(await win.evaluate(()=>{
   const realm=(document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
   const ws=(window as any).blocklyWorkspace;
   const start=performance.now();const code=realm.Arduino.workspaceToCode(ws);
   return JSON.stringify({steps:realm.projectService.application.blocklyService.captureNativeReplay().steps,
    state:realm.Blockly.serialization.workspaces.save(ws),code,generationMs:performance.now()-start,
    count:ws.getAllBlocks(false).length,variables:ws.getVariableMap().getAllVariables().length,
    tops:ws.getTopBlocks(false).map(b=>({id:b.id,type:b.type,count:b.getDescendants(false).length})),
    svg:ws.getCanvas().querySelectorAll('*').length});
  }));
  await writeFile(path.join(out,'capture.json'),JSON.stringify({...data,loadMs}));
  console.log('REAL captured',JSON.stringify({...data,steps:data.steps.length,state:undefined,code:data.code.length,loadMs}));
  const shot=await (await app.app.browserWindow(win)).evaluate(async w=>(await w.webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(out,'host-original.png'),Buffer.from(shot,'base64'));
  expect(errors).toEqual([]);
 }finally {await writeFile(path.join(out,'capture-errors.json'),JSON.stringify({errors,logs},null,2));await app.close();}
});
