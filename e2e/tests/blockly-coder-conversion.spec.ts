import { test, expect, _electron, type Locator, type Page } from '@playwright/test';
import { constants, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeAilyElectronApp, getMainWindow, ROOT } from '../fixtures/electron-app';
import { seedPlatform } from '../fixtures/platform-seed';
const {developmentCompanionLaunch} = require('../../electron/project-companion');

const SEED = process.env['AILY_CONVERSION_SEED'];

async function verifyHeaderMenuDismissal(win: Page, workArea: Locator) {
  await win.locator('app-header .menu').click();
  await expect(win.locator('app-header app-menu:not(.ports) .menu-box:not(.submenu-box)')).toBeVisible();
  await win.locator('app-header .board').click();
  await expect(win.locator('app-header app-menu:not(.ports)')).toHaveCount(0);
  await expect(win.locator('app-header app-menu.ports .menu-box:not(.submenu-box)')).toBeVisible();
  await win.locator('app-header .menu').click();
  await expect(win.locator('app-header app-menu.ports')).toHaveCount(0);
  await win.locator('app-footer .footer-box').click({position: {x: 600, y: 10}});
  await expect(win.locator('app-header app-menu')).toHaveCount(0);
  for (const [trigger, selector] of [
    ['app-header .menu', 'app-header app-menu:not(.ports)'],
    ['app-header .board', 'app-header app-menu.ports'],
  ]) {
    const menu = win.locator(selector);
    for (const outside of [win.locator('app-footer .footer-box'), workArea, workArea]) {
      await win.locator(trigger).click();
      const panel = menu.locator('.menu-box:not(.submenu-box)');
      await expect(panel).toBeVisible();
      await panel.click({position: {x: 2, y: 2}});
      await expect(panel).toBeVisible();
      await outside.click({position: {x: 600, y: outside === workArea ? 200 : 10}});
      await expect(menu).toHaveCount(0);
      const coderFrame = win.locator('iframe.coder-embed-frame.is-ready');
      if (outside === workArea && await coderFrame.count()) await expect(coderFrame).toBeFocused();
    }
  }
}

test('converted AI-VOX project exposes board menus, persists options and compiles its board custom partitions', async ({}, info) => {
  const original=process.env['AILY_CONVERSION_AIVOX_PROJECT'];
  test.skip(!SEED || !original, 'Supply the installed toolchain and converted AI-VOX project for real-workload regression.');
  test.setTimeout(480_000);
  const root=await mkdtemp(path.join(os.tmpdir(),'aily-aivox-conversion-'));
  const appdata=path.join(root,'appdata'), project=path.join(root,'AI-VOX Coder');
  await seedAppdata(appdata); await seedPlatform(original!,appdata,SEED);
  await cp(original!,project,{recursive:true,mode:constants.COPYFILE_FICLONE,
    filter:file=>!['.git','.aily','.build','.temp','.log','.workspace-history'].includes(path.basename(file))});
  const pkg=JSON.parse(await readFile(path.join(project,'package.json'),'utf8'));
  delete pkg.buildInfo; delete pkg.codeHash;
  await writeFile(path.join(project,'package.json'),JSON.stringify(pkg,null,2));
  const partition=path.join(project,'sketch/src/partitions.csv');
  await rm(partition,{force:true});
  // Launch exactly the development companion plan used by the main-process IPC.
  const launch=developmentCompanionLaunch('coder',project,{entry:path.join(ROOT,'electron/main.js'),executable:'unused'},
    {...process.env,AILY_APPDATA_PATH:appdata,AILY_E2E:'1'});
  const executablePath=process.env['AILY_CONVERSION_CODER_EXECUTABLE'];
  const args=executablePath ? [`--open-project=${project}`] : launch.args;
  const app=await _electron.launch({cwd:launch.options.cwd,...(executablePath?{executablePath}:{}),
    args:[...args,`--user-data-dir=${path.join(root,'profile')}`],env:launch.options.env,timeout:60_000});
  const win=await getMainWindow(app);
  try {
    await win.getByText('稍后登录',{exact:true}).click({timeout:10_000}).catch(()=>{});
    await expect(win.locator('iframe.coder-embed-frame.is-ready')).toHaveCount(1,{timeout:90_000});
    await expect(win.locator('app-coder-loading .coder-loader')).toBeHidden();
    await verifyHeaderMenuDismissal(win, win.frameLocator('iframe.coder-embed-frame.is-ready').locator('.monaco-editor').first());
    await win.locator('app-header .board').click();
    const menu=win.locator('app-menu.ports');
    for(const label of ['烧录速度','烧录方式','闪存模式','闪存大小','分区方案','USB 模式','USB模拟串口','PSRAM','切换开发板']) {
      await expect(menu.getByText(label,{exact:true})).toBeVisible();
    }
    await menu.getByText('烧录速度',{exact:true}).hover();
    await expect(menu.locator('.submenu-box')).toBeVisible();
    await win.screenshot({path:info.outputPath('aivox-board-menu.png')});
    await menu.locator('.submenu-box .menu-item').filter({hasText:/^115200$/}).click();
    await expect.poll(async()=>JSON.parse(await readFile(path.join(project,'package.json'),'utf8')).projectConfig.UploadSpeed).toBe('115200');
    await expect.poll(()=>existsSync(partition),{timeout:90_000}).toBe(true);
    expect(await readFile(partition,'utf8')).toBe(await readFile(path.join(project,'node_modules/@aily-project/board-ai-vox/partitions.csv'),'utf8'));
    await expect.poll(async()=>JSON.parse(await readFile(path.join(project,'package.json'),'utf8')).buildInfo?.lastBuildStatus,{timeout:150_000}).toBe('success');
    // The component host has no box; inspect the rendered panel instead.
    if(await menu.locator('.menu-box:not(.submenu-box)').isVisible()) {
      await win.locator('app-header .board').click();
      await expect(menu).toHaveCount(0);
    }
    await win.locator('app-header .board').click();
    await menu.getByText('烧录速度',{exact:true}).hover();
    await expect(menu.locator('.submenu-box .menu-item').filter({hasText:/^115200$/})).toHaveClass(/checked/);
    await win.locator('app-header .board').click();
    await expect(menu).toHaveCount(0);
    const started=Date.now();
    await win.locator('app-header app-act-btn[data-action="compile"]').click();
    await expect.poll(async()=>{
      const build=JSON.parse(await readFile(path.join(project,'package.json'),'utf8')).buildInfo;
      return Date.parse(build?.lastBuildTime||'')>=started && ['success','failed','cancelled'].includes(build.lastBuildStatus);
    },{timeout:300_000}).toBe(true);
    const built=JSON.parse(await readFile(path.join(project,'package.json'),'utf8'));
    expect(built.buildInfo.lastBuildStatus).toBe('success');
    expect(existsSync(path.join(project,'.build/main.bin'))).toBe(true);
    expect(built.codeHash).toBe(built.buildInfo.lastBuildCode);
    await win.screenshot({path:info.outputPath('aivox-compiled.png')});
    await info.attach('aivox-build',{body:JSON.stringify(built.buildInfo,null,2),contentType:'application/json'});
  } catch(error) {
    console.log('[AI-VOX header]',await win.evaluate(()=>{
      const header=(window as any).ng?.getComponent(document.querySelector('app-header'));
      return header && {show:header.showPortList,list:header.configList?.map(item=>item.name),
        path:header.projectService.currentProjectPath,board:header.projectService.currentBoardConfig?.type,
        operation:header.projectService.getCoderOperation(header.projectService.currentProjectPath)};
    }));
    console.log('[AI-VOX UI]',await win.locator('body').innerText());
    console.log('[AI-VOX log]',(await readFile(path.join(appdata,'logs/app.log'),'utf8').catch(()=>'' )).slice(-6000));
    await win.screenshot({path:info.outputPath('aivox-failure.png')}).catch(()=>{});throw error;
  } finally { await closeAilyElectronApp(app); await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
});

async function seedAppdata(appdata: string) {
  for (const relative of [
    'npm-global/app/store/subapp-aily-coder-editor', 'node_modules/@aily-project/sdk-avr',
    'node_modules/@aily-project/compiler-avr-gcc', 'node_modules/@aily-project/tool-avrdude',
    'node_modules/@aily-project/tool-ctags', 'sdk/avr_1.8.6', 'tools/avr-gcc@7.3.0',
    'tools/avrdude@6.3.0-arduino17', 'tools/ctags@5.8-arduino11',
    'npm-global/bin', 'npm-global/lib',
  ]) {
    const from = path.join(SEED!, relative);
    if (!existsSync(from)) continue;
    await mkdir(path.dirname(path.join(appdata, relative)), {recursive: true});
    await cp(from, path.join(appdata, relative), {recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE});
  }
  await writeFile(path.join(appdata,'config.json'), JSON.stringify({lang:'zh_CN',blocklyOnboardingCompleted:true}));
}

test('opening a generated ino in Coder confirms, installs outer dependencies and opens an independent project', async ({}, info) => {
  test.skip(!SEED, 'Set AILY_CONVERSION_SEED to an installed local Aily appdata directory.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-conversion-e2e-'));
  const appdata = path.join(root, 'appdata'), source = path.join(root, 'Blockly 示例');
  const write = async (relative: string, content: string) => {
    const file = path.join(root, relative); await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, content);
  };
  await seedAppdata(appdata);
  const board = '@aily-project/board-arduino_uno', library = 'conversion-local-library';
  await write('local-library/package.json', '{"name":"conversion-local-library","version":"1.0.0"}');
  await write('local-library/src/library.h', '#define LIBRARY_VALUE 42\n');
  const manifest = { name:'conversion-fixture', version:'1.0.0', nickname:'Blockly 示例', devmode:'arduino',
    projectConfig:{CPUFrequency:'16000000L'}, dependencies: {
      [board]:`file:${path.join(SEED!, 'node_modules',board)}`,
      [library]:'file:../local-library',
    } };
  await write('Blockly 示例/package.json',JSON.stringify(manifest,null,2));
  await write('Blockly 示例/project.abi','{"blocks":{"languageVersion":0,"blocks":[]}}');
  const code = '#include "src/user.h"\nvoid setup() { pinMode(USER_PIN, OUTPUT); }\nvoid loop() { delay(731); }\n';
  await write('Blockly 示例/.temp/sketch/sketch.ino', code);
  await write('Blockly 示例/.temp/sketch/package.json','{}');
  await write('Blockly 示例/src/user.h','#define USER_PIN 13\n');
  const entry = path.join(source,'.temp/sketch/sketch.ino');
  const {ELECTRON_RUN_AS_NODE,...env}=process.env;
  const executablePath=process.env['AILY_CONVERSION_CODER_EXECUTABLE'];
  const app = await _electron.launch({cwd:ROOT, ...(executablePath?{executablePath}:{}),
    args:[...(executablePath?[]:['.','--serve']),entry,`--user-data-dir=${path.join(root,'profile')}`],
    env:{...env,AILY_BUILD_PRODUCT:'coder',AILY_APPDATA_PATH:appdata,AILY_E2E:'1'},timeout:60_000});
  const win = await getMainWindow(app);
  const errors: string[]=[];
  win.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
  try {
    await win.getByText('稍后登录', {exact:true}).click({timeout:10_000}).catch(()=>{});
    await expect(win.getByText('稍后登录', {exact:true})).toBeHidden();
    const dialog = win.locator('.project-coder-conversion-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('原项目保留');
    const modalStyle = await dialog.locator('.ant-modal-content').evaluate(element => {
      const style=getComputedStyle(element);
      return {background:style.backgroundColor,shadow:style.boxShadow,border:style.borderTopWidth};
    });
    expect(modalStyle.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(modalStyle.shadow).not.toBe('none'); expect(modalStyle.border).toBe('1px');
    await win.screenshot({path:info.outputPath('conversion-confirm.png')});
    await dialog.getByRole('button',{name:'取消',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    expect(existsSync(`${source}_coder`)).toBe(false);
    // Exercise the actual file-association renderer event after cancelling.
    await app.evaluate(({BrowserWindow},file)=>{
      const main=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/main/'));
      if(!main)throw new Error('Main window missing'); main.webContents.send('open-project-from-file',file);
    },entry);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button',{name:'转换并打开',exact:true}).click();
    const target=`${source}_coder`;
    await expect.poll(()=>existsSync(path.join(target,'package.json')),{timeout:150_000}).toBe(true);
    await expect(dialog).toHaveCount(0,{timeout:150_000});
    const converted=JSON.parse(await readFile(path.join(target,'package.json'),'utf8'));
    expect(converted.type).toBe('coder'); expect(converted.entry).toBe('src/main.cpp');
    expect(converted.sourceRoots).toEqual(['src','libraries']);
    expect(converted.projectConfig).toEqual(manifest.projectConfig);
    expect(await readFile(path.join(target,'sketch/src/main.cpp'),'utf8')).toBe('#include <Arduino.h>\n\n'+code.replace('"src/user.h"','"user.h"'));
    expect(existsSync(path.join(target,'sketch/sketch.ino'))).toBe(false);
    expect(await readFile(path.join(target,'sketch/src/user.h'),'utf8')).toBe('#define USER_PIN 13\n');
    expect(existsSync(path.join(target,'project.abi'))).toBe(false);
    for(const dependency of [board,library])expect(existsSync(path.join(target,'node_modules',dependency,'package.json'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(source,'package.json'),'utf8'))).toEqual(manifest);
    expect(existsSync(path.join(source,'project.abi'))).toBe(true);
    await expect(win.locator('app-code-editor-pro')).toBeVisible();
    await expect(win.locator('iframe.coder-embed-frame.is-ready')).toHaveCount(1,{timeout:90_000});
    await expect(win.locator('app-coder-loading .coder-loader')).toBeHidden();
    await expect.poll(()=>win.url()).toContain(encodeURIComponent(target));
    await verifyHeaderMenuDismissal(win, win.frameLocator('iframe.coder-embed-frame.is-ready').locator('.monaco-editor').first());
    await win.screenshot({path:info.outputPath('coder-menus-dismissed.png')});
    await win.locator('app-header app-act-btn[data-action="compile"]').click();
    await expect.poll(async () => {
      const pkg=JSON.parse(await readFile(path.join(target,'package.json'),'utf8'));
      return ['success','failed','cancelled'].includes(pkg.buildInfo?.lastBuildStatus);
    }, {timeout:150_000}).toBe(true);
    expect(JSON.parse(await readFile(path.join(target,'package.json'),'utf8')).buildInfo.lastBuildStatus).toBe('success');
    expect(existsSync(path.join(target,'.build/main.hex'))).toBe(true);
    await info.attach('converted-project-build', {body:await readFile(path.join(target,'package.json'),'utf8'),contentType:'application/json'});
    await win.screenshot({path:info.outputPath('converted-coder-project.png')});
    await info.attach('runtime-errors',{body:JSON.stringify(errors,null,2),contentType:'application/json'});
  } catch(error) {
    console.log('[conversion runtime errors]',errors);
    console.log('[conversion UI]',await win.locator('body').innerText());
    console.log('[conversion app log]',(await readFile(path.join(appdata,'logs/app.log'),'utf8').catch(()=>'' )).slice(-8000));
    await win.screenshot({path:info.outputPath('conversion-failure.png')}).catch(()=>{});
    throw error;
  } finally {
    await closeAilyElectronApp(app); await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});

for (const surface of ['embedded', 'detached']) {
test(`Code Viewer ${surface} icon saves the latest Blockly code, converts and hands it to Coder`, async ({}, info) => {
  test.skip(!SEED, 'Set AILY_CONVERSION_SEED to an installed local Aily appdata directory.');
  const libraries = process.env['AILY_CONVERSION_LIBRARIES'];
  test.skip(!libraries, 'Set AILY_CONVERSION_LIBRARIES to the local Blockly library source repository.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-viewer-conversion-'));
  const appdata=path.join(root,'appdata'), source=path.join(root,'viewer-project');
  await seedAppdata(appdata);
  const board='@aily-project/board-arduino_uno';
  const boardPath=path.join(SEED!,'node_modules',board);
  await cp(path.join(boardPath,'template'),source,{recursive:true});
  const manifest=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));
  manifest.devmode='arduino';
  for(const dependency of Object.keys(manifest.dependencies)) {
    const from=dependency===board?boardPath:path.join(libraries!,dependency.replace('@aily-project/lib-',''));
    manifest.dependencies[dependency]=`file:${from}`;
    const to=path.join(source,'node_modules',dependency); await mkdir(path.dirname(to),{recursive:true});
    await cp(from,to,{recursive:true,filter:file=>!['.git','node_modules'].includes(path.basename(file))});
  }
  await writeFile(path.join(source,'package.json'),JSON.stringify(manifest,null,2));
  const abi=JSON.parse(await readFile(path.join(source,'project.abi'),'utf8'));
  abi.blocks.blocks.find(block=>block.type==='arduino_loop').inputs={ARDUINO_LOOP:{block:{
    type:'time_delay',id:'conversion-delay',inputs:{DELAY_TIME:{block:{type:'math_number',id:'conversion-number',fields:{NUM:731}}}},
  }}};
  await writeFile(path.join(source,'project.abi'),JSON.stringify(abi));
  const {ELECTRON_RUN_AS_NODE,...env}=process.env;
  const app=await _electron.launch({cwd:ROOT,args:['.','--serve',path.join(source,'project.abi'),`--user-data-dir=${path.join(root,'profile')}`],
    env:{...env,AILY_BUILD_PRODUCT:'blockly',AILY_APPDATA_PATH:appdata,AILY_E2E:'1'},timeout:60_000});
  const win=await getMainWindow(app);
  win.on('console', message => {
    if (message.type()==='error' || /conversion failed|reinstallDepsForAilyCodeBoardSwitch/.test(message.text())) {
      console.log(`[viewer:${message.type()}] ${message.text()}`);
    }
  });
  try {
    await win.getByText('稍后登录',{exact:true}).click({timeout:10_000}).catch(()=>{});
    await expect(win.getByText('稍后登录',{exact:true})).toBeHidden();
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1,{timeout:60_000});
    if (surface === 'embedded') {
      await verifyHeaderMenuDismissal(win, win.locator('.blocklyMainBackground').first());
      await win.screenshot({path:info.outputPath('blockly-menus-dismissed.png')});
    }
    // Only the OS launcher is intercepted: conversion, save, npm, source
    // materialization and target validation all use the real application.
    await app.evaluate(({ipcMain})=>{
      ipcMain.removeHandler('project-companion-open');
      ipcMain.handle('project-companion-open',(_event,request)=>{
        (globalThis as any).__conversionLaunch=request; return {ok:true};
      });
    });
    await win.locator('app-header .fa-rectangle-code').click();
    await expect(win.getByTestId('code-viewer-open-coder')).toBeVisible();
    let viewer=win;
    if(surface==='detached') {
      await win.locator('app-code-viewer .fa-arrow-up-right-from-square').click();
      await expect.poll(()=>app.windows().find(page=>page.url().endsWith('/code-viewer'))?.url()).toBeTruthy();
      viewer=app.windows().find(page=>page.url().endsWith('/code-viewer'))!;
    }
    const button=viewer.getByTestId('code-viewer-open-coder');
    await expect(button).toBeVisible(); await expect(button).toHaveAccessibleName('使用 Aily Coder 打开');
    const size=await button.boundingBox(); expect(size?.width).toBeGreaterThanOrEqual(28);
    await viewer.screenshot({path:info.outputPath(`${surface}-viewer-icon.png`)});
    // Exercise the real viewer -> main window -> download IPC path, controlling
    // only installed-app discovery and the final OS browser launch.
    await app.evaluate(({ipcMain, shell})=>{
      ipcMain.removeHandler('project-companion-status');
      ipcMain.handle('project-companion-status',()=>({installed:false}));
      (globalThis as any).__downloadUrls=[];
      shell.openExternal=async url=>{ (globalThis as any).__downloadUrls.push(url); };
    });
    const originalRegion=await win.evaluate(()=>
      (window as any).ng.getComponent(document.querySelector('app-header')).configService.data.region);
    for(const [region, homepage] of [['cn','https://yiyu.pro/'],['eu','https://aily.pro/']]) {
      await win.evaluate(region=>{
        (window as any).ng.getComponent(document.querySelector('app-header')).configService.data.region=region;
      },region);
      await expect(button).toBeEnabled(); await button.click();
      await expect.poll(()=>app.evaluate(()=> (globalThis as any).__downloadUrls.at(-1))).toBe(homepage);
      await expect(win.locator('.project-coder-conversion-modal')).toHaveCount(0);
      await expect(win.locator('.project-mode-mismatch-modal')).toHaveCount(0);
      expect(existsSync(`${source}_coder`)).toBe(false);
      expect(await app.evaluate(()=> (globalThis as any).__conversionLaunch)).toBeUndefined();
    }
    expect(await app.evaluate(()=> (globalThis as any).__downloadUrls)).toEqual(['https://yiyu.pro/','https://aily.pro/']);
    await win.evaluate(region=>{
      (window as any).ng.getComponent(document.querySelector('app-header')).configService.data.region=region;
    },originalRegion);
    await app.evaluate(({ipcMain})=>{
      ipcMain.removeHandler('project-companion-status');
      ipcMain.handle('project-companion-status',()=>({installed:true}));
    });
    await expect(button).toBeEnabled();
    await button.click();
    const dialog=win.locator('.project-coder-conversion-modal'); await expect(dialog).toBeVisible();
    await dialog.getByRole('button',{name:'取消',exact:true}).click();
    await expect(dialog).toHaveCount(0); expect(existsSync(`${source}_coder`)).toBe(false);
    // Edit after opening the viewer. The save handshake must publish 913,
    // regardless of the viewer's throttled IPC snapshot.
    await win.evaluate(()=> (window as any).blocklyWorkspace.getBlockById('conversion-number').setFieldValue(913,'NUM'));
    await expect(button).toBeEnabled(); await button.click(); await expect(dialog).toBeVisible();
    await dialog.getByRole('button',{name:'转换并打开',exact:true}).click();
    await expect(dialog).toHaveCount(0,{timeout:150_000});
    const launch=await app.evaluate(()=> (globalThis as any).__conversionLaunch);
    expect(launch.mode).toBe('coder'); expect(launch.projectPath).toBe(`${await realpath(source)}_coder`);
    const target=launch.projectPath;
    const converted=JSON.parse(await readFile(path.join(target,'package.json'),'utf8'));
    expect(converted.type).toBe('coder'); expect(converted.entry).toBe('src/main.cpp');
    expect(converted.sourceRoots).toEqual(['src','libraries']);
    expect(await readFile(path.join(target,'sketch/src/main.cpp'),'utf8')).toContain('delay(913)');
    expect(existsSync(path.join(target,'sketch/sketch.ino'))).toBe(false);
    expect(existsSync(path.join(target,'node_modules',board,'package.json'))).toBe(true);
    expect(existsSync(path.join(target,'node_modules/@aily-project/lib-core-time/package.json'))).toBe(true);
    expect(existsSync(path.join(source,'project.abi'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(source,'package.json'),'utf8')).type).not.toBe('coder');
    await expect(win.locator('app-blockly-editor')).toBeVisible();
    await win.screenshot({path:info.outputPath(`${surface}-conversion-complete.png`)});
  } catch(error) {
    console.log('[viewer conversion UI]',await win.locator('body').innerText());
    console.log('[viewer conversion app log]',(await readFile(path.join(appdata,'logs/app.log'),'utf8').catch(()=>'' )).slice(-9000));
    await win.screenshot({path:info.outputPath(`${surface}-failure.png`)}).catch(()=>{}); throw error;
  } finally {
    await closeAilyElectronApp(app); await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});
}
