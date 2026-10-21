import { cp, mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

const libraries = process.env['AILY_E2E_LIBRARIES'];
const platform = process.env['AILY_E2E_PLATFORM_SEED'];
const agentRoot = process.env['AILY_E2E_AGENT_ROOT'];
const { runDependencyWorker } = require('../../electron/library-dependencies');
const packageName = (name: string) => `@aily-project/lib-save-${name}`;

test('immediate libraries, explicit manifest save, discard reload and real Chat history restore', async ({}, info) => {
  test.skip(!libraries || !platform || !agentRoot, 'Set library source, installed platform and agent roots.');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-library-e2e-')));
  const project = path.join(root, 'project');
  await mkdir(project);
  const dependencies: Record<string, string> = {};
  for (const folder of ['core-io', 'core-logic', 'core-loop', 'core-math', 'core-serial', 'core-text', 'core-time', 'core-variables', 'board-arduino_uno']) {
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
    await writeFile(path.join(folder, 'generator.js'), `Arduino.forBlock['save_test_${name}'] = function() { return '// library ${name}\\n'; };`);
  }
  dependencies[packageName('b')] = 'file:local-libraries/b';
  await writeFile(path.join(project, 'package.json'), JSON.stringify({name:'library-save-e2e',version:'1.0.0',nickname:'Library save acceptance',board:'Arduino UNO R3',devmode:'arduino',dependencies},null,2));
  await writeFile(path.join(project, 'project.abi'), JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'arduino_global',id:'global',x:60,y:70},{type:'arduino_setup',id:'setup',x:60,y:180},{type:'arduino_loop',id:'loop',x:60,y:290}]}}));
  await runDependencyWorker(project, {save:true});
  await runDependencyWorker(project, {});
  const launched = await launchAilyElectron({environment:{AILY_E2E_TOOLCHAIN_SEED:process.env['AILY_E2E_TOOLCHAIN_SEED'] || platform!},config:{lang:'zh_CN',blocklyOnboardingCompleted:true,blockly:{autoSave:false,minimap:false}}});
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
  const status = () => win.evaluate(project => (window as any).libraryDependencies.status(project),project);
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
      c.libraryList=['b','c','d'].map(name=>({name:`@aily-project/lib-save-${name}`,version:`file:local-libraries/${name}`,nickname:`Save test ${name}`,_nickname:`Save test ${name}`,description:'Library save fixture',_description:'Library save fixture',author:'E2E',icon:'',tested:true,state:w.fs.existsSync(w.path.join(c.projectService.currentProjectPath,'node_modules',`@aily-project/lib-save-${name}`,'package.json'))?'installed':'default'}));
      c.cd.detectChanges();
    });
  };
  const change = async (name: string, action: 'install'|'remove') => {
    await libraryUI();
    const row = win.locator('app-lib-manager .lib-item').filter({hasText:`Save test ${name}`});
    await row.getByRole('button',{name:action==='install'?/安装|Install/:/移除|卸载|Remove/,exact:true}).click();
    await expect.poll(()=>win.evaluate(()=>!(window as any).ng.getComponent(document.querySelector('app-lib-manager')).isProcessingLibraryOperationQueue),{timeout:45000}).toBe(true);
    expect(installed().includes(name)).toBe(action==='install');
    const live=await runtime(); expect(live.libraries.includes(packageName(name))).toBe(action==='install');
    await expectDirtyTitle(true);
  };
  const removeFromToolbox = async (name: string) => {
    if (await win.locator('app-lib-manager').count()) await win.locator('app-lib-manager .header .btn').click();
    await win.locator('app-blockly-toolbox-pane .toolbox-item').filter({hasText:`Save test ${name}`}).click({button:'right'});
    await win.locator('app-menu.toolbox-context-menu .menu-item').filter({hasText:/^移除$/}).click();
    await expect.poll(() => win.evaluate(name => !(window as any).ng.getComponent(document.querySelector('app-blockly-toolbox-pane')).removingLibraryNames.has(name), packageName(name)), {timeout:45000}).toBe(true);
    expect(installed().includes(name)).toBe(false);
    await expectDirtyTitle(true);
  };
  try {
    await openBlocklyProject(win,project); await ready(); await expectDirtyTitle(false);
    await writeFile(info.outputPath('initial-dom.txt'),await win.locator('body').innerText());
    const baseline=await manifest(), baselineLock=await readFile(path.join(project,'package-lock.json'),'utf8');
    const canvas=JSON.stringify((await runtime()).blocks);
    for(const [name,action] of [['b','remove'],['c','install'],['d','install']] as const){
      await change(name,action); expect(await manifest()).toBe(baseline); expect(await readFile(path.join(project,'package-lock.json'),'utf8')).toBe(baselineLock); await record(`${action}-${name}`);
    }
    expect(installed()).toEqual(['c','d']); expect(JSON.stringify((await runtime()).blocks)).toBe(canvas);
    expect((await status()).dirty).toBe(true);
    const agentModule = (file: string) => import(pathToFileURL(path.join(agentRoot!, 'packages/aily-agent/dist', file)).href);
    const handlers = new Map<string, Function>();
    const context = { registry: { register: (name: string, schema: any, handler: Function) => handlers.set(name, handler) }, workspaceHistory: {} };
    (await agentModule('blockly/tools/registrars/library/lib-add.js')).registerLibAdd(context);
    (await agentModule('blockly/tools/registrars/library/lib-remove.js')).registerLibRemove(context);
    for (const tool of ['lib_add', 'lib_remove']) {
      const result = await handlers.get(tool)!({ project, packages: [packageName('c')] });
      expect(JSON.stringify(result)).toContain('LIBRARY_CHANGES_UNSAVED');
      expect(await manifest()).toBe(baseline);
    }
    await win.screenshot({path:info.outputPath('unsaved-installations.png')});
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect.poll(async () => (await status()).dirty, {timeout:30000}).toBe(false);
    expect(Object.keys(JSON.parse(await manifest()).dependencies).filter(name=>name.includes('/lib-save-')).sort()).toEqual([packageName('c'),packageName('d')]);
    const saved=await manifest(); await expectDirtyTitle(false); await record('saved');
    await removeFromToolbox('c');
    await record('toolbox-uninstall-without-save');
    expect(await manifest()).toBe(saved);
    await win.reload(); await ready();
    expect(installed()).toEqual(['c','d']); await expectDirtyTitle(false); await record('toolbox-unsaved-refresh');
    // Old installations may leave a damaged backup. It must never be read or rewritten.
    legacyContent = '{ obsolete package backup, deliberately invalid JSON';
    await writeFile(legacyPath, legacyContent);
    await change('c','remove'); await change('b','install'); expect(await manifest()).toBe(saved);
    // A renderer refresh destroys the UI memory; the main process must still recover dependencies.
    await win.reload(); await ready();
    expect(await manifest()).toBe(saved); expect(installed()).toEqual(['c','d']); expect((await status()).dirty).toBe(false); await expectDirtyTitle(false); await record('unsaved-renderer-refresh');
    // Exercise explicit discard through the actual unsaved dialog.
    await change('d','remove');
    await win.evaluate(()=>{const w=window as any;w.discardDecision=w.ng.getComponent(document.querySelector('app-header')).checkUnsavedChanges('open');});
    await expect(win.locator('app-unsave-dialog')).toBeVisible();
    await writeFile(info.outputPath('discard-dialog.txt'),await win.locator('app-unsave-dialog').innerText());
    await win.locator('app-unsave-dialog').getByRole('button',{name:'跳过保存',exact:true}).click();
    expect(await win.evaluate(()=>(window as any).discardDecision)).toBe(true);
    expect(await manifest()).toBe(saved); expect(installed()).toEqual(['c','d']); await expectDirtyTitle(false); await record('explicit-discard');
    // Real Aily Chat history engine: same external transaction API used by lib_add/lib_remove.
    const {WorkspaceHistoryEngine}=await import(pathToFileURL(path.join(agentRoot!,'packages/aily-agent/dist/extensions/pi-workspace-history/history-engine.js')).href);
    const {synchronizeBlocklyWorkspaceHistory}=await agentModule('blockly/workspace-history-sync.js');
    const history=new WorkspaceHistoryEngine(project,path.join(root,'history'));
    await history.begin('library-save-chat','turn-0',0,process.pid); await history.prepareExternalMutation('turn-0');
    await runDependencyWorker(project,{save:true,add:[`${packageName('b')}@file:local-libraries/b`]});
    await runDependencyWorker(project,{});
    await history.captureExternalMutation('turn-0'); const finalized=await history.finalize('turn-0'); expect(finalized.commitId).toBeTruthy();
    const chatVersion=await manifest();
    await readAilyHostOperation(launched.app,'project_reload',project,{},90000); await ready(); expect(installed()).toEqual(['b','c','d']);
    // A pending manual removal must not overwrite the version restored by Chat.
    await change('d','remove');
    await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('global').moveBy(55, 0));
    await expectDirtyTitle(true);
    await history.revertTurn('library-save-chat',0);
    await synchronizeBlocklyWorkspaceHistory({workspaceRoot:project,operation:'turn-revert',changedPaths:['package.json']}); await ready();
    expect(await manifest()).toBe(saved); expect(installed()).toEqual(['c','d']); expect((await status()).dirty).toBe(false); await expectDirtyTitle(false); await record('chat-reverted-with-pending-manual-change');
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('global').getRelativeToSurfaceXY().x)).toBe(60);
    await history.reapplyTurn('library-save-chat',0);
    const reappliedVersion = await manifest();
    expect(JSON.parse(reappliedVersion)).toEqual(JSON.parse(chatVersion));
    await synchronizeBlocklyWorkspaceHistory({workspaceRoot:project,operation:'turn-reapply',changedPaths:['package.json']}); await ready();
    expect(await manifest()).toBe(reappliedVersion); expect(installed()).toEqual(['b','c','d']); await expectDirtyTitle(false); await record('chat-reapplied');
    await win.screenshot({path:info.outputPath('chat-restored.png')});
    await expectDirtyTitle(false);
    await removeFromToolbox('b');
    expect(await manifest()).toBe(reappliedVersion);
    await win.screenshot({path:info.outputPath('unsaved-toolbox-removal.png')});
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
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
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expectDirtyTitle(false); await record('saved-canvas-edit');
    expect(errors.filter(e=>/library|generator|circular dependency/i.test(e))).toEqual([]);
  } finally {
    await writeFile(info.outputPath('evidence.json'),JSON.stringify({root,project,snapshots,errors},null,2));
    await win.screenshot({path:info.outputPath('final.png')}).catch(()=>{});
    await launched.close();
  }
});
