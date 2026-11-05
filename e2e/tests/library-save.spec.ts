import { cp, mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

const libraries = process.env['AILY_E2E_LIBRARIES'];
const platform = process.env['AILY_E2E_PLATFORM_SEED'];
const { runDependencyWorker } = require('../../electron/library-dependencies');
const packageName = (name: string) => `@aily-project/lib-save-${name}`;

test('automatic library save and archive extraction preserve canvas edits across refreshes', async ({}, info) => {
  test.skip(!libraries || !platform, 'Set library source and installed platform roots.');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-library-e2e-')));
  const project = path.join(root, 'project');
  await mkdir(project);
  const dependencies: Record<string, string> = {};
  for (const folder of ['core-io', 'core-logic', 'core-loop', 'core-math', 'core-serial', 'core-text', 'core-time', 'core-variables', 'board-esp32s3']) {
    const source = folder.startsWith('board-') ? path.join(platform!, 'node_modules/@aily-project', folder) : path.join(libraries!, folder);
    const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    await cp(source, path.join(project, 'local-libraries', folder), { recursive: true, dereference: true });
    dependencies[pkg.name] = `file:local-libraries/${folder}`;
  }
  for (const name of ['b', 'c', 'd']) {
    const folder = path.join(project, 'local-libraries', name);
    await mkdir(folder);
    await writeFile(path.join(folder, 'package.json'), JSON.stringify({name: packageName(name), version: '1.0.0', nickname: `Save test ${name}`, description: 'Library save regression fixture'}));
    await writeFile(path.join(folder, 'block.json'), JSON.stringify([{type: `save_test_${name}`, message0: `Library ${name}`, previousStatement: null, nextStatement: null, colour: 180}]));
    await writeFile(path.join(folder, 'toolbox.json'), JSON.stringify({kind:'category',name:`Save test ${name}`,colour:180,contents:[{kind:'block',type:`save_test_${name}`}]}));
    const input = path.join(root, `archive-${name}`);
    await mkdir(input); await writeFile(path.join(input, 'Save.h'), `// ${name} source\n`);
    execFileSync(path.resolve('child/7zz'), ['a', '-t7z', path.join(folder, 'src.7z'), '.'], {cwd:input,stdio:'pipe'});
    await writeFile(path.join(folder, 'generator.js'), `Arduino.forBlock['save_test_${name}'] = function() { return '// library ${name}\\n'; };`);
  }
  dependencies[packageName('b')] = 'file:local-libraries/b';
  await writeFile(path.join(project, 'package.json'), JSON.stringify({name:'library-save-e2e',version:'1.0.0',nickname:'Library save acceptance',board:'ESP32S3',devmode:'arduino',dependencies},null,2));
  await writeFile(path.join(project, 'project.abi'), JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'arduino_global',id:'global',x:60,y:70},{type:'arduino_setup',id:'setup',x:60,y:180},{type:'arduino_loop',id:'loop',x:60,y:290}]}}));
  await runDependencyWorker(project, {save:true});
  await runDependencyWorker(project, {});
  const launched = await launchAilyElectron({environment:{AILY_E2E_TOOLCHAIN_SEED:process.env['AILY_E2E_TOOLCHAIN_SEED'] || platform!,AILY_E2E_TOOLCHAIN_PROJECT:project},config:{lang:'zh_CN',blocklyOnboardingCompleted:true,blockly:{autoSave:false,minimap:false}}});
  const win = await getMainWindow(launched.app);
  await win.addLocatorHandler(win.locator('app-login .login-close'), async button => { await button.click(); });
  const errors: string[] = [];
  win.on('pageerror', e => errors.push(e.message));
  const snapshots: any[] = [];
  const manifest = () => readFile(path.join(project,'package.json'),'utf8');
  const expectDirtyTitle = (dirty: boolean) => expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved', String(dirty));
  const installed = () => ['b','c','d'].filter(name => existsSync(path.join(project,'node_modules',packageName(name),'package.json')));
  const runtime = () => win.evaluate(() => {
    const w = window as any;
    const main = w.ng.getComponent(document.querySelector('blockly-main'));
    return {libraries:[...main.blocklyService.loadedLibraryInfos.values()].map((lib: any) => lib.packageName), blocks:w.Blockly.serialization.workspaces.save(w.blocklyWorkspace)};
  });
  const ready = () => expect.poll(async () => {
    try { return (await readAilyHostOperation(launched.app,'project_load_status',project)).ready; } catch { return false; }
  },{timeout:90000}).toBe(true);
  const saveProject = async () => {
    const result=await win.evaluate(async () => {const w=window as any;return w.ng.getComponent(document.querySelector('app-header')).projectService.save();});
    expect(result.success,JSON.stringify(result)).toBe(true);
  };
  const status = () => win.evaluate(project => (window as any).libraryDependencies.status(project),project);
  const recordUndo = async (step: string) => snapshots.push({step, history: await win.evaluate(() => {
    const w=window as any, view=(events:any[])=>events.map(e=>({type:e.type,group:e.group,blockId:e.blockId,recordUndo:e.recordUndo,ids:e.ids}));
    return {undo:view(w.blocklyWorkspace.getUndoStack()),redo:view(w.blocklyWorkspace.getRedoStack()),recordUndo:w.Blockly.Events.getRecordUndo()};
  })});
  const libraryIdle = () => expect.poll(() => win.evaluate(() => {
    const w=window as any, main=w.ng.getComponent(document.querySelector('blockly-main'));
    return !main.projectService.isLibraryMutationInProgress() && !main.blocklyService.isWorkspaceEditBlocked();
  })).toBe(true);
  const legacyPath = path.join(project, '.temp', 'package.json');
  let legacyContent: string | undefined;
  const record = async (step: string) => {
    const legacy = existsSync(legacyPath) ? await readFile(legacyPath, 'utf8') : undefined;
    expect(legacy).toBe(legacyContent);
    snapshots.push({step,installed:installed(),disk:JSON.parse(await manifest()),status:await status(),runtime:await runtime(),legacyPackage:legacy ?? null,title:await win.locator('app-header .project-box').innerText()});
  };
  const libraryUI = async () => {
    if (!await win.locator('app-lib-manager').count()) await win.locator('.toolbox-footer__button').click();
    await expect(win.locator('app-lib-manager')).toBeVisible();
    // Only supply an offline package catalog. The buttons, queue, IPC, npm and runtime are real.
    await win.evaluate(() => {
      const w=window as any,c=w.ng.getComponent(document.querySelector('app-lib-manager'));
      ++c.initialDataLoadToken;
      c.libraryList=['b','c','d'].map(name=>({name:`@aily-project/lib-save-${name}`,version:`file:local-libraries/${name}`,nickname:`Save test ${name}`,_nickname:`Save test ${name}`,description:'Library save fixture',_description:'Library save fixture',author:'E2E',icon:'',tested:true,state:w.fs.existsSync(w.path.join(c.projectService.currentProjectPath,'node_modules',`@aily-project/lib-save-${name}`,'package.json'))?'installed':'default'}));
      c._libraryList=c.libraryList;
      c.cd.detectChanges();
    });
  };
  const change = async (name: string, action: 'install'|'remove', canvasDirty = false) => {
    await libraryUI();
    const row = win.locator('app-lib-manager .lib-item').filter({hasText:`Save test ${name}`});
    await row.getByRole('button',{name:action==='install'?/安装|Install/:/移除|卸载|Remove/,exact:true}).click();
    await expect.poll(()=>win.evaluate(()=>!(window as any).ng.getComponent(document.querySelector('app-lib-manager')).isProcessingLibraryOperationQueue),{timeout:45000}).toBe(true);
    expect(installed().includes(name), await win.locator('body').innerText()).toBe(action==='install');
    const live=await runtime(); expect(live.libraries.includes(packageName(name))).toBe(action==='install');
    await expectDirtyTitle(canvasDirty);
    expect((await status()).dirty).toBe(false);
  };
  const removeFromToolbox = async (name: string) => {
    if (await win.locator('app-lib-manager').count()) await win.locator('app-lib-manager .header .btn').click();
    await win.locator('app-blockly-toolbox-pane .toolbox-item').filter({hasText:`Save test ${name}`}).click({button:'right'});
    await win.locator('app-menu.toolbox-context-menu .menu-item').filter({hasText:/^移除$/}).click();
    await expect.poll(() => win.evaluate(name => !(window as any).ng.getComponent(document.querySelector('app-blockly-toolbox-pane')).removingLibraryNames.has(name), packageName(name)), {timeout:45000}).toBe(true);
    expect(installed().includes(name)).toBe(false);
    await expectDirtyTitle(false);
    expect((await status()).dirty).toBe(false);
  };
  try {
    await openBlocklyProject(win,project); await ready(); await expectDirtyTitle(false);
    await writeFile(info.outputPath('initial-dom.txt'),await win.locator('body').innerText());
    const baselineAbi = await readFile(path.join(project, 'project.abi'), 'utf8');
    await change('b','remove');
    expect(JSON.parse(await manifest()).dependencies[packageName('b')]).toBeUndefined();
    await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('global').moveBy(40, 0));
    await expectDirtyTitle(true);
    for (const name of ['c','d']) {
      await change(name,'install',false);
      expect(existsSync(path.join(project,'node_modules',packageName(name),'src/Save.h'))).toBe(true);
      const disk=JSON.parse(await manifest());
      expect(disk.dependencies[packageName(name)]).toBeTruthy();
      expect(JSON.parse(await readFile(path.join(project,'package-lock.json'),'utf8')).packages[''].dependencies).toEqual(disk.dependencies);
      expect(await readFile(path.join(project,'project.abi'),'utf8')).not.toBe(baselineAbi);
      await record(`auto-install-${name}-canvas-retained`);
    }
    // Native Ctrl+Z restores one library transaction, retaining edits made before installation.
    const beforeUndo = await runtime();
    if(await win.locator('app-lib-manager').count())await win.locator('app-lib-manager .header .btn').click();
    await win.locator('blockly-main .blocklySvg').first().click({position:{x:500,y:400}});
    await win.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');
    await expect.poll(() => installed()).toEqual(['c']);
    await expect.poll(async () => (await runtime()).libraries.includes(packageName('d'))).toBe(false);
    await libraryIdle();
    expect((await runtime()).blocks).toEqual(beforeUndo.blocks);
    await expectDirtyTitle(false);
    await win.keyboard.press(process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z');
    await expect.poll(() => installed()).toEqual(['c','d']);
    await expect.poll(async () => (await runtime()).libraries.includes(packageName('d'))).toBe(true);
    await libraryIdle();
    await expectDirtyTitle(false);
    // Removing a library is a native undo step too. Undo it before undoing a
    // deleted block from that library, so Blockly can recreate its definition.
    await win.evaluate(() => {
      const w=window as any;w.Blockly.Events.setGroup(true);
      try {const block=w.blocklyWorkspace.newBlock('save_test_d','library-undo-block'); block.initSvg();block.render();}
      finally {w.Blockly.Events.setGroup(false);}
    });
    await expectDirtyTitle(true);
    await win.evaluate(() => {const w=window as any;w.Blockly.Events.setGroup(true);try{w.blocklyWorkspace.getBlockById('library-undo-block').dispose(true);}finally{w.Blockly.Events.setGroup(false);}});
    await recordUndo('before-remove-d');
    await change('d','remove');
    await recordUndo('after-remove-d');
    await win.evaluate(() => (window as any).blocklyWorkspace.undo(false));
    await expect.poll(() => installed()).toEqual(['c','d']);
    await expect.poll(async () => (await runtime()).libraries.includes(packageName('d'))).toBe(true);
    await libraryIdle();
    await recordUndo('after-undo-remove-d');
    await win.evaluate(() => (window as any).blocklyWorkspace.undo(false));
    await recordUndo('after-undo-delete-block');
    await expect.poll(() => win.evaluate(() => !!(window as any).blocklyWorkspace.getBlockById('library-undo-block'))).toBe(true);
    await win.evaluate(() => {const w=window as any;w.Blockly.Events.setGroup(true);try{w.blocklyWorkspace.getBlockById('library-undo-block').dispose(true);}finally{w.Blockly.Events.setGroup(false);}});
    await saveProject();
    await expectDirtyTitle(false);
    await removeFromToolbox('c');
    expect(JSON.parse(await manifest()).dependencies[packageName('c')]).toBeUndefined();
    await win.reload(); await ready();
    expect(installed()).toEqual(['d']); await expectDirtyTitle(false);
    await change('c','install');
    expect(installed()).toEqual(['c','d']);
    legacyContent = '{ obsolete package backup, deliberately invalid JSON';
    await writeFile(legacyPath, legacyContent);
    await win.reload(); await ready();
    expect(installed()).toEqual(['c','d']); await expectDirtyTitle(false);
    await change('b','install');
    await change('d','remove');
    await win.reload(); await ready();
    expect(installed()).toEqual(['b','c']); await expectDirtyTitle(false);
    await change('d','install');
    await removeFromToolbox('b');
    expect(JSON.parse(await manifest()).dependencies[packageName('b')]).toBeUndefined();
    await win.screenshot({path:info.outputPath('automatic-toolbox-removal.png')});
    await saveProject();
    await expect.poll(async () => (await status()).dirty).toBe(false); await expectDirtyTitle(false);
    expect(JSON.parse(await manifest()).dependencies[packageName('b')]).toBeUndefined();
    await win.reload(); await ready();
    expect(installed()).toEqual(['c','d']); await expectDirtyTitle(false); await record('toolbox-saved-removal-refresh');
    // Exercise the real Blockly model/event and save paths for ordinary local edits as well.
    await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('global').moveBy(40, 0));
    await expectDirtyTitle(true); await record('unsaved-canvas-edit');
    await win.screenshot({path:info.outputPath('unsaved-canvas-title.png')});
    await win.evaluate(() => (window as any).blocklyWorkspace.undo(false));
    await expectDirtyTitle(false);
    await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('global').moveBy(40, 0));
    await expectDirtyTitle(true);
    await saveProject();
    await expectDirtyTitle(false); await record('saved-canvas-edit');
    if (process.env['AILY_E2E_AGENT_ROOT']) {
      // Leave a native user edit unsaved before the actual Agent tool starts.
      await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('global').moveBy(55, 0));
      await expectDirtyTitle(true);
      const userCanvas = (await runtime()).blocks;
      const agentReport = info.outputPath('agent-library-history.json');
      const child = spawn(path.resolve('child/node/bin/node'), [path.resolve('e2e/fixtures/library-agent-history.mjs'),
        process.env['AILY_E2E_AGENT_ROOT']!,project,path.join(root,'agent-profile'),agentReport], {env:{...process.env,AILY_APPDATA_PATH:launched.userDataDir}});
      let output = ''; child.stdout.on('data', data => { output += data; });child.stderr.on('data',data=>{output+=data;});
      const exit = await new Promise(resolve => child.on('close',resolve));
      expect(exit,output).toBe(0);
      await ready();
      const report = JSON.parse(await readFile(agentReport,'utf8'));
      expect(report.error).toBeUndefined();
      expect(report.undo.dependencies[packageName('c')]).toBeTruthy();
      expect(report.redo.dependencies[packageName('c')]).toBeUndefined();
      for(const state of ['undo','redo','installUndo','installRedo'])expect(report[state].abi.pages[0].content).toEqual(userCanvas);
      expect(report.installUndo.dependencies[packageName('b')]).toBeUndefined();
      expect(report.installRedo.dependencies[packageName('b')]).toBeTruthy();
      expect((await runtime()).blocks).toEqual(userCanvas);
      expect(installed()).toEqual(['b','d']);
      await expectDirtyTitle(false);
      await record('agent-remove-undo-redo-preserves-user-edit');
    }
    expect(errors.filter(e=>/library|generator|circular dependency/i.test(e))).toEqual([]);
  } finally {
    await writeFile(info.outputPath('evidence.json'),JSON.stringify({root,project,snapshots,errors,body:await win.locator('body').innerText()},null,2));
    await win.screenshot({path:info.outputPath('final.png')}).catch(()=>{});
    await launched.close();
  }
});
