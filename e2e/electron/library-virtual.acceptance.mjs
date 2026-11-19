import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { _electron } from 'playwright';
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs';

// Real native Electron, real catalog and a copied test project. No library API mocks.
const root = process.cwd();
const output = path.resolve(process.env.AILY_LIBRARY_OUTPUT || 'e2e/test-results/library-virtual/native');
const seed = process.env.AILY_LIBRARY_APPDATA_SEED;
const projectSeed = process.env.AILY_LIBRARY_PROJECT_SEED;
assert.ok(seed && projectSeed, 'Provide isolated test appdata and project seeds');
await fs.mkdir(output, { recursive: true });
const suite = await fs.mkdtemp(path.join(output, 'run-'));
const appdata = path.join(suite, 'appdata'), project = path.join(suite, 'project');
await fs.mkdir(appdata);
for (const name of await fs.readdir(seed)) {
  if (['auth', 'logs', 'window-state.json'].includes(name)) continue;
  const source = path.join(seed, name), stat = await fs.stat(source);
  if (stat.isFile()) await fs.copyFile(source, path.join(appdata, name));
  else if (['sdk','tools','npm-global','node_modules'].includes(name))
    await fs.symlink(source, path.join(appdata, name), process.platform === 'win32' ? 'junction' : 'dir');
}
await fs.cp(projectSeed, project, { recursive: true, filter: file => !/[\\/](\.aily|\.build|\.git)([\\/]|$)/.test(file) });
const config = JSON.parse(await fs.readFile(path.join(appdata, 'config.json'), 'utf8'));
Object.assign(config, { lang:'zh_CN', project_path: suite, blocklyOnboardingCompleted: true });
await fs.writeFile(path.join(appdata, 'config.json'), JSON.stringify(config));
const renderer = await serveRendererBuild(path.resolve(process.env.AILY_LIBRARY_BUILD || 'e2e/test-results/library-virtual/build/browser'));
const evidence = { platform: process.platform, arch: process.arch, suite, project, cases: [], errors: [], sourceHashes: {} };
for (const ext of ['ts','html','scss']) {
  const file = `src/app/editors/blockly-editor/components/lib-manager/lib-manager.component.${ext}`;
  evidence.sourceHashes[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
}
let app, page;
const record = (name, data = {}) => { evidence.cases.push({ name, ...data }); console.log(name, JSON.stringify(data)); };
const manager = () => page.locator('app-lib-manager').last();
const read = () => manager().evaluate(el => {
  const c = window.ng.getComponent(el), list = el.querySelector('.lib-list'), box = list.getBoundingClientRect();
  const cards = [...el.querySelectorAll('.lib-item')];
  return { viewport: [innerWidth,innerHeight], total: c.libraryList.length, columns: c.columnCount?.(), dom: cards.length,
    descendants: list.querySelectorAll('*').length, scrollTop: list.scrollTop, width: list.clientWidth, height: list.clientHeight,
    scrollWidth: list.scrollWidth, scrollHeight: list.scrollHeight, keyword: c.keyword,
    first: cards[0]?.querySelector('.nickname')?.textContent, last: cards.at(-1)?.querySelector('.nickname')?.textContent,
    tail: c.libraryList.at(-1)?._nickname, names: cards.map(card => card.querySelector('.nickname')?.textContent),
    overflow: cards.some(card => { const r = card.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1; }),
    actionsClipped: [...el.querySelectorAll('.header .btns button')].some(button => { const r=button.getBoundingClientRect(), h=el.querySelector('.header').getBoundingClientRect(); return r.left<h.left || r.right>h.right+1 || r.bottom>h.bottom+1; }),
    clippedFooters: cards.some(card => card.querySelector('.footer').getBoundingClientRect().bottom > card.getBoundingClientRect().bottom + 1) };
});
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function sampleScroll() {
  return manager().locator('.lib-list').evaluate(async el => {
    const deltas = []; let previous = performance.now();
    for (let frame=0; frame<90; frame++) {
      el.scrollTop = (el.scrollHeight-el.clientHeight) * (frame / 89);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const now = performance.now(); deltas.push(now-previous); previous=now;
    }
    deltas.sort((a,b)=>a-b);
    return {frames:deltas.length,medianMs:deltas[45],p95Ms:deltas[85],maxMs:deltas.at(-1),framesOver50Ms:deltas.filter(ms=>ms>50).length};
  });
}
async function resize(width, height, zoom = 1) {
  const nativeWindow = await app.browserWindow(page);
  await nativeWindow.evaluate((w, size) => { w.unmaximize(); w.setMinimumSize(0,0); w.setContentSize(size.width,size.height); w.webContents.setZoomFactor(size.zoom); }, {width,height,zoom});
  await page.waitForFunction(size => Math.abs(innerWidth-size.width/size.zoom)<2,{width,height,zoom});
  await settle();
}
async function search(value) {
  await manager().locator('input').fill(value);
  await page.waitForTimeout(600);
  await settle();
}
async function scroll(fraction) {
  await manager().locator('.lib-list').evaluate((el, f) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * f; }, fraction);
  await settle();
}
try {
  const { ELECTRON_RUN_AS_NODE, NODE_PATH, NODE_OPTIONS, AILY_CHILD_PATH, ...env } = process.env;
  app = await _electron.launch({ cwd: root, args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'profile')}`],
    env: { ...env, AILY_E2E: '1', AILY_BUILD_PRODUCT: 'blockly', AILY_APPDATA_PATH: appdata,
      AILY_NPM_PREFIX: path.join(appdata,'npm-global'), AILY_DEV_RENDERER_URL: renderer.origin }, timeout: 60000 });
  await app.firstWindow();
  const deadline = Date.now() + 60000;
  while (!page && Date.now() < deadline) {
    page = app.windows().find(p => p.url().startsWith(renderer.origin));
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Main renderer window opened');
  console.log('Main renderer:',page.url());
  page.on('pageerror', error => evidence.errors.push(String(error)));
  page.on('console', message => { if(message.type()==='error') console.log('Renderer error:',message.text().slice(0,500)); });
  await page.locator('app-main-window').waitFor({timeout:60000});
  await page.evaluate(project => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(project); }, project);
  await page.getByRole('button', {name:'库管理',exact:true}).waitFor({timeout:90000});
  await page.waitForFunction(target => { const el = document.querySelector('app-blockly-editor'); const c = el && window.ng?.getComponent(el); return c?.projectService?.getBlocklyProjectLoadStatus(target)?.ready === true; }, project, {timeout:90000});
  await page.getByRole('button', {name:'库管理',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('app-lib-manager') && window.ng?.getComponent(document.querySelector('app-lib-manager'))?.libraryList.length > 50, undefined, {timeout:30000});
  await page.waitForTimeout(1200);
  const catalogTotal=(await read()).total;
  evidence.electron = await app.evaluate(() => process.versions);
  if (process.env.AILY_LIBRARY_BASELINE) {
    await resize(1280,800); record('baseline',await read()); record('scroll-sample',await sampleScroll());
    await page.screenshot({path:path.join(suite,'baseline.png')});
  } else {
  for (const [width,height,columns] of [[1440,840,3],[1280,800,3],[1024,768,2],[800,600,2],[640,480,1]]) {
    await resize(width,height);
    for (const fraction of [0,0.5,1]) {
      await scroll(fraction);
      const state = await read();
      assert.equal(state.columns,columns,JSON.stringify(state));
      assert.ok(state.dom > 0 && state.dom <= (Math.ceil(state.height/175)+6) * state.columns, JSON.stringify(state));
      assert.ok(!state.overflow && !state.clippedFooters && !state.actionsClipped && state.scrollWidth <= state.width + 1, JSON.stringify(state));
      if (fraction === 1) assert.ok(state.names.includes(state.tail), 'Last library reachable');
      record(`grid-${width}x${height}-${fraction}`, state);
      if(fraction===0) await page.screenshot({path:path.join(suite,`grid-${width}x${height}-top.png`)});
    }
    await page.screenshot({path:path.join(suite,`grid-${width}x${height}.png`)});
  }
  await resize(1280,800);
  await scroll(1); await search('zzzz_nonexistent_library_12345');
  let state = await read(); assert.equal(state.total,0); assert.equal(state.dom,0); record('empty-search-at-bottom',state);
  await search('DHT'); state = await read(); assert.ok(state.total>0 && state.dom>0); assert.equal(state.scrollTop,0); record('search-recover',state);
  for (const label of ['已安装','核心库','所有']) {
    await manager().getByRole('button',{name:label,exact:true}).click(); await page.waitForTimeout(600);
    state=await read(); assert.ok(state.total>0 && state.dom>0); assert.equal(state.scrollTop,0); record(`filter-${label}`,state);
  }
  await manager().locator('.tag-list nz-tag').nth(1).click(); await page.waitForTimeout(600);
  state=await read(); assert.ok(state.total>0); record('category-filter',state);
  await search('');
  // Scroll deep, then repeatedly change the grid column count without blanking.
  await scroll(0.5);
  for (const [width,height] of [[800,600],[1440,840],[640,480],[1280,800]]) {
    await resize(width,height); state=await read(); assert.ok(state.dom>0); record(`resize-in-middle-${width}`,state);
  }
  await resize(1280,800,1.5); await scroll(1); state=await read(); assert.ok(state.dom>0&&!state.overflow); record('zoom-150',state);
  await page.screenshot({path:path.join(suite,'zoom-150.png')});
  await resize(1280,800);
  record('scroll-sample',await sampleScroll());
  // Install/remove through actual buttons, then recycle the card between reads.
  await search('ArduinoJson');
  const jsonCard = manager().locator('.lib-item').filter({has:page.getByText('ArduinoJson',{exact:true})});
  await jsonCard.getByRole('button',{name:'安装',exact:true}).click();
  await jsonCard.getByRole('button',{name:'移除',exact:true}).waitFor({timeout:120000});
  assert.ok(JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8')).dependencies['@aily-project/lib-arduinojson']);
  record('real-install-arduinojson');
  await search(''); await scroll(1); await search('ArduinoJson');
  await jsonCard.getByRole('button',{name:'移除',exact:true}).waitFor();
  record('installed-state-after-card-recycle');
  await jsonCard.getByRole('button',{name:'移除',exact:true}).click();
  await jsonCard.getByRole('button',{name:'安装',exact:true}).waitFor({timeout:120000});
  assert.ok(!JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8')).dependencies['@aily-project/lib-arduinojson']);
  record('real-remove-arduinojson'); await search('');
  // Exercise the actual shared side-panel entry, rather than toggling the input.
  await manager().locator('.header .btn').click();
  await page.evaluate(() => window.ng.getComponent(document.querySelector('app-main-window')).uiService.openTool('lib-manager'));
  await manager().locator('.lib-manager-box--panel').waitFor();
  await page.waitForFunction(total => { const el=document.querySelector('app-lib-manager'); return el && window.ng.getComponent(el).libraryList.length===total; },catalogTotal);
  await page.waitForTimeout(300);
  for (const width of [400,560,800]) {
    await page.evaluate(width => { const main=window.ng.getComponent(document.querySelector('app-main-window')); main.onSideResize({width}); window.ng.applyChanges(main); },width);
    await settle(); await scroll(1); state=await read();
    assert.ok(await manager().evaluate(el => el.querySelector('.lib-item').getBoundingClientRect().width >= el.querySelector('.lib-list').clientWidth - 17), 'Panel card fills the available width');
    assert.ok(Math.abs(state.width-width)<15); assert.equal(state.columns,1); assert.ok(state.dom>0&&!state.overflow&&!state.clippedFooters&&!state.actionsClipped); assert.ok(state.names.includes(state.tail)); record(`panel-${width}`,state);
    await scroll(0); await page.screenshot({path:path.join(suite,`panel-${width}.png`)});
    assert.ok(await manager().evaluate(el => el.getBoundingClientRect().top >= el.closest('app-tool-container').querySelector('.header').getBoundingClientRect().bottom), 'Panel title remains visible');
  }
  assert.ok(!evidence.errors.some(error => /LibManager|lib-manager|ExpressionChanged|TypeError/.test(error)), JSON.stringify(evidence.errors));
  }
  evidence.ok=true;
} catch(error) { evidence.failure=String(error.stack); if(page) await page.screenshot({path:path.join(suite,'failure.png')}).catch(()=>{}); throw error; }
finally {
  await fs.writeFile(path.join(suite,'results.json'),JSON.stringify(evidence,null,2));
  console.log('Evidence:',suite);
  if(app) await app.close();
  await renderer.close();
}
