'use strict';
// Real Electron windows with a disposable profile, no account, UART or feedback submission.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'e2e/.results/serial-issues');
const build = path.resolve(process.env.AILY_SERIAL_ISSUES_BUILD || path.join(root, 'e2e/.results/serial-issues-build/browser'));
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
const bootstrap = path.join(profile, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const {app}=require('electron'); const fs=require('node:fs'); const path=require('node:path');
const root=${JSON.stringify(root)}, profile=__dirname;
app.setPath('userData',path.join(profile,'chromium')); app.setPath('sessionData',path.join(profile,'session'));
app.setPath('documents',profile); app.setAsDefaultProtocolClient=app.removeAsDefaultProtocolClient=()=>false;
app.setUserTasks=()=>false; app.setAppUserModelId=()=>{};
process.env.AILY_E2E='1'; process.env.AILY_APPDATA_PATH=path.join(profile,'data');
process.env.AILY_APP_VERSION=require(path.join(root,'package.json')).version;
process.env.USERPROFILE=profile; process.env.PI_CODING_AGENT_DIR=path.join(profile,'agent');
fs.mkdirSync(process.env.AILY_APPDATA_PATH,{recursive:true});
const config=JSON.parse(fs.readFileSync(path.join(root,'electron/config/config.json')));
config.onboardingCompleted=true; config.project_path=path.join(profile,'projects'); config.metricsEnabled=false;
fs.writeFileSync(path.join(process.env.AILY_APPDATA_PATH,'config.json'),JSON.stringify(config));
// Override only the fixture's asset location; production IPC/window code is unchanged.
const renderer=require(path.join(root,'electron/packaged-renderer-server'));
const create=renderer.createPackagedRendererServer;
renderer.createPackagedRendererServer=(options)=>{const server=create(options);return {...server,start:(options)=>server.start({...options,rootDirectory:${JSON.stringify(build)}})};};
require(path.join(root,'electron/main.js'));
`);

async function main() {
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  let app;
  const requests = [], errors = [];
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap], cwd: root, env, timeout: 60000 });
    const log = fs.createWriteStream(path.join(output, 'electron.log'));
    app.process().stdout?.pipe(log, { end: false }); app.process().stderr?.pipe(log, { end: false });
    const observe = page => { page.on('pageerror', error => errors.push(error.message)); };
    app.context().on('page', observe); app.windows().forEach(observe);
    await app.context().route('**/*', route => {
      const request = route.request();
      if (/^https?:/.test(request.url()) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(request.url())) {
        if (request.method() !== 'GET') requests.push({ method: request.method(), host: new URL(request.url()).host });
        return route.abort();
      }
      return route.continue();
    });
    let mainPage;
    await expect.poll(async () => {
      for (const page of app.windows()) if (await page.locator('app-main-window app-header').count().catch(() => 0)) { mainPage = page; return true; }
      return false;
    }, { timeout: 60000 }).toBe(true);
    const dismiss = mainPage.getByText('稍后登录', {exact:true});
    if (await dismiss.count()) await dismiss.click();
    await expect.poll(() => mainPage.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).uiService.openFeedback.toString().includes('Aily Feedback'))).toBe(true);
    await mainPage.evaluate(() => {
      const header = window.ng.getComponent(document.querySelector('app-header'));
      header.serialService.currentPort = 'COM999'; // metadata only, never opens a port
      header.uiService.openFeedback({ feedbackType: 'bug' });
    });
    let feedback;
    await expect.poll(async () => {
      for (const page of app.windows()) if (await page.locator('app-feedback-dialog.standalone').count().catch(() => 0)) { feedback = page; return true; }
      return false;
    }, { timeout: 30000 }).toBe(true);
    await expect.poll(() => feedback.evaluate(() => {
      const c = window.ng.getComponent(document.querySelector('app-feedback-dialog'));
      return { loading: c.contextLoading, error: c.contextError, port: c.hostContext?.serialPort };
    })).toEqual({ loading: false, error: '', port: 'COM999' });
    const native = await app.browserWindow(feedback);
    assert.equal(await native.evaluate(win => win.isModal()), false);
    await feedback.locator('input.form-control').first().fill('独立反馈窗验收');
    await feedback.locator('textarea').fill('保留草稿，并能返回主窗口继续操作。');
    await mainPage.evaluate(async () => {
      const header = window.ng.getComponent(document.querySelector('app-header'));
      await header.router.navigate(['/main/project-new']);
      header.uiService.openFeedback();
    });
    await expect(feedback.locator('input.form-control').first()).toHaveValue('独立反馈窗验收');
    assert.equal((await Promise.all(app.windows().map(page => page.locator('app-feedback-dialog').count().catch(() => 0)))).reduce((a,b) => a+b,0), 1);
    assert.equal(await mainPage.locator('.ant-modal-wrap:visible').count(), 0);
    await feedback.screenshot({ path: path.join(output, 'feedback-window.png') });
    await feedback.evaluate(() => window.iWindow.minimize());
    await expect.poll(() => native.evaluate(win => win.isMinimized())).toBe(true);
    await mainPage.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).uiService.openFeedback());
    await expect.poll(() => native.evaluate(win => win.isMinimized())).toBe(false);
    await feedback.evaluate(() => window.ng.getComponent(document.querySelector('app-feedback-dialog')).onCloseDialog());
    await expect.poll(() => feedback.isClosed()).toBe(true);
    await mainPage.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).uiService.openFeedback());
    await expect.poll(async () => {
      for (const page of app.windows()) if (await page.locator('app-feedback-dialog.standalone').count().catch(() => 0)) { feedback = page; return true; }
      return false;
    }, { timeout: 30000 }).toBe(true);
    await expect(feedback.locator('textarea')).toHaveValue('保留草稿，并能返回主窗口继续操作。');
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 0, 'No external submission is expected');
    const result = { passed: true, checks: ['real independent nonmodal feedback window', 'host serial metadata through real IPC',
      'main window remains usable', 'reuse/focus/minimize', 'draft survives closing and reopening', 'no external POST'] };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ errors, pages: app ? await Promise.all(app.windows().map(async page => ({ url: page.url(), text: await page.locator('body').innerText().catch(() => '') }))) : [] }));
    throw error;
  } finally {
    if (app) await app.evaluate(({app}) => app.quit()).catch(() => undefined);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
